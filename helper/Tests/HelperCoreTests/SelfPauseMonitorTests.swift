import CoreAudio
import Foundation
import Testing
@testable import HelperCore

private let app = "com.google.Chrome"
private let ownPID: Int32 = 100
private let using = [InputProcess(bundleID: app, pid: 200, isRunningInput: true)]
private let idle = [InputProcess(bundleID: app, pid: 200, isRunningInput: false)]

private func hostTime(seconds: Double) -> UInt64 {
    AudioConvertNanosToHostTime(UInt64(seconds * 1_000_000_000))
}

private struct WaitTimeout: Error, CustomStringConvertible {
    let condition: String
    var description: String { "期限内に成り立たなかった: \(condition)" }
}

private func waitUntil(
    _ condition: String, timeout: Duration = .seconds(5),
    _ predicate: () -> Bool
) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while !predicate() {
        if clock.now >= deadline { throw WaitTimeout(condition: condition) }
        try await Task.sleep(for: .milliseconds(1))
    }
}

private final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
    func update(_ body: (inout Value) -> Void) { lock.withLock { body(&stored) } }
}

private final class Harness: @unchecked Sendable {
    let origin = hostTime(seconds: 100)
    let processes = Box<[InputProcess]?>(idle)
    let clock = Box<Double>(0)
    let reads = Box<Int>(0)
    let sleepCalls = Box<Int>(0)
    let sleepDurations = Box<[Duration]>([])
    let handled = Box<Int>(0)
    let sent = Box<Int>(0)
    let sentReads = Box<Int>(0)
    let events = Box<[HelperEvent]>([])
    let gate = Box<[(paused: Bool, hostTime: UInt64)]>([])
    private let wake: AsyncStream<Void>
    private let waker: AsyncStream<Void>.Continuation
    var monitor: SelfPauseMonitor!
    var task: Task<Void, Never>?

    init(restoring: SelfPauseCarryOver = .initial) {
        let (stream, continuation) = AsyncStream<Void>.makeStream()
        wake = stream
        waker = continuation
        let rule = SelfPauseRule(app: app, ownPID: ownPID, restoring: restoring)
        monitor = SelfPauseMonitor(
            rule: rule,
            origin: origin,
            readProcesses: { [self] in
                let value = processes.value
                reads.update { $0 += 1 }
                return value
            },
            sleep: { [self] duration in
                sleepCalls.update { $0 += 1 }
                sleepDurations.update { $0.append(duration) }
                for await _ in wake { return }
                throw CancellationError()
            },
            now: { [self] in
                let time = origin + hostTime(seconds: clock.value)
                handled.update { $0 += 1 }
                return time
            },
            requestGate: { [self] paused, time in gate.update { $0.append((paused, time)) } },
            emit: { [self] event in events.update { $0.append(event) } }
        )
    }

    func start() async throws {
        sent.update { $0 += 1 }
        sentReads.update { $0 += 1 }
        task = monitor.start()
        try await waitHandled()
    }

    func tick(_ seconds: Double = 0.5) async throws {
        clock.update { $0 += seconds }
        sent.update { $0 += 1 }
        sentReads.update { $0 += 1 }
        waker.yield()
        try await waitHandled()
    }

    func send(reads: Bool = false, _ input: () -> Void) async throws {
        sent.update { $0 += 1 }
        if reads { sentReads.update { $0 += 1 } }
        input()
        try await waitHandled()
    }

    func waitHandled(timeout: Duration = .seconds(5)) async throws {
        try await waitUntil(
            "送った入力 \(sent.value) 件の処理の開始と、読み直し \(sentReads.value) 回（実際は \(handled.value) 件・\(reads.value) 回）",
            timeout: timeout
        ) { handled.value >= sent.value && reads.value >= sentReads.value }
    }

    func idleBriefly() async {
        for _ in 0..<50 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(20))
    }

    var pauses: [(paused: Bool, reason: SelfPauseReason, start: Double)] {
        events.value.compactMap {
            if case let .selfPause(state, start) = $0 { return (state.paused, state.reason, start) }
            return nil
        }
    }

    var states: [SelfPauseCarryOver] { reports.map(\.state) }

    var reports: [(state: SelfPauseCarryOver, handled: SelfPauseSeq)] {
        events.value.compactMap {
            if case let .selfPauseState(state, handled) = $0 { return (state, handled) }
            return nil
        }
    }
}

private func matches(
    _ actual: [(paused: Bool, reason: SelfPauseReason, start: Double)],
    _ expected: [(paused: Bool, reason: SelfPauseReason, start: Double)]
) -> Bool {
    actual.count == expected.count
        && zip(actual, expected).allSatisfy { $0.paused == $1.paused && $0.reason == $1.reason && abs($0.start - $1.start) < 0.001 }
}

@Suite("自分の休止の監視")
struct SelfPauseMonitorTests {
    @Test("始めに 1 回読み、0.5 秒ごとに読み直す。読み直しの回数はポーリングの回数と一致する")
    func readsOnStartThenEveryHalfSecond() async throws {
        let harness = Harness()
        try await harness.start()
        #expect(harness.reads.value == 1)
        for _ in 0..<4 { try await harness.tick() }
        #expect(harness.reads.value == 5)
        #expect(harness.sleepDurations.value.allSatisfy { $0 == .milliseconds(500) })
        harness.monitor.stop()
        await harness.task?.value
    }

    @Test("通知のきっかけ（requestRead）で、ポーリングを待たずに読み直す")
    func notificationTriggersImmediateRead() async throws {
        let harness = Harness()
        try await harness.start()
        let before = harness.reads.value
        try await harness.send(reads: true) { harness.monitor.requestRead() }
        #expect(harness.reads.value == before + 1)
        harness.monitor.stop()
        await harness.task?.value
    }

    @Test("使っていない状態が 3 秒続くと自動で休止し、使い始めるとすぐ取る。音のゲートの境界とイベントの時刻は同じ")
    func idleForThreeSecondsPausesThenUsingTakes() async throws {
        let harness = Harness()
        try await harness.start()
        for _ in 0..<5 { try await harness.tick() }
        try await harness.tick()
        try await waitUntil("3.0 秒で自動の休止が 1 件") { harness.pauses.count == 1 }
        #expect(harness.pauses.first?.paused == true)
        #expect(harness.pauses.first?.reason == .automatic)
        #expect(abs((harness.pauses.first?.start ?? -1) - 3.0) < 0.001)
        #expect(harness.gate.value.count == 1)
        #expect(harness.gate.value.first?.paused == true)
        if let gateTime = harness.gate.value.first?.hostTime {
            #expect(abs(offsetSeconds(from: harness.origin, to: gateTime) - 3.0) < 0.001)
        }

        try await harness.tick()
        try await harness.tick()

        harness.processes.value = using
        try await harness.tick()
        try await waitUntil("4.5 秒で休止の解除が届く") { harness.pauses.count == 2 }
        #expect(harness.gate.value.map(\.paused) == [true, false])

        harness.processes.value = idle
        for _ in 0..<6 { try await harness.tick() }
        try await harness.tick()
        try await waitUntil("8.5 秒の読み直しで 3 件目の休止が届く") { harness.pauses.count == 3 }
        harness.monitor.stop()
        await harness.task?.value
        let times = harness.pauses.map(\.start)
        #expect(
            matches(harness.pauses, [(true, .automatic, 3.0), (false, .automatic, 4.5), (true, .automatic, 8.0)]),
            "実際の列: \(harness.pauses) / 時刻 \(times)"
        )
    }

    @Test("会議アプリが一瞬だけマイクを閉じても休止しない")
    func briefIdleDoesNotPause() async throws {
        let harness = Harness()
        harness.processes.value = using
        try await harness.start()
        harness.processes.value = idle
        try await harness.tick()
        try await harness.tick()
        harness.processes.value = using
        for _ in 0..<10 { try await harness.tick() }
        harness.monitor.stop()
        await harness.task?.value
        #expect(harness.pauses.isEmpty)
        #expect(harness.gate.value.isEmpty)
    }

    @Test("プロセス一覧が読めない間は休止せず、読めるようになって 3 秒続くと休止する")
    func unreadableListNeverPauses() async throws {
        let harness = Harness()
        harness.processes.value = nil
        try await harness.start()
        for _ in 0..<10 { try await harness.tick() }
        harness.processes.value = idle
        for _ in 0..<6 { try await harness.tick() }
        try await harness.tick()
        try await waitUntil("読めるようになって 3 秒後に休止が届く") { harness.pauses.count == 1 }
        harness.monitor.stop()
        await harness.task?.value
        #expect(matches(harness.pauses, [(true, .automatic, 8.5)]), "実際の列: \(harness.pauses)")
    }

    @Test("押した指示は、その時点の時刻で休止の変化になる（理由は手動）。同じ状態の指示は何も出さない")
    func pressBecomesManualChange() async throws {
        let harness = Harness()
        harness.processes.value = using
        try await harness.start()
        try await harness.tick()
        try await harness.send { harness.monitor.press(SelfPausePress(paused: true, seq: SelfPauseSeq(value: 1))) }
        try await waitUntil("手動の休止が届く") { harness.pauses.count == 1 }
        #expect(harness.pauses.first?.paused == true)
        #expect(harness.pauses.first?.reason == .manual)
        #expect(abs((harness.pauses.first?.start ?? -1) - 0.5) < 0.001)
        #expect(harness.gate.value.map(\.paused) == [true])

        try await harness.send { harness.monitor.press(SelfPausePress(paused: true, seq: SelfPauseSeq(value: 2))) }

        for _ in 0..<6 { try await harness.tick() }
        harness.processes.value = idle
        try await harness.tick()
        try await waitUntil("閉じた回で自動の休止が届く") { harness.pauses.count == 2 }
        harness.monitor.stop()
        await harness.task?.value
        #expect(
            matches(harness.pauses, [(true, .manual, 0.5), (true, .automatic, 4.0)]),
            "実際の列: \(harness.pauses)"
        )
        #expect(harness.gate.value.map(\.paused) == [true])
    }

    @Test("状態を変えない指示も、処理したら self-pause-state をその seq で返す。休止の変化は出さない")
    func noOpPressStillAcknowledgesItsSeq() async throws {
        let harness = Harness()
        harness.processes.value = using
        try await harness.start()
        try await harness.tick()
        let before = harness.reports.count
        let carry = harness.states.last
        try await harness.send { harness.monitor.press(SelfPausePress(paused: false, seq: SelfPauseSeq(value: 4))) }
        try await waitUntil("seq 4 を処理した状態が届く") { harness.reports.count == before + 1 }
        try await harness.send { harness.monitor.press(SelfPausePress(paused: false, seq: SelfPauseSeq(value: 5))) }
        try await waitUntil("seq 5 を処理した状態が届く") { harness.reports.count == before + 2 }
        harness.monitor.stop()
        await harness.task?.value
        #expect(harness.reports.suffix(2).map(\.handled) == [SelfPauseSeq(value: 4), SelfPauseSeq(value: 5)])
        #expect(harness.reports.suffix(2).allSatisfy { $0.state == carry })
        #expect(harness.pauses.isEmpty)
    }

    @Test("読み取りでは、送り直す状態（self-pause-state）を値が変わったときだけ出し、最新の値が規則の carryOver と一致する。指示を処理する前は handled が 0")
    func announcesCarryOverOnlyWhenChanged() async throws {
        let harness = Harness()
        try await harness.start()
        try await waitUntil("始めの状態が届く") {
            harness.states.last == SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .idle, idleFor: 0)
        }
        for _ in 0..<6 { try await harness.tick() }
        let expected = SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .idle, idleFor: 3)
        try await waitUntil("3 秒の状態が届く") { harness.states.last == expected }
        let settled = harness.states.count
        try await harness.tick()
        try await harness.tick()
        harness.monitor.stop()
        await harness.task?.value
        #expect(harness.states.count == settled)
        for (before, after) in zip(harness.states, harness.states.dropFirst()) { #expect(before != after) }
        #expect(harness.reports.allSatisfy { $0.handled == .none })
    }

    @Test("復元した状態で始めると、読めた最初の回で待たずに休止する")
    func restoredStateSkipsWait() async throws {
        let harness = Harness(restoring: SelfPauseCarryOver(manual: .none, basis: .unknown, lastKnown: .idle, idleFor: 3))
        try await harness.start()
        try await waitUntil("復元した状態で最初の回に休止が届く") { harness.pauses.count == 1 }
        harness.monitor.stop()
        await harness.task?.value
        #expect(harness.pauses.map(\.paused) == [true])
        #expect(harness.pauses.first?.reason == .automatic)
    }

    @Test("stop の後は読み直さない。タスクは終わる")
    func stopEndsPolling() async throws {
        let harness = Harness()
        try await harness.start()
        harness.monitor.stop()
        await harness.task?.value
        let reads = harness.reads.value
        harness.monitor.requestRead()
        harness.clock.update { $0 += 0.5 }
        await harness.idleBriefly()
        #expect(harness.reads.value == reads)
    }
}
