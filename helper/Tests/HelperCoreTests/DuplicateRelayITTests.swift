import Foundation
import Testing
import HelperCore

private typealias Support = DuplicateMarkerTestSupport

private struct TrackFailure: Error, Equatable {}

private final class TerminationFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

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

private func remark(_ track: Track, _ text: String, _ start: Double, _ end: Double, duplicate: Bool) throws -> String {
    try HelperEvent.remark(track: track, start: start, end: end, text: text, duplicate: duplicate, words: transcriptWords(text), wordTimes: []).jsonString()
}

private func partialEvent(_ track: Track, _ text: String, _ start: Double, _ end: Double, duplicate: Bool) throws -> String {
    try HelperEvent.partial(track: track, start: start, end: end, text: text, duplicate: duplicate, words: transcriptWords(text), wordTimes: []).jsonString()
}

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
    await Support.awaitSignal(entered)
    limitContinuation.yield()
    let released = try await receiveTexts(task, count: 1)

    theirsContinuation.yield(theirFinal)
    let rest = try await receiveTexts(task, count: 1)
    return (released[0], rest)
}

@Suite("重複の印を付ける転送", .timeLimit(.minutes(1)))
struct DuplicateRelayITTests {
    @Test("同じ時間帯の相手と重なる自分の確定結果に印が付き、相手の確定結果には付かない")
    func marksOverlappingRemark() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = finishedStream([Support.final(Support.sentence, 10.5, 14.5)])
        let theirs = finishedStream([Support.final(Support.sentence, 10, 14)])
        try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: DuplicateMarker())

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try remark(.自分, Support.sentence, 10.5, 14.5, duplicate: true),
            try remark(.相手, Support.sentence, 10, 14, duplicate: false),
        ])
    }

    @Test("後から届く相手の確定結果と重なる自分の確定結果にも印が付く（後 8 秒を待つ）")
    func waitsForLaterTheirRemark() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = finishedStream([Support.final(Support.sentence, 10, 13)])
        let theirs = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            Task {
                try? await Task.sleep(for: .milliseconds(300))
                continuation.yield(Support.final(Support.sentence, 11, 14))
                continuation.finish()
            }
        }
        try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: DuplicateMarker())

        let received = try await receiveTexts(task, count: 2)
        #expect(received.contains(try remark(.自分, Support.sentence, 10, 13, duplicate: true)))
    }

    @Test("印の有無にかかわらず自分の確定結果は全件、トラック内の順序のまま流れる")
    func keepsEveryRemarkInOrder() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = finishedStream([
            Support.final(Support.other, 0, 2),
            Support.final(Support.sentence, 20, 23),
            Support.final("了解です、少し確認します", 24, 26),
        ])
        let theirs = finishedStream([Support.final(Support.sentence, 20, 23)])
        try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: DuplicateMarker())

        let received = try await receiveTexts(task, count: 4)
        let expectedMine = [
            try remark(.自分, Support.other, 0, 2, duplicate: false),
            try remark(.自分, Support.sentence, 20, 23, duplicate: true),
            try remark(.自分, "了解です、少し確認します", 24, 26, duplicate: false),
        ]
        #expect(received.filter(expectedMine.contains) == expectedMine)
        #expect(received.contains(try remark(.相手, Support.sentence, 20, 23, duplicate: false)))
    }

    @Test("判定器がない（イヤホンなど）ときは、重なる入力でも印を付けない")
    func noMarkerNeverMarks() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = finishedStream([Support.final(Support.sentence, 10.5, 14.5)])
        let theirs = finishedStream([Support.final(Support.sentence, 10, 14)])
        try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: nil)

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try remark(.自分, Support.sentence, 10.5, 14.5, duplicate: false),
            try remark(.相手, Support.sentence, 10, 14, duplicate: false),
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
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))
        await Support.awaitSignal(entered)

        theirsContinuation.yield(Support.partialResult(Support.sentence, 10, 13))

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try partialEvent(.相手, Support.sentence, 10, 13, duplicate: false),
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

        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))
        await Support.awaitSignal(entered)

        theirsContinuation.yield(Support.partialResult(Support.other, 40, 43))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.相手, Support.other, 40, 43, duplicate: false)])

        theirsContinuation.yield(Support.partialResult(Support.sentence, 10, 13))
        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try partialEvent(.相手, Support.sentence, 10, 13, duplicate: false),
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

        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))
        await Support.awaitSignal(entered)

        theirsContinuation.yield(Support.final(Support.sentence, 10, 13))

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try remark(.相手, Support.sentence, 10, 13, duplicate: false),
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

        let durations = Support.DurationLog()
        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { mineContinuation.finish() }
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
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

        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))
        await Support.awaitSignal(entered)
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
        let marker = DuplicateMarker(sleep: { _ in })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false)])

        theirsContinuation.yield(Support.partialResult(Support.sentence, 10, 13))

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try partialEvent(.相手, Support.sentence, 10, 13, duplicate: false),
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
        let marker = DuplicateMarker(sleep: { _ in })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false)])

        theirsContinuation.yield(Support.final(Support.sentence, 10, 13))

        let received = try await receiveTexts(task, count: 2)
        #expect(Set(received) == [
            try remark(.相手, Support.sentence, 10, 13, duplicate: false),
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

        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false)])

        mineContinuation.yield(Support.final(Support.other, 20, 22))
        #expect(try await receiveTexts(task, count: 1) == [try remark(.自分, Support.other, 20, 22, duplicate: false)])

        theirsContinuation.yield(Support.partialResult(Support.sentence, 10, 13))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.相手, Support.sentence, 10, 13, duplicate: false)])
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
        let marker = DuplicateMarker(sleep: { duration in
            guard duration == .seconds(1) else { return }
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))
        await Support.awaitSignal(entered)

        mineContinuation.yield(Support.final(Support.other, 20, 22))
        #expect(try await receiveTexts(task, count: 2) == [
            try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: false),
            try remark(.自分, Support.other, 20, 22, duplicate: false),
        ])

        limitContinuation.yield()
        theirsContinuation.yield(Support.partialResult(Support.sentence, 10, 13))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.相手, Support.sentence, 10, 13, duplicate: false)])
        #expect(await receivesNothingMore(task))
    }

    @Test("相手の流れが終わった後でも、同じ発話の自分の途中結果は確定結果より先に届く")
    func broadcastsPartialBeforeRemarkForSameUtterance() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let marker = DuplicateMarker()
        try await relay(finishedStream([]), track: .相手, to: server, duplicates: marker)
        try await relay(
            finishedStream([Support.partialResult("明日の会議は十時", 10.5, 12), Support.final("明日の会議は十時", 10.5, 12)]),
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
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        theirsContinuation.yield(Support.final(Support.sentence, 11.2, 15))
        #expect(try await receiveTexts(task, count: 1) == [try remark(.相手, Support.sentence, 11.2, 15, duplicate: false)])

        mineContinuation.yield(Support.partialResult(Support.sentence, 10, 11))
        await Support.awaitSignal(entered)

        mineContinuation.yield(Support.partialResult(Support.sentence, 10, 11.5))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, Support.sentence, 10, 11.5, duplicate: true)])

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

        let durations = Support.DurationLog()
        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        defer { theirsContinuation.finish() }
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let marker = DuplicateMarker(sleep: { duration in
            durations.append(duration)
            enteredContinuation.yield()
            try await Task.sleep(for: .seconds(60))
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(Support.partialResult("マリ", 10, 11))
        await Support.awaitSignal(entered)
        mineContinuation.yield(Support.partialResult("マリコ", 10, 11.5))
        mineContinuation.finish()

        let received = try await receiveTexts(task, count: 1)
        #expect(received == [try partialEvent(.自分, "マリコ", 10, 11.5, duplicate: false)])
        for _ in 0..<10 where durations.values.count < 2 { try await Task.sleep(for: .milliseconds(50)) }
        #expect(durations.values == [.seconds(1)])
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

        mineContinuation.yield(Support.final(Support.other, 0, 2))
        theirsContinuation.yield(Support.partialResult(Support.sentence, 10, 13))
        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.相手, Support.sentence, 10, 13, duplicate: false)])
        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))

        #expect(try await receiveTexts(task, count: 1) == [try partialEvent(.自分, "明日の会議は十時", 10.5, 12, duplicate: true)])
    }

    @Test("相手の途中結果・確定結果とほぼ同じ自分の途中結果は印付き、違う内容は印なしで流れる。相手の途中結果は印なし")
    func marksPartialsAgainstTheirs() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let marker = DuplicateMarker()
        let theirs = finishedStream([Support.partialResult(Support.sentence, 10, 13), Support.final(Support.other, 30, 33)])
        try await relay(theirs, track: .相手, to: server, duplicates: marker)
        let mine = finishedStream([
            Support.partialResult("明日の会議は十時", 10.5, 12),
            Support.partialResult("了解です、少し確認します", 10.5, 12),
            Support.partialResult("来週の火曜日に資料", 31, 32),
        ])
        try await relay(mine, track: .自分, to: server, duplicates: marker)

        let received = try await receiveTexts(task, count: 5)
        #expect(received == [
            try partialEvent(.相手, Support.sentence, 10, 13, duplicate: false),
            try remark(.相手, Support.other, 30, 33, duplicate: false),
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

        try await relay(finishedStream([Support.partialResult(Support.sentence, 10, 13)]), track: .相手, to: server, duplicates: nil)
        try await relay(finishedStream([Support.partialResult(Support.sentence, 10.5, 13)]), track: .自分, to: server, duplicates: nil)

        let received = try await receiveTexts(task, count: 2)
        #expect(received == [
            try partialEvent(.相手, Support.sentence, 10, 13, duplicate: false),
            try partialEvent(.自分, Support.sentence, 10.5, 13, duplicate: false),
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
            continuation.yield(Support.final(Support.sentence, 0, 2))
        }
        let theirs = AsyncThrowingStream<TranscriptionResult, Error> { _ in }
        let marker = DuplicateMarker(sleep: { _ in })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        let received = try await receiveTexts(task, count: 1)
        #expect(received == [try remark(.自分, Support.sentence, 0, 2, duplicate: false)])
    }

    @Test("相手の確定結果が保留の上限より後に届いても、相手が話している途中結果と同じ自分の確定結果には印が付く（Issue の 1 件目）")
    func marksRemarkWhenTheirFinalArrivesAfterHoldLimitCase1() async throws {
        let theirPartialText = "じゃあ始めましょうか。今日は最近使ってよかったものを"
        let result = try await relayRemarkReleasedBeforeTheirFinal(
            theirPartial: Support.partialResult(theirPartialText, 2.9, 15.6),
            mine: Support.final("じゃあ始めましょう", 3.1, 6.7),
            theirFinal: Support.final("じゃあ始めましょうか。今日は最近使ってよかったものを", 2.9, 15.9))

        #expect(result.releasedRemark == (try remark(.自分, "じゃあ始めましょう", 3.1, 6.7, duplicate: true)))
        #expect(result.rest == [try remark(.相手, "じゃあ始めましょうか。今日は最近使ってよかったものを", 2.9, 15.9, duplicate: false)])
    }

    @Test("相手の確定結果が保留の上限より後に届いても、相手が話している途中結果と同じ自分の確定結果には印が付く（Issue の 2 件目）")
    func marksRemarkWhenTheirFinalArrivesAfterHoldLimitCase2() async throws {
        let result = try await relayRemarkReleasedBeforeTheirFinal(
            theirPartial: Support.partialResult("あともう一つおすすめの本があって", 57.9, 70),
            mine: Support.final("もう一つ", 58.1, 61.2),
            theirFinal: Support.final("あともう一つおすすめの本があって", 57.9, 74.7))

        #expect(result.releasedRemark == (try remark(.自分, "もう一つ", 58.1, 61.2, duplicate: true)))
        #expect(result.rest == [try remark(.相手, "あともう一つおすすめの本があって", 57.9, 74.7, duplicate: false)])
    }

    @Test("相手の確定結果が保留の上限より後に届くとき、相手の途中結果と内容が違う自分の確定結果には印が付かない")
    func doesNotMarkDifferentRemarkWhenTheirFinalArrivesAfterHoldLimit() async throws {
        let result = try await relayRemarkReleasedBeforeTheirFinal(
            theirPartial: Support.partialResult("じゃあ始めましょうか。今日は最近使ってよかったものを", 2.9, 15.6),
            mine: Support.final("了解です、少し確認します", 3.1, 6.7),
            theirFinal: Support.final("じゃあ始めましょうか。今日は最近使ってよかったものを", 2.9, 15.9))

        #expect(result.releasedRemark == (try remark(.自分, "了解です、少し確認します", 3.1, 6.7, duplicate: false)))
    }

    @Test("確定結果の判定でも、時間範囲が前後 8 秒の窓に重ならない古い相手の途中結果は文脈に入れない")
    func ignoresStaleTheirPartialForRemark() async throws {
        let result = try await relayRemarkReleasedBeforeTheirFinal(
            theirPartial: Support.partialResult(Support.sentence, 0, 3),
            mine: Support.final(Support.sentence, 40, 43),
            theirFinal: Support.final(Support.other, 41, 44))

        #expect(result.releasedRemark == (try remark(.自分, Support.sentence, 40, 43, duplicate: false)))
    }

    @Test("エラーでキャンセルされたら、保留中の自分の確定結果は送られない")
    func cancelledRemarkIsNotBroadcast() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.yield(Support.final(Support.sentence, 0, 2))
        }
        let (failing, failingContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let marker = DuplicateMarker(sleep: { duration in
            enteredContinuation.yield()
            try await Task.sleep(for: duration)
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, failing)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        await Support.awaitSignal(entered)
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
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (limit, limitContinuation) = AsyncStream.makeStream(of: Void.self)
        defer { limitContinuation.finish() }
        let marker = DuplicateMarker(sleep: { _ in
            enteredContinuation.yield()
            for await _ in limit { return }
        })
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, failing)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(Support.partialResult("明日の会議は十時", 10.5, 12))
        await Support.awaitSignal(entered)
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
            tracks: [(.自分, finishedStream([Support.partialResult("明日の", 3, 4)])), (.相手, finishedStream([]))],
            to: server, duplicates: DuplicateMarker())

        let received = try await receiveTexts(task, count: 1)
        #expect(received == [try partialEvent(.自分, "明日の", 3, 4, duplicate: false)])
        #expect(await receivesNothingMore(task))
    }

    @Test("保留中の自分の確定結果があっても、エラーで終わったらそのエラーを返し、もう一方の流れも終わる")
    func errorStopsOtherTrack() async throws {
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        defer { Task { await server.stop() } }

        let terminated = TerminationFlag()
        let mine = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.onTermination = { _ in terminated.set() }
            continuation.yield(Support.final(Support.sentence, 0, 2))
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

    @Test("重複の判定を通る自分の確定結果と途中結果にも、語の区間がそのまま載る")
    func mineResultsCarryWordTimesThroughDuplicateMarker() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let times = [WordTime(utf16Offset: 0, utf16Length: 3, start: 10.5, end: 11), WordTime(utf16Offset: 3, utf16Length: 2, start: 11, end: 11.5)]
        let mine = finishedStream([
            TranscriptionResult(text: "ありがと", isFinal: false, start: 10.5, end: 11.5, wordTimes: times),
            TranscriptionResult(text: "ありがとう", isFinal: true, start: 10.5, end: 11.5, wordTimes: times),
        ])
        try await relay(tracks: [(.自分, mine), (.相手, finishedStream([]))], to: server, duplicates: DuplicateMarker())

        let received = try await receiveTexts(task, count: 2)
        for text in received {
            let object = try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
            #expect(object["track"] as? String == "自分")
            let got = try #require(object["wordTimes"] as? [[String: Any]])
            #expect(NSArray(array: got).isEqual(to: [
                ["location": 0, "length": 3, "start": 10.5, "end": 11.0],
                ["location": 3, "length": 2, "start": 11.0, "end": 11.5],
            ]))
        }
    }

    @Test("relayMine は、自分の確定結果が届いた時刻を注入した時計で取る。前の発言の待ちの間に時計が進んだ分は、次の発言の待ちから引かれる")
    func relayMineTakesHeldSinceFromInjectedClock() async throws {
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        defer { Task { await server.stop() } }

        let clock = Support.AudioClock()
        clock.advance(to: 100)
        let durations = Support.DurationLog()
        let nowCalls = CallCounter()
        let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
        let (release, releaseContinuation) = AsyncStream.makeStream(of: Void.self)
        let marker = DuplicateMarker(
            sleep: { duration in
                durations.append(duration)
                enteredContinuation.yield()
                if durations.values.count == 1 { for await _ in release { return } }
            },
            now: { nowCalls.increment(); return clock.value })
        let (mine, mineContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        let (theirs, theirsContinuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self)
        let relaying = Task { try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: marker) }
        defer { relaying.cancel() }

        mineContinuation.yield(Support.final(Support.sentence, 90, 92))
        mineContinuation.yield(Support.final(Support.other, 93, 95))
        await Support.awaitSignal(entered)
        for _ in 0..<400 where nowCalls.value < 3 { try await Task.sleep(for: .milliseconds(25)) }
        clock.advance(to: 103)
        releaseContinuation.yield()
        await Support.awaitSignal(entered)

        let waits = durations.values.map(Support.seconds)
        mineContinuation.finish()
        theirsContinuation.finish()
        try await relaying.value
        try #require(waits.count == 2)
        #expect(abs(waits[0] - 8) < 0.001)
        #expect(abs(waits[1] - 5) < 0.001)
    }

}
