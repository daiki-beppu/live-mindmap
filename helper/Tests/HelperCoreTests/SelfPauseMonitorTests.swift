import CoreAudio
import Foundation
import Testing
@testable import HelperCore

// Issue #1071: 会議アプリのマイクの使用を読み直し（通知のきっかけ・0.5 秒ごとのポーリング）、規則の部品へ渡し、休止の変化を
// 音のゲートとイベントへ届ける監視。Core Audio・タイマーは外から渡す偽物で置き換え、同じ監視の上で状態の変化を続けて観測する。

private let app = "com.google.Chrome"
private let ownPID: Int32 = 100
private let using = [InputProcess(bundleID: app, pid: 200, isRunningInput: true)]
private let idle = [InputProcess(bundleID: app, pid: 200, isRunningInput: false)]

private func hostTime(seconds: Double) -> UInt64 {
    AudioConvertNanosToHostTime(UInt64(seconds * 1_000_000_000))
}

/// 期限つきの条件待ちが超過したときの失敗。待っていた条件を示す。
private struct WaitTimeout: Error, CustomStringConvertible {
    let condition: String
    var description: String { "期限内に成り立たなかった: \(condition)" }
}

/// 条件が成り立つまで、壁時計の期限つきで待つ。超えたら、待っていた条件を示して throw する。
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

/// 偽の時計・待ち・読み取り・出力をまとめたもの。`tick()` で 0.5 秒進めて、待っている監視を 1 回起こす。
private final class Harness: @unchecked Sendable {
    let origin = hostTime(seconds: 100)
    let processes = Box<[InputProcess]?>(idle)
    let clock = Box<Double>(0)
    let reads = Box<Int>(0)
    let sleepCalls = Box<Int>(0)
    let sleepDurations = Box<[Duration]>([])
    /// 監視が処理を始めた入力の数（`now` は入力 1 件につき 1 回呼ばれる）と、こちらが送った入力の数
    let handled = Box<Int>(0)
    let sent = Box<Int>(0)
    /// こちらが送った入力のうち、読み直しになるもの（`readProcesses` が 1 回ずつ呼ばれる）の数
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
                // 値を取り終えてから数える（待ちが戻った後のテストの変更が、前の入力に混ざらないように）
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
        sent.update { $0 += 1 }  // start が先頭の読み取りを 1 件入れる
        sentReads.update { $0 += 1 }
        task = monitor.start()
        try await waitHandled()
    }

    /// 時計を `seconds` 進めて、待っているポーリングを 1 回起こす
    func tick(_ seconds: Double = 0.5) async throws {
        clock.update { $0 += seconds }
        sent.update { $0 += 1 }
        sentReads.update { $0 += 1 }
        waker.yield()
        try await waitHandled()
    }

    /// 入力（読み直しのきっかけ・手動の指示）を 1 件送り、処理されるのを待つ
    func send(reads: Bool = false, _ input: () -> Void) async throws {
        sent.update { $0 += 1 }
        if reads { sentReads.update { $0 += 1 } }
        input()
        try await waitHandled()
    }

    /// 送った入力がすべて値（時計・プロセス一覧）を読み終えるまで、期限つきで待つ。これを返ってから、時計やプロセス一覧を変えてよい。
    /// 結果（イベント・ゲート）は、呼ぶ側が `waitUntil` で観測する。
    func waitHandled(timeout: Duration = .seconds(5)) async throws {
        try await waitUntil(
            "送った入力 \(sent.value) 件の処理の開始と、読み直し \(sentReads.value) 回（実際は \(handled.value) 件・\(reads.value) 回）",
            timeout: timeout
        ) { handled.value >= sent.value && reads.value >= sentReads.value }
    }

    /// 何も起きないことを確かめるときだけ使う。起きるはずのことを待つ場面では使わない。
    func idleBriefly() async {
        for _ in 0..<50 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(20))
    }

    var pauses: [(paused: Bool, reason: SelfPauseReason, start: Double)] {
        events.value.compactMap {
            if case let .selfPause(paused, reason, start) = $0 { return (paused, reason, start) }
            return nil
        }
    }

    var states: [SelfPauseCarryOver] {
        events.value.compactMap {
            if case let .selfPauseState(state) = $0 { return state }
            return nil
        }
    }
}

/// 期待する休止の列（時刻つき）。実際の列と秒の許容差つきで比べる。
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
        for _ in 0..<5 { try await harness.tick() }  // 2.5 秒
        try await harness.tick()  // 3.0 秒
        try await waitUntil("3.0 秒で自動の休止が 1 件") { harness.pauses.count == 1 }
        #expect(harness.pauses.first?.paused == true)
        #expect(harness.pauses.first?.reason == .automatic)
        #expect(abs((harness.pauses.first?.start ?? -1) - 3.0) < 0.001)
        #expect(harness.gate.value.count == 1)
        #expect(harness.gate.value.first?.paused == true)
        if let gateTime = harness.gate.value.first?.hostTime {
            #expect(abs(offsetSeconds(from: harness.origin, to: gateTime) - 3.0) < 0.001)
        }

        // 休止の間は繰り返し知らせない（最後に列全体で確かめる）
        try await harness.tick()
        try await harness.tick()

        // 同じ監視の上で、マイクを使い始めるとその回で取る（4.5 秒）
        harness.processes.value = using
        try await harness.tick()
        try await waitUntil("4.5 秒で休止の解除が届く") { harness.pauses.count == 2 }
        #expect(harness.gate.value.map(\.paused) == [true, false])

        // もう一度閉じると、待ちはやり直し（閉じて最初に読んだ 5.0 秒から 3 秒後の 8.0 秒まで休止しない）
        harness.processes.value = idle
        for _ in 0..<6 { try await harness.tick() }
        try await harness.tick()
        try await waitUntil("8.5 秒の読み直しで 3 件目の休止が届く") { harness.pauses.count == 3 }
        harness.monitor.stop()
        await harness.task?.value
        // 早すぎる休止・繰り返しの知らせが無いことを、時刻つきの列の一致で確かめる
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
        try await harness.send { harness.monitor.press(paused: true) }
        try await waitUntil("手動の休止が届く") { harness.pauses.count == 1 }
        #expect(harness.pauses.first?.paused == true)
        #expect(harness.pauses.first?.reason == .manual)
        #expect(abs((harness.pauses.first?.start ?? -1) - 0.5) < 0.001)
        #expect(harness.gate.value.map(\.paused) == [true])

        try await harness.send { harness.monitor.press(paused: true) }

        // 手動の休止は、会議アプリがマイクを閉じるまで続き、閉じると待たずに自動の休止になる（取る瞬間は無い）
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

    @Test("送り直す状態（self-pause-state）は、値が変わったときだけ出し、最新の値が規則の carryOver と一致する")
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
        // 休止で頭打ちになった後は、値が変わらないので増えない
        try await harness.tick()
        try await harness.tick()
        harness.monitor.stop()
        await harness.task?.value
        #expect(harness.states.count == settled)
        // 重複した連続は出さない
        for (before, after) in zip(harness.states, harness.states.dropFirst()) { #expect(before != after) }
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
