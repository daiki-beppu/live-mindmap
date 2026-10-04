import Foundation
import Testing
import HelperCore

// スピーカーのときの転送。`自分` の確定結果に重複の印を付け、捨てずに全件流す。

private struct TrackFailure: Error, Equatable {}

private final class TerminationFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

private final class DurationLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Duration] = []
    func append(_ duration: Duration) { lock.lock(); items.append(duration); lock.unlock() }
    var values: [Duration] { lock.lock(); defer { lock.unlock() }; return items }
}

private let sentence = "明日の会議は十時から始めます"
private let other = "来週の火曜日に資料を送ります"

private func connect(to server: WebSocketServer, port: UInt16) async throws -> URLSessionWebSocketTask {
    let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
    task.resume()
    for _ in 0..<100 where await server.clientCount != 1 { try await Task.sleep(for: .milliseconds(50)) }
    return task
}

private func receiveTexts(_ task: URLSessionWebSocketTask, count: Int) async throws -> [String] {
    var received: [String] = []
    for _ in 0..<count {
        guard case .string(let text) = try await task.receive() else { Issue.record("テキストフレームでない"); return received }
        received.append(text)
    }
    return received
}

private func finishedStream(_ results: [TranscriptionResult]) -> AsyncThrowingStream<TranscriptionResult, Error> {
    AsyncThrowingStream { continuation in
        for result in results { continuation.yield(result) }
        continuation.finish()
    }
}

private func final(_ text: String, _ start: Double, _ end: Double) -> TranscriptionResult {
    TranscriptionResult(text: text, isFinal: true, start: start, end: end)
}

private func remark(_ track: Track, _ text: String, _ start: Double, _ end: Double, duplicate: Bool) throws -> String {
    try HelperEvent.remark(track: track, start: start, end: end, text: text, duplicate: duplicate).jsonString()
}

private func partialResult(_ text: String, _ start: Double, _ end: Double) -> TranscriptionResult {
    TranscriptionResult(text: text, isFinal: false, start: start, end: end)
}

private func partialEvent(_ track: Track, _ text: String, _ start: Double, _ end: Double, duplicate: Bool) throws -> String {
    try HelperEvent.partial(track: track, start: start, end: end, text: text, duplicate: duplicate).jsonString()
}

/// Issue #141 の状況。`相手` の発言が保留の上限より長く続き、その確定結果は上限に達した後に届く。
/// 同じ判定器・同じ `relay` の上で、(1) `相手` の途中結果が届く (2) `自分` の確定結果が保留される
/// (3) 保留の上限に達する (4) `自分` の確定結果が流れる (5) `相手` の確定結果が届く、の順に流し、
/// (4) で届いた `自分` の確定結果のイベントと、(5) まで含めて届いたイベントを返す。
private func relayRemarkReleasedBeforeTheirFinal(
    theirPartial: TranscriptionResult, mine mineResult: TranscriptionResult, theirFinal: TranscriptionResult
) async throws -> (releasedRemark: String, rest: [String]) {
    let server = WebSocketServer(port: 0)
    let port = try await server.start()
    defer { Task { await server.stop() } }
    let task = try await connect(to: server, port: port)
    defer { task.cancel(with: .goingAway, reason: nil) }

    let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
    let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
    // 保留の上限を、実時間ではなく外からの合図で到達させる。
    let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
    let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
    let marker = DuplicateMarker(sleep: { _ in
        enteredContinuation.yield()
        for await _ in limit { return }
    })
    let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
    defer { relaying.cancel() }

    theirsContinuation.yield(theirPartial)
    _ = try await receiveTexts(task, count: 1)
    mineContinuation.yield(mineResult)
    var signals = entered.makeAsyncIterator()
    await signals.next()
    limitContinuation.yield()
    let released = try await receiveTexts(task, count: 1)

    theirsContinuation.yield(theirFinal)
    let rest = try await receiveTexts(task, count: 1)
    return (released[0], rest)
}

@Suite("重複の印を付ける転送", .timeLimit(.minutes(1)))
struct DuplicateRelayTests {
    @Test("同じ時間帯の相手と重なる自分の確定結果に印が付き、相手の確定結果には付かない")
    func marksOverlappingRemark() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = finishedStream([final(sentence, 10.5, 14.5)])
        let theirs = finishedStream([final(sentence, 10, 14)])
        try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: DuplicateMarker())

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try remark(.自分, sentence, 10.5, 14.5, duplicate: true),
            try remark(.相手, sentence, 10, 14, duplicate: false),
        ])
    }

    @Test("後から届く相手の確定結果と重なる自分の確定結果にも印が付く（後 8 秒を待つ）")
    func waitsForLaterTheirRemark() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = finishedStream([final(sentence, 10, 13)])
        let theirs = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            Task {
                try? await Task.sleep(for: .milliseconds(300))
                continuation.yield(final(sentence, 11, 14))
                continuation.finish()
            }
        }
        try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: DuplicateMarker())

        let received = try await receiveTexts(task, count: 2)
        #expect(received.contains(try remark(.自分, sentence, 10, 13, duplicate: true)))
    }

    @Test("印の有無にかかわらず自分の確定結果は全件、トラック内の順序のまま流れる")
    func keepsEveryRemarkInOrder() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        // 1 件目は相手と無関係、2 件目は漏れ（重複）、3 件目は 2 件目の後の自分の発言。
        let mine = finishedStream([
            final(other, 0, 2),
            final(sentence, 20, 23),
            final("了解です、少し確認します", 24, 26),
        ])
        // 相手の確定結果が 1 件だけ、自分の最初の発言の後 8 秒より後に届いて文脈になる。
        let theirs = finishedStream([final(sentence, 20, 23)])
        try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: DuplicateMarker())

        let received = try await receiveTexts(task, count: 4)
        let expectedMine = [
            try remark(.自分, other, 0, 2, duplicate: false),
            try remark(.自分, sentence, 20, 23, duplicate: true),
            try remark(.自分, "了解です、少し確認します", 24, 26, duplicate: false),
        ]
        #expect(received.filter(expectedMine.contains) == expectedMine)
        #expect(received.contains(try remark(.相手, sentence, 20, 23, duplicate: false)))
    }

    @Test("判定器がない（イヤホンなど）ときは、重なる入力でも印を付けない")
    func noMarkerNeverMarks() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = finishedStream([final(sentence, 10.5, 14.5)])
        let theirs = finishedStream([final(sentence, 10, 14)])
        try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: nil)

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try remark(.自分, sentence, 10.5, 14.5, duplicate: false),
            try remark(.相手, sentence, 10, 14, duplicate: false),
        ])
    }

    @Test("自分の途中結果は保留せず、すぐ流れる")
    func partialIsNotHeld() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        // どちらの流れも終わらない。確定結果が保留されても、途中結果は届く。
        let mine = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.yield(final(sentence, 0, 2))
            continuation.yield(TranscriptionResult(text: "明日の", isFinal: false, start: 3, end: 4))
        }
        let theirs = AsyncThrowingStream<TranscriptionResult, Error> { _ in }
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: DuplicateMarker()) }
        defer { relaying.cancel() }

        let received = try await receiveTexts(task, count: 1)
        #expect(received == [try partialEvent(.自分, "明日の", 3, 4, duplicate: false)])
    }

    @Test("自分の確定結果が保留中で、どちらの流れも終わらなくても、相手の途中結果と同じ自分の途中結果は印付きですぐ届く")
    func partialMarkedWhileRemarkHeld() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: DuplicateMarker()) }
        defer { relaying.cancel() }

        // 自分の確定結果を保留に入れる。相手は終わらないので、判定は待ち続ける。
        mineContinuation.yield(final(other, 0, 2))
        // 相手の途中結果が流れ終わってから（文脈に入ってから）、自分の途中結果を流す。
        theirsContinuation.yield(partialResult(sentence, 10, 13))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.相手, sentence, 10, 13, duplicate: false)])
        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))

        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: true)])
    }

    @Test("相手の途中結果・確定結果とほぼ同じ自分の途中結果は印付き、違う内容は印なしで流れる。相手の途中結果は印なし")
    func marksPartialsAgainstTheirs() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        // 同じ判定器で、相手 → 自分の順に流し終える（並行実行に結果が左右されない）。
        let marker = DuplicateMarker()
        let theirs = finishedStream([partialResult(sentence, 10, 13), final(other, 30, 33)])
        try await relay(theirs, track: .相手, to: server, duplicates: marker)
        let mine = finishedStream([
            partialResult("明日の会議は十時", 10.5, 12),
            partialResult("了解です、少し確認します", 10.5, 12),
            partialResult("来週の火曜日に資料", 31, 32),
        ])
        try await relay(mine, track: .自分, to: server, duplicates: marker)

        let received = try await receiveTexts(task, count: 5)
        #expect(received == [
            try partialEvent(.相手, sentence, 10, 13, duplicate: false),
            try remark(.相手, other, 30, 33, duplicate: false),
            try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: true),
            try partialEvent(.自分, "了解です、少し確認します", 10.5, 12, duplicate: false),
            try partialEvent(.自分, "来週の火曜日に資料", 31, 32, duplicate: true),
        ])
    }

    @Test("判定器がないときは、相手の途中結果と同じ自分の途中結果にも印を付けない")
    func noMarkerNeverMarksPartial() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        try await relay(finishedStream([partialResult(sentence, 10, 13)]), track: .相手, to: server, duplicates: nil)
        try await relay(finishedStream([partialResult(sentence, 10.5, 13)]), track: .自分, to: server, duplicates: nil)

        let received = try await receiveTexts(task, count: 2)
        #expect(received == [
            try partialEvent(.相手, sentence, 10, 13, duplicate: false),
            try partialEvent(.自分, sentence, 10.5, 13, duplicate: false),
        ])
    }

    @Test("相手が何も話さなくても、保留時間が過ぎたら自分の確定結果は印なしで流れる")
    func releasesAfterTimeout() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.yield(final(sentence, 0, 2))
        }
        let theirs = AsyncThrowingStream<TranscriptionResult, Error> { _ in }
        // 待ち時間をすぐ終える sleep を注入する。
        let marker = DuplicateMarker(sleep: { _ in })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        let received = try await receiveTexts(task, count: 1)
        #expect(received == [try remark(.自分, sentence, 0, 2, duplicate: false)])
    }

    @Test("相手の確定結果が保留の上限より後に届いても、相手が話している途中結果と同じ自分の確定結果には印が付く（Issue の 1 件目）")
    func marksRemarkWhenTheirFinalArrivesAfterHoldLimitCase1() async throws {
        let theirPartialText = "じゃあ始めましょうか。今日は最近使ってよかったものを"
        let result = try await relayRemarkReleasedBeforeTheirFinal(
            theirPartial: partialResult(theirPartialText, 2.9, 15.6),
            mine: final("じゃあ始めましょう", 3.1, 6.7),
            theirFinal: final("じゃあ始めましょうか。今日は最近使ってよかったものを", 2.9, 15.9))

        #expect(result.releasedRemark == (try remark(.自分, "じゃあ始めましょう", 3.1, 6.7, duplicate: true)))
        #expect(result.rest == [try remark(.相手, "じゃあ始めましょうか。今日は最近使ってよかったものを", 2.9, 15.9, duplicate: false)])
    }

    @Test("相手の確定結果が保留の上限より後に届いても、相手が話している途中結果と同じ自分の確定結果には印が付く（Issue の 2 件目）")
    func marksRemarkWhenTheirFinalArrivesAfterHoldLimitCase2() async throws {
        let result = try await relayRemarkReleasedBeforeTheirFinal(
            theirPartial: partialResult("あともう一つおすすめの本があって", 57.9, 70),
            mine: final("もう一つ", 58.1, 61.2),
            theirFinal: final("あともう一つおすすめの本があって", 57.9, 74.7))

        #expect(result.releasedRemark == (try remark(.自分, "もう一つ", 58.1, 61.2, duplicate: true)))
        #expect(result.rest == [try remark(.相手, "あともう一つおすすめの本があって", 57.9, 74.7, duplicate: false)])
    }

    @Test("相手の確定結果が保留の上限より後に届くとき、相手の途中結果と内容が違う自分の確定結果には印が付かない")
    func doesNotMarkDifferentRemarkWhenTheirFinalArrivesAfterHoldLimit() async throws {
        let result = try await relayRemarkReleasedBeforeTheirFinal(
            theirPartial: partialResult("じゃあ始めましょうか。今日は最近使ってよかったものを", 2.9, 15.6),
            mine: final("了解です、少し確認します", 3.1, 6.7),
            theirFinal: final("じゃあ始めましょうか。今日は最近使ってよかったものを", 2.9, 15.9))

        #expect(result.releasedRemark == (try remark(.自分, "了解です、少し確認します", 3.1, 6.7, duplicate: false)))
    }

    @Test("確定結果の判定でも、時間範囲が前後 8 秒の窓に重ならない古い相手の途中結果は文脈に入れない")
    func ignoresStaleTheirPartialForRemark() async throws {
        let result = try await relayRemarkReleasedBeforeTheirFinal(
            theirPartial: partialResult(sentence, 0, 3),
            mine: final(sentence, 40, 43),
            theirFinal: final(other, 41, 44))

        #expect(result.releasedRemark == (try remark(.自分, sentence, 40, 43, duplicate: false)))
    }

    @Test("エラーでキャンセルされたら、保留中の自分の確定結果は送られない")
    func cancelledRemarkIsNotBroadcast() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.yield(final(sentence, 0, 2))
        }
        let (failing, failingContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        // 保留中の確定結果が判定待ち（resolve）に入ったことを知らせる合図。
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let marker = DuplicateMarker(sleep: { duration in
            enteredContinuation.yield()
            try await Task.sleep(for: duration)
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, failing)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        // 判定待ちに入ってから相手を失敗させ、キャンセルが判定待ちの最中に起きる状態にする。
        var signals = entered.makeAsyncIterator()
        await signals.next()
        failingContinuation.finish(throwing: TrackFailure())
        _ = try? await relaying.value

        // 一定時間待っても何も届かないこと。
        let arrived = await withTaskGroup(of: Bool.self) { group in
            group.addTask { (try? await task.receive()) != nil }
            group.addTask { try? await Task.sleep(for: .milliseconds(500)); return false }
            let first = await group.next() ?? false
            // receive は Task のキャンセルに応じないので、接続を閉じて終わらせる。
            task.cancel(with: .goingAway, reason: nil)
            group.cancelAll()
            return first
        }
        #expect(!arrived)
    }

    @Test("保留の上限は保留に入れた時刻から数え、前の発言の待ちで遅れた分は引かれる")
    func holdLimitCountsFromHeldTime() async throws {
        let durations = DurationLog()
        // 実際に 300ms 待つ sleep。要求された待ち時間を記録する。
        let marker = DuplicateMarker(sleep: { duration in
            durations.append(duration)
            try await Task.sleep(for: .milliseconds(300))
        })
        let heldSince = ContinuousClock.now
        _ = await marker.resolve(final(sentence, 0, 2), heldSince: heldSince)
        _ = await marker.resolve(final(other, 3, 5), heldSince: heldSince)

        let recorded = durations.values
        #expect(recorded.count == 2)
        // 2 件目は、1 件目の待ち（300ms）の分だけ短くなる。
        #expect(recorded[0] - recorded[1] >= .milliseconds(250))
    }

    @Test("保留中の自分の確定結果があっても、エラーで終わったらそのエラーを返し、もう一方の流れも終わる")
    func errorStopsOtherTrack() async throws {
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        defer { Task { await server.stop() } }

        let terminated = TerminationFlag()
        let mine = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.onTermination = { _ in terminated.set() }
            continuation.yield(final(sentence, 0, 2))
        }
        let failing = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.finish(throwing: TrackFailure())
        }

        do {
            try await relay(tracks: [(.自分, mine), (.相手, failing)], to: server, duplicates: DuplicateMarker())
            Issue.record("エラーで終わるはずが、正常に戻った")
        } catch let error as TrackFailure {
            #expect(error == TrackFailure())
        }

        for _ in 0..<100 where !terminated.isSet { try await Task.sleep(for: .milliseconds(50)) }
        #expect(terminated.isSet)
    }
}
