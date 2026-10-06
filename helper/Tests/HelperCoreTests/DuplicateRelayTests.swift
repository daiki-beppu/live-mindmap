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
        guard let text = await receiveText(task) else { return received }
        received.append(text)
    }
    return received
}

/// テキストフレーム 1 件を待つ。`receive` は Task のキャンセルに応じず、@Suite の時間制限でも止まらないので、
/// 待っても届かないときは接続を閉じて終わらせ、テストが止まらずに落ちるようにする。
private func receiveText(_ task: URLSessionWebSocketTask) async -> String? {
    await withTaskGroup(of: String?.self) { group in
        group.addTask {
            guard case .string(let text) = try? await task.receive() else { return nil }
            return text
        }
        group.addTask { try? await Task.sleep(for: .seconds(5)); return nil }
        let first = await group.next() ?? nil
        if first == nil {
            Issue.record("テキストフレームが届かない")
            task.cancel(with: .goingAway, reason: nil)
        }
        group.cancelAll()
        return first
    }
}

/// 合図を 1 件待つ。`receiveText` と同じ理由で、来ないときは @Suite の時間制限を待たずに落とす。
private func awaitSignal(_ signals: AsyncStream<Void>) async {
    let arrived = await withTaskGroup(of: Bool.self) { group in
        group.addTask { for await _ in signals { return true }; return false }
        group.addTask { try? await Task.sleep(for: .seconds(5)); return false }
        let first = await group.next() ?? false
        group.cancelAll()
        return first
    }
    if !arrived { Issue.record("合図が届かない") }
}

/// それ以上フレームが届かないことを確かめる。`receive` は Task のキャンセルに応じないので、確かめた後は接続を閉じて終わらせる。
private func receivesNothingMore(_ task: URLSessionWebSocketTask) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
        group.addTask { (try? await task.receive()) != nil }
        group.addTask { try? await Task.sleep(for: .milliseconds(500)); return false }
        let arrived = await group.next() ?? false
        task.cancel(with: .goingAway, reason: nil)
        group.cancelAll()
        return !arrived
    }
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
    await awaitSignal(entered)
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

    @Test("自分の途中結果は、区間が重なる相手の文字が届く前には流れず、届いてから印付きで流れる")
    func holdsPartialUntilOverlappingTheirTextArrives() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        // 保留に入った合図を受け、上限には達させない。相手の到着だけで解放されることを見る。
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))
        await awaitSignal(entered)

        theirsContinuation.yield(partialResult(sentence, 10, 13))

        // 保留せずに流していれば、印なしの自分の途中結果がこの 2 件に混ざる。
        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try partialEvent(.相手, sentence, 10, 13, duplicate: false),
            try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: true),
        ])
    }

    @Test("区間が重ならない相手の文字が届いても、自分の途中結果は保留されたまま")
    func keepsPartialHeldWhenTheirTextDoesNotOverlap() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))
        await awaitSignal(entered)

        // 区間が離れた相手の途中結果。これで解放されるなら、この 1 件に自分の途中結果が混ざる。
        theirsContinuation.yield(partialResult(other, 40, 43))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.相手, other, 40, 43, duplicate: false)])

        // 区間が重なる相手の途中結果が届いて、はじめて解放される。
        theirsContinuation.yield(partialResult(sentence, 10, 13))
        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try partialEvent(.相手, sentence, 10, 13, duplicate: false),
            try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: true),
        ])
    }

    @Test("自分の途中結果は、相手の確定結果（add(theirs:) 経由）でも、区間が重なれば保留が解放されて印付きで流れる")
    func holdsPartialUntilOverlappingTheirFinalArrives() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))
        await awaitSignal(entered)

        // `partialResult` ではなく確定結果。`add(theirs:)` が保留の解放を起こすことを見る
        // （`add(theirPartial:)` とは別の配線）。
        theirsContinuation.yield(final(sentence, 10, 13))

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try remark(.相手, sentence, 10, 13, duplicate: false),
            try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: true),
        ])
    }

    @Test("区間が重なる相手の文字が届かないとき、自分の途中結果は保留の上限（1 秒）で判定され、印なしで流れる")
    func releasesHeldPartialAtHoldLimit() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let durations = DurationLog()
        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        // 上限を、実時間ではなく外からの合図で到達させる。要求された待ち時間も記録する。
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { duration in
            durations.append(duration)
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))
        await awaitSignal(entered)
        limitContinuation.yield()

        let received = try await receiveTexts(task, count: 1)
        #expect(received == [try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false)])
        #expect(durations.values == [.seconds(1)])
    }

    @Test("印なしで流した自分の途中結果は、後から区間が重なる相手の文字が届くと印付きで流し直される")
    func rechecksBroadcastPartialWhenTheirTextArrivesLater() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        // 上限にすぐ到達させ、相手の文脈がない時点の判定で流させる。
        let marker = DuplicateMarker(sleep: { _ in })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false)])

        theirsContinuation.yield(partialResult(sentence, 10, 13))

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try partialEvent(.相手, sentence, 10, 13, duplicate: false),
            try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: true),
        ])
    }

    @Test("印なしで流した自分の途中結果は、相手の確定結果（add(theirs:) 経由）が届いても印付きで流し直される")
    func rechecksBroadcastPartialWhenTheirFinalArrivesLater() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        // 上限にすぐ到達させ、相手の文脈がない時点の判定で流させる。
        let marker = DuplicateMarker(sleep: { _ in })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false)])

        // `partialResult` ではなく確定結果。`add(theirs:)` が照らし直しを起こすことを見る
        // （`add(theirPartial:)` とは別の配線）。
        theirsContinuation.yield(final(sentence, 10, 13))

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try remark(.相手, sentence, 10, 13, duplicate: false),
            try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: true),
        ])
    }

    @Test("自分の確定結果が届いた後は、区間が重なる相手の文字が届いても、流した途中結果を流し直さない")
    func stopsRecheckAfterMyRemarkArrives() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        // 流し直しの対象になる、印なしの途中結果を先に作る。
        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false)])

        // 確定結果が流れたことで、その途中結果は発言になっている。
        mineContinuation.yield(final(other, 20, 22))
        #expect(try await receiveTexts(task, count: 1) == [try remark(.自分, other, 20, 22, duplicate: false)])

        theirsContinuation.yield(partialResult(sentence, 10, 13))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.相手, sentence, 10, 13, duplicate: false)])
        #expect(await receivesNothingMore(task))
    }

    @Test("自分の確定結果が届いたとき、まだ保留中（未解放）の途中結果は、その時点の文脈で判定され、確定結果より先に流れる。流した後は二重送出も流し直しも起きない")
    func finalArrivalEmitsStillHeldPartial() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        // 途中結果の保留（1 秒）だけ合図で制御する。確定結果の保留（8 秒）は、相手の文脈が無いので
        // すぐ終えてよく、ここでは区別してすぐ返す。
        let marker = DuplicateMarker(sleep: { duration in
            guard duration == .seconds(1) else { return }
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        // 自分の途中結果が保留に入る（相手の文脈はまだない）。
        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))
        await awaitSignal(entered)

        // 保留が解放される前（上限にも相手の到着にも達する前）に、別の区切りの確定結果が届く。
        // 保留中の途中結果は捨てられず、確定結果（判定待ちが最大 8 秒ある）より先に流れる。
        mineContinuation.yield(final(other, 20, 22))
        #expect(try await receiveTexts(task, count: 2) == [
            try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false),
            try remark(.自分, other, 20, 22, duplicate: false),
        ])

        // 古い保留のタイマーを発火させ、相手の文字も届かせる。流した時点で保留は解かれ、
        // 照らし直しの対象からも外れているので、二重送出も流し直しも起きない。
        limitContinuation.yield()
        theirsContinuation.yield(partialResult(sentence, 10, 13))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.相手, sentence, 10, 13, duplicate: false)])
        #expect(await receivesNothingMore(task))
    }

    @Test("判定の済んだ自分の途中結果と確定結果は、1 つの流れに積んだ順で取り出せる（確定結果が同じ発話の途中結果を追い越さない）")
    func mineDecisionsCarryPartialAndRemarkInOrder() async {
        // 相手の流れが終わっている状態。途中結果は保留されずその場で判定され、確定結果の判定も待たずに返るため、
        // 送信順序を 1 つの流れが決めていなければ確定結果が先に出ていく。
        let marker = DuplicateMarker(sleep: { _ in })
        await marker.finishTheirs()

        // `relayMine` と同じ順に呼ぶ（途中結果 → 確定結果の到着 → 判定 → 出力）。
        let mineFinal = final("明日の会議は十時", 10.5, 12)
        await marker.hold(minePartial: partialResult("明日の会議は十時", 10.5, 12))
        await marker.emitHeldPartialAndEndRecheck()
        let duplicate = await marker.resolve(mineFinal, heldSince: ContinuousClock.now)
        await marker.emit(resolvedRemark: mineFinal, duplicate: duplicate)
        await marker.finishMineDecisions()

        var decisions: [MineDecision] = []
        for await decision in marker.mineDecisions { decisions.append(decision) }
        #expect(decisions.map(\.result) == [partialResult("明日の会議は十時", 10.5, 12), mineFinal])
        #expect(decisions.map(\.duplicate) == [false, false])
    }

    @Test("相手の流れが終わった後でも、同じ発話の自分の途中結果は確定結果より先に届く")
    func broadcastsPartialBeforeRemarkForSameUtterance() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        // 相手の流れを先に終える。この状態では確定結果の判定が待たずに返るので、送信の所有者が 1 つでなければ
        // 確定結果が途中結果を追い越しうる（追い越すと、確定で消した字幕へ古い本文が戻る）。
        let marker = DuplicateMarker()
        try await relay(finishedStream([]), track: .相手, to: server, duplicates: marker)
        try await relay(
            finishedStream([partialResult("明日の会議は十時", 10.5, 12), final("明日の会議は十時", 10.5, 12)]),
            track: .自分, to: server, duplicates: marker)

        let received = try await receiveTexts(task, count: 2)
        #expect(received == [
            try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false),
            try remark(.自分, "明日の会議は十時", 10.5, 12, duplicate: false),
        ])
    }

    @Test("書き換えた自分の途中結果が重なりの即時判定に切り替わったら、古い保留とタイマーも解除される（古い内容が後から流れない）")
    func rewriteIntoImmediateJudgeClearsStaleHold() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        // 保留に入った合図を受け、上限には達させない（テスト内で明示的に発火させる）。
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        // 相手の確定結果が先に届いている。区間は 11.2〜15 で、自分の最初の途中結果（10〜11）とは重ならない。
        theirsContinuation.yield(final(sentence, 11.2, 15))
        #expect(try await receiveTexts(task, count: 1) == [try remark(.相手, sentence, 11.2, 15, duplicate: false)])

        // 自分の最初の途中結果は相手と重ならないので保留される。
        mineContinuation.yield(partialResult(sentence, 10, 11))
        await awaitSignal(entered)

        // 書き換え（10〜11.5）で区間が伸び、相手と重なるようになる。即時判定され、古い保留は解除されるはず。
        mineContinuation.yield(partialResult(sentence, 10, 11.5))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, sentence, 10, 11.5, duplicate: true)])

        // 保留が解除されていれば、古いタイマーが発火しても、古い区間（10〜11）の途中結果は流れない。
        limitContinuation.yield()
        #expect(await receivesNothingMore(task))
    }

    @Test("保留中に自分の途中結果が書き換わると、新しいほうで保留し直され、上限は最初の到着から数えたまま延びない")
    func rewriteDuringHoldKeepsOriginalLimit() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let durations = DurationLog()
        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        // 上限には到達させない。要求された待ち時間を記録してから合図を送るので、合図を待てば記録はアサーションより前に終わる。
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let marker = DuplicateMarker(sleep: { duration in
            durations.append(duration)
            enteredContinuation.yield()
            try await Task.sleep(for: .seconds(60))
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(partialResult("マリ", 10, 11))
        // 1 本目のタイマーが要求した待ち時間の記録を確立してから書き換える。
        await awaitSignal(entered)
        mineContinuation.yield(partialResult("マリコ", 10, 11.5))
        mineContinuation.finish()

        let received = try await receiveTexts(task, count: 1)
        #expect(received == [try partialEvent(.自分, "マリコ", 10, 11.5, duplicate: false)])
        // 書き換えでタイマーが作り直されていれば、2 本目の待ち時間がここで記録される。
        // 増えないことの確認なので、`receivesNothingMore` と同じく有界で打ち切る。
        for _ in 0..<10 where durations.values.count < 2 { try await Task.sleep(for: .milliseconds(50)) }
        #expect(durations.values == [.seconds(1)])
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

        await marker.hold(minePartial: partialResult("マリ", 10, 11))
        await awaitSignal(entered)
        // 保留中に書き換わる（タイマーが作り直されないことは `rewriteDuringHoldKeepsOriginalLimit` で確認済み）。
        await marker.hold(minePartial: partialResult("マリコ", 10, 11.5))
        limitContinuation.yield()

        var decisions = marker.mineDecisions.makeAsyncIterator()
        let released = await decisions.next()
        #expect(released?.result == partialResult("マリコ", 10, 11.5))
        #expect(released?.duplicate == false)
        // 古い「マリ」が別に流れていないことを確かめる。
        await marker.finishMineDecisions()
        let rest = await decisions.next()
        #expect(rest == nil)
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
        await awaitSignal(entered)
        failingContinuation.finish(throwing: TrackFailure())
        _ = try? await relaying.value

        #expect(await receivesNothingMore(task))
    }

    @Test("エラーでキャンセルされたら、保留中の自分の途中結果は送られず、relay はそのエラーで終わる")
    func cancelledHeldPartialIsNotBroadcast() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (failing, failingContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        // 途中結果が保留に入った合図。上限には達させない。
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, failing)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        // 保留に入ってから相手を失敗させ、キャンセルが保留の最中に起きる状態にする。
        mineContinuation.yield(partialResult("明日の会議は十時", 10.5, 12))
        await awaitSignal(entered)
        failingContinuation.finish(throwing: TrackFailure())

        do {
            try await relaying.value
            Issue.record("エラーで終わるはずが、正常に戻った")
        } catch let error as TrackFailure {
            #expect(error == TrackFailure())
        }
        #expect(await receivesNothingMore(task))
    }

    @Test("どちらの流れも正常に終わるとき、保留中の自分の途中結果はちょうど 1 回流れる")
    func heldPartialIsBroadcastOnceWhenStreamsFinish() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        try await relay(
            tracks: [(.自分, finishedStream([partialResult("明日の", 3, 4)])), (.相手, finishedStream([]))],
            to: server, duplicates: DuplicateMarker())

        let received = try await receiveTexts(task, count: 1)
        #expect(received == [try partialEvent(.自分, "明日の", 3, 4, duplicate: false)])
        #expect(await receivesNothingMore(task))
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
