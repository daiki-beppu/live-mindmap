import Foundation
import Testing
import HelperCore

private func waitForClients(_ server: WebSocketServer, count: Int) async throws {
    for _ in 0..<100 {
        if await server.clientCount == count { return }
        try await Task.sleep(for: .milliseconds(50))
    }
    Issue.record("クライアント数が \(count) にならなかった: \(await server.clientCount)")
}

private func receiveText(_ task: URLSessionWebSocketTask) async throws -> String {
    switch try await task.receive() {
    case .string(let text): return text
    case .data: throw WebSocketTestError.binaryFrame
    @unknown default: throw WebSocketTestError.binaryFrame
    }
}

private enum WebSocketTestError: Error { case binaryFrame }

@Suite("localhost の WebSocket", .timeLimit(.minutes(1)))
struct WebSocketServerTests {
    @Test("接続したクライアントが broadcast したテキストをテキストフレームで受け取る")
    func clientReceivesBroadcast() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)

        let json = try HelperEvent.partial(track: .相手, start: 1, end: 2, text: "こんに").jsonString()
        await server.broadcast(json)
        #expect(try await receiveText(task) == json)
    }

    @Test("接続中の全クライアントに同じイベントが届く")
    func broadcastReachesEveryClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let url = URL(string: "ws://127.0.0.1:\(port)")!
        let first = URLSession.shared.webSocketTask(with: url)
        let second = URLSession.shared.webSocketTask(with: url)
        first.resume()
        second.resume()
        defer {
            first.cancel(with: .goingAway, reason: nil)
            second.cancel(with: .goingAway, reason: nil)
        }
        try await waitForClients(server, count: 2)

        let json = try HelperEvent.remark(track: .相手, start: 1, end: 2, text: "了解です", duplicate: false).jsonString()
        await server.broadcast(json)
        #expect(try await receiveText(first) == json)
        #expect(try await receiveText(second) == json)
    }

    @Test("イベントは broadcast した順に届く")
    func preservesOrder() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)

        let expected = try ["あ", "あい", "あいう"].map { try HelperEvent.partial(track: .相手, start: 0, end: 1, text: $0).jsonString() }
        for json in expected { await server.broadcast(json) }
        var received: [String] = []
        for _ in expected { received.append(try await receiveText(task)) }
        #expect(received == expected)
    }

    @Test("クライアントがいなくても broadcast は失敗しない")
    func broadcastWithoutClients() async throws {
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        await server.broadcast("{}")
        #expect(await server.clientCount == 0)
        await server.stop()
    }

    @Test("切断したクライアントは一覧から外れる")
    func disconnectedClientIsRemoved() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        try await waitForClients(server, count: 1)
        task.cancel(with: .goingAway, reason: nil)
        try await waitForClients(server, count: 0)
    }

    @Test("stop の後は新しい接続を受け付けない（listener を cancel する）")
    func stopRefusesNewConnections() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        await server.stop()

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        await #expect(throws: (any Error).self) { try await task.receive() }
        #expect(await server.clientCount == 0)
    }

    @Test("接続中のクライアントがいる状態で stop すると、接続が閉じて clientCount が 0 になる")
    func stopClosesConnectedClients() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)

        await server.stop()
        #expect(await server.clientCount == 0)
        await #expect(throws: (any Error).self) { try await task.receive() }
    }
}
