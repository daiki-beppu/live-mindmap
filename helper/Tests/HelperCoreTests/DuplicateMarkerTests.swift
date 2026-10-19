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
        // 相手の流れが終わっている状態。途中結果は保留されずその場で判定され、確定結果の判定も待たずに返るため、
        // 送信順序を 1 つの流れが決めていなければ確定結果が先に出ていく。
        let marker = DuplicateMarker(sleep: { _ in })
        await marker.finishTheirs()

        // `relayMine` と同じ順に呼ぶ（途中結果 → 確定結果の到着 → 判定 → 出力）。
        let mineFinal = Support.final("明日の会議は十時", 10.5, 12)
        await marker.hold(minePartial: Support.partialResult("明日の会議は十時", 10.5, 12))
        await marker.emitHeldPartialAndEndRecheck()
        let duplicate = await marker.resolve(mineFinal, heldSince: await marker.now())
        await marker.emit(resolvedRemark: mineFinal, duplicate: duplicate)
        await marker.finishMineDecisions()

        var decisions: [MineDecision] = []
        for await decision in marker.mineDecisions { decisions.append(decision) }
        #expect(decisions.map(\.result) == [Support.partialResult("明日の会議は十時", 10.5, 12), mineFinal])
        #expect(decisions.map(\.duplicate) == [false, false])
    }

    @Test("保留中に自分の途中結果が書き換わった後、実際に保留の上限へ到達したときに流れるのは新しいほうの内容")
    func deadlineAfterRewriteEmitsLatestPartial() async {
        // 上限を、実時間ではなく外からの合図で到達させる。`rewriteDuringHoldKeepsOriginalLimit` は
        // 流れの終了（finishMine 経由）で解放するため、書き換え後に実際にタイマーが発火した経路は
        // ここで確認する。判定器を直接呼び、各 `hold` の完了を待ってから上限へ進める
        // （流れへの投入だけでは、保留値の更新がタイマーより先に終わる保証がない）。
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })

        await marker.hold(minePartial: Support.partialResult("マリ", 10, 11))
        await Support.awaitSignal(entered)
        // 保留中に書き換わる（タイマーが作り直されないことは `rewriteDuringHoldKeepsOriginalLimit` で確認済み）。
        await marker.hold(minePartial: Support.partialResult("マリコ", 10, 11.5))
        limitContinuation.yield()

        var decisions = marker.mineDecisions.makeAsyncIterator()
        let released = await decisions.next()
        #expect(released?.result == Support.partialResult("マリコ", 10, 11.5))
        #expect(released?.duplicate == false)
        // 古い「マリ」が別に流れていないことを確かめる。
        await marker.finishMineDecisions()
        let rest = await decisions.next()
        #expect(rest == nil)
    }

    @Test("確定結果の保留の上限は、注入した時計の時刻で数える。保留に入れた時刻から数え、時計が進んだ分は待ち時間から引かれる")
    func resolveWaitIsMeasuredOnInjectedClock() async {
        let clock = Support.AudioClock()
        let durations = Support.DurationLog()
        let marker = DuplicateMarker(sleep: { durations.append($0) }, now: { clock.value })
        clock.advance(to: 100)

        // 壁時計なら、この差は出ない。時計の値だけで待ち時間が決まる。
        _ = await marker.resolve(Support.final(Support.sentence, 90, 92), heldSince: 100)
        clock.advance(to: 103)
        _ = await marker.resolve(Support.final(Support.other, 93, 95), heldSince: 100)

        let waits = durations.values.map(Support.seconds)
        #expect(waits.count == 2)
        guard waits.count == 2 else { return }
        #expect(abs(waits[0] - 8) < 0.001)
        #expect(abs(waits[1] - 5) < 0.001)
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
        // 壁時計で 1.3 秒たっても、時計（音声の時刻）が進んでいなければ流れない
        try await Task.sleep(for: .milliseconds(1300))
        #expect(received.values.isEmpty)

        clock.advance(to: 1)
        for _ in 0..<200 where received.values.isEmpty { try await Task.sleep(for: .milliseconds(25)) }
        #expect(received.values.map(\.result) == [Support.partialResult("明日の", 1, 2)])
        #expect(received.values.map(\.duplicate) == [false])
    }
}
