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
        try await relay(results, track: .相手, to: server)

        var received: [String] = []
        for _ in 0..<2 {
            guard case .string(let text) = try await task.receive() else { Issue.record("テキストフレームでない"); return }
            received.append(text)
        }
        let expected = [
            try HelperEvent.partial(track: .相手, text: "こんに").jsonString(),
            try HelperEvent.remark(track: .相手, start: 0, end: 2, text: "こんにちは", duplicate: false).jsonString(),
        ]
        #expect(received == expected)
    }
}
