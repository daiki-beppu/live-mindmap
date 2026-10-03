import Foundation
import Testing
import HelperCore

@Suite("結果の転送", .timeLimit(.minutes(1)))
struct RelayTests {
    @Test("途中結果と確定結果が、イベントとして接続先に届く")
    func resultsReachClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        for _ in 0..<100 where await server.clientCount != 1 { try await Task.sleep(for: .milliseconds(50)) }

        let results = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.yield(TranscriptionResult(text: "こんに", isFinal: false, start: 0, end: 1))
            continuation.yield(TranscriptionResult(text: "こんにちは", isFinal: true, start: 0, end: 2))
            continuation.finish()
        }
        try await relay(results, track: .相手, to: server, duplicates: nil)

        var received: [String] = []
        for _ in 0..<2 {
            guard case .string(let text) = try await task.receive() else { Issue.record("テキストフレームでない"); return }
            received.append(text)
        }
        let expected = [
            try HelperEvent.partial(track: .相手, start: 0, end: 1, text: "こんに").jsonString(),
            try HelperEvent.remark(track: .相手, start: 0, end: 2, text: "こんにちは", duplicate: false).jsonString(),
        ]
        #expect(received == expected)
    }
}

// 複数トラックの並行転送。自分（マイク）と相手（プロセスタップ）の結果を、1 つの接続先へ同じ形で流す。

private struct TrackFailure: Error, Equatable {}

private final class TerminationFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
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

@Suite("複数トラックの転送", .timeLimit(.minutes(1)))
struct MultiTrackRelayTests {
    @Test("自分と相手の結果が、トラック違いの同じ形のイベントとして 1 つの接続先に届く")
    func bothTracksReachSameClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let mine = finishedStream([
            TranscriptionResult(text: "は", isFinal: false, start: 0, end: 1),
            TranscriptionResult(text: "はい", isFinal: true, start: 0.5, end: 1.5),
        ])
        let theirs = finishedStream([
            TranscriptionResult(text: "こんに", isFinal: false, start: 0, end: 1),
            TranscriptionResult(text: "こんにちは", isFinal: true, start: 0.25, end: 2),
        ])
        try await relay(tracks: [(.自分, mine), (.相手, theirs)], to: server, duplicates: nil)

        let received = try await receiveTexts(task, count: 4)
        let expectedMine = [
            try HelperEvent.partial(track: .自分, start: 0, end: 1, text: "は").jsonString(),
            try HelperEvent.remark(track: .自分, start: 0.5, end: 1.5, text: "はい", duplicate: false).jsonString(),
        ]
        let expectedTheirs = [
            try HelperEvent.partial(track: .相手, start: 0, end: 1, text: "こんに").jsonString(),
            try HelperEvent.remark(track: .相手, start: 0.25, end: 2, text: "こんにちは", duplicate: false).jsonString(),
        ]
        // トラック間の到着順は決まっていない。同じトラックの中の順序だけが保たれる。
        #expect(Set(received) == Set(expectedMine + expectedTheirs))
        #expect(received.filter(expectedMine.contains) == expectedMine)
        #expect(received.filter(expectedTheirs.contains) == expectedTheirs)
    }

    @Test("一方のトラックが先に正常に終わっても、もう一方は流れ続ける")
    func otherTrackKeepsRunningAfterOneFinishes() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let task = try await connect(to: server, port: port)
        defer { task.cancel(with: .goingAway, reason: nil) }

        let finishedEarly = finishedStream([])
        let late = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            Task {
                try? await Task.sleep(for: .milliseconds(300))
                continuation.yield(TranscriptionResult(text: "あとから", isFinal: true, start: 1, end: 2))
                continuation.finish()
            }
        }
        try await relay(tracks: [(.自分, finishedEarly), (.相手, late)], to: server, duplicates: nil)

        let received = try await receiveTexts(task, count: 1)
        #expect(received == [try HelperEvent.remark(track: .相手, start: 1, end: 2, text: "あとから", duplicate: false).jsonString()])
    }

    @Test("一方のトラックがエラーで終わったら、そのエラーを返し、終わらないもう一方の流れも終わる")
    func errorFromOneTrackStopsTheOther() async throws {
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        defer { Task { await server.stop() } }

        let terminated = TerminationFlag()
        let neverEnding = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.onTermination = { _ in terminated.set() }
        }
        let failing = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.finish(throwing: TrackFailure())
        }

        do {
            try await relay(tracks: [(.自分, failing), (.相手, neverEnding)], to: server, duplicates: nil)
            Issue.record("エラーで終わるはずが、正常に戻った")
        } catch let error as TrackFailure {
            #expect(error == TrackFailure())
        }

        for _ in 0..<100 where !terminated.isSet { try await Task.sleep(for: .milliseconds(50)) }
        #expect(terminated.isSet)
    }

    @Test("エラーで終わるのが相手側でも、そのエラーを返し、自分側も終わる")
    func errorFromSecondTrackStopsTheFirst() async throws {
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        defer { Task { await server.stop() } }

        let terminated = TerminationFlag()
        let neverEnding = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.onTermination = { _ in terminated.set() }
        }
        let failing = AsyncThrowingStream<TranscriptionResult, Error> { continuation in
            continuation.finish(throwing: TrackFailure())
        }

        do {
            try await relay(tracks: [(.自分, neverEnding), (.相手, failing)], to: server, duplicates: nil)
            Issue.record("エラーで終わるはずが、正常に戻った")
        } catch let error as TrackFailure {
            #expect(error == TrackFailure())
        }

        for _ in 0..<100 where !terminated.isSet { try await Task.sleep(for: .milliseconds(50)) }
        #expect(terminated.isSet)
    }
}
