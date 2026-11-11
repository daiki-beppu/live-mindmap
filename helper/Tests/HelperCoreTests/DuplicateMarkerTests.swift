import Foundation
import Testing
import HelperCore

enum DuplicateMarkerTestSupport {
    final class DurationLog: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [Duration] = []
        func append(_ duration: Duration) { lock.lock(); items.append(duration); lock.unlock() }
        var values: [Duration] { lock.lock(); defer { lock.unlock() }; return items }
    }

    final class AudioClock: @unchecked Sendable {
        private let lock = NSLock()
        private var seconds = 0.0
        var value: Double { lock.withLock { seconds } }
        func advance(to target: Double) { lock.withLock { seconds = target } }
    }

    static func seconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
    }

    static func awaitSignal(_ signals: AsyncStream<Void>) async {
        let arrived = await withTaskGroup(of: Bool.self) { group in
            group.addTask { for await _ in signals { return true }; return false }
            group.addTask { try? await Task.sleep(for: .seconds(5)); return false }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        if !arrived { Issue.record("合図が届かない") }
    }

    static func final(_ text: String, _ start: Double, _ end: Double) -> TranscriptionResult {
        TranscriptionResult(text: text, isFinal: true, start: start, end: end)
    }

    static func partialResult(_ text: String, _ start: Double, _ end: Double) -> TranscriptionResult {
        TranscriptionResult(text: text, isFinal: false, start: start, end: end)
    }

    static let sentence = "明日の会議は十時から始めます"

    static let other = "来週の火曜日に資料を送ります"
}

private final class DecisionLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [MineDecision] = []
    func append(_ decision: MineDecision) { lock.withLock { items.append(decision) } }
    var values: [MineDecision] { lock.withLock { items } }
}

private typealias Support = DuplicateMarkerTestSupport

@Suite("重複判定の保留と出力", .timeLimit(.minutes(1)))
struct DuplicateMarkerTests {
    @Test("判定の済んだ自分の途中結果と確定結果は、1 つの流れに積んだ順で取り出せる（確定結果が同じ発話の途中結果を追い越さない）")
    func mineDecisionsCarryPartialAndRemarkInOrder() async {
        let marker = DuplicateMarker(sleep: { _ in })
        await marker.finishTheirs()

        let mineFinal = Support.final("明日の会議は十時", 10.5, 12)
        await marker.hold(minePartial: Support.partialResult("明日の会議は十時", 10.5, 12))
        await marker.hold(mineFinal: mineFinal)
        await marker.endMineFinals()
        await marker.resolveHeldFinals()

        var decisions: [MineDecision] = []
        for await decision in marker.mineDecisions { decisions.append(decision) }
        #expect(decisions.map(\.result) == [Support.partialResult("明日の会議は十時", 10.5, 12), mineFinal])
        #expect(decisions.map(\.duplicate) == [false, false])
    }

    @Test("保留中に自分の途中結果が書き換わった後、実際に保留の上限へ到達したときに流れるのは新しいほうの内容")
    func deadlineAfterRewriteEmitsLatestPartial() async {
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })

        await marker.hold(minePartial: Support.partialResult("マリ", 10, 11))
        await Support.awaitSignal(entered)
        await marker.hold(minePartial: Support.partialResult("マリコ", 10, 11.5))
        limitContinuation.yield()

        var decisions = marker.mineDecisions.makeAsyncIterator()
        let released = await decisions.next()
        #expect(released?.result == Support.partialResult("マリコ", 10, 11.5))
        #expect(released?.duplicate == false)
        await marker.endMineFinals()
        await marker.resolveHeldFinals()
        let rest = await decisions.next()
        #expect(rest == nil)
    }

    @Test("確定結果の保留の上限は、注入した時計の時刻で数える。保留に入れた時刻から数え、時計が進んだ分は待ち時間から引かれる")
    func resolveWaitIsMeasuredOnInjectedClock() async {
        let clock = Support.AudioClock()
        let durations = Support.DurationLog()
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (release, releaseContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { releaseContinuation.finish(); enteredContinuation.finish() }
        let marker = DuplicateMarker(sleep: { duration in
            durations.append(duration)
            enteredContinuation.yield()
            if durations.values.count == 1 { for await _ in release { return } }
        }, now: { clock.value })
        clock.advance(to: 100)
        let finals = [Support.final(Support.sentence, 90, 92), Support.final(Support.other, 93, 95)]
        for result in finals { await marker.hold(mineFinal: result) }
        await marker.endMineFinals()
        let resolving = Task { await marker.resolveHeldFinals() }
        defer { resolving.cancel() }

        await Support.awaitSignal(entered)
        clock.advance(to: 103)
        releaseContinuation.yield()
        await resolving.value

        let waits = durations.values.map(Support.seconds)
        #expect(waits.count == 2)
        guard waits.count == 2 else { return }
        #expect(abs(waits[0] - 8) < 0.001)
        #expect(abs(waits[1] - 5) < 0.001)
    }

    @Test("消費を始める前に保留した確定結果は、入力終了後も投入順に全件判定されて出力が閉じる")
    func heldFinalsDrainInInsertionOrder() async {
        let marker = DuplicateMarker(sleep: { _ in })
        await marker.add(theirs: Support.final(Support.sentence, 10, 12))
        await marker.finishTheirs()
        let finals = [Support.final(Support.other, 20, 22), Support.final(Support.sentence, 10, 12)]
        for result in finals { await marker.hold(mineFinal: result) }
        await marker.endMineFinals()

        await marker.resolveHeldFinals()

        var decisions: [MineDecision] = []
        for await decision in marker.mineDecisions { decisions.append(decision) }
        #expect(decisions.map(\.result) == finals)
        #expect(decisions.map(\.duplicate) == [false, true])
    }

    @Test("確定結果がないまま入力を閉じても消費が終了し、判定出力も閉じる")
    func emptyFinalsCloseDecisions() async {
        let marker = DuplicateMarker()
        await marker.endMineFinals()

        await marker.resolveHeldFinals()

        var decisions = marker.mineDecisions.makeAsyncIterator()
        #expect(await decisions.next() == nil)
    }

    @Test("自分の途中結果の保留（1 秒）も注入した sleep で解ける。相手の文字が無いまま、時計が 1 秒進むまでは流れず、進むと印なしで流れる")
    func partialHoldIsReleasedByInjectedSleep() async throws {
        let clock = Support.AudioClock()
        let marker = DuplicateMarker(
            sleep: { duration in
                let target = clock.value + Support.seconds(duration)
                while clock.value < target { try await Task.sleep(for: .milliseconds(5)) }
            },
            now: { clock.value })
        let received = DecisionLog()
        let reader = Task { for await decision in marker.mineDecisions { received.append(decision) } }
        defer { reader.cancel() }

        await marker.hold(minePartial: Support.partialResult("明日の", 1, 2))
        try await Task.sleep(for: .milliseconds(1300))
        #expect(received.values.isEmpty)

        clock.advance(to: 1)
        for _ in 0..<200 where received.values.isEmpty { try await Task.sleep(for: .milliseconds(25)) }
        #expect(received.values.map(\.result) == [Support.partialResult("明日の", 1, 2)])
        #expect(received.values.map(\.duplicate) == [false])
    }
}
