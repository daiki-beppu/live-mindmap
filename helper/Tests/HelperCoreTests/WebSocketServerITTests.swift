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
struct WebSocketServerITTests {
    @Test("接続したクライアントが broadcast したテキストをテキストフレームで受け取る")
    func clientReceivesBroadcast() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)

        let json = try HelperEvent.partial(track: .相手, start: 1, end: 2, text: "こんに", duplicate: false).jsonString()
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

        let expected = try ["あ", "あい", "あいう"].map { try HelperEvent.partial(track: .相手, start: 0, end: 1, text: $0, duplicate: false).jsonString() }
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

    // Issue #161: 原点のイベントは、ヘルパーが起動した直後（接続より前）に決まることが多く、
    // 通常の broadcast だとクライアント不在時に失われる（要件 #58）。保持して、後から接続したクライアントにも送る
    @Test("broadcastRetained で送った内容を、後から接続したクライアントにも送る（register の受信開始より前に届く）")
    func broadcastRetainedReachesLateJoiningClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let json = try HelperEvent.origin(hostTime: 9_007_199_254_740_993).jsonString()
        await server.broadcastRetained(json) // まだ誰も接続していない

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }

        #expect(try await receiveText(task) == json)
    }

    @Test("broadcastRetained は、すでに接続しているクライアントにも通常の broadcast と同じく届く")
    func broadcastRetainedReachesConnectedClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)

        let json = try HelperEvent.origin(hostTime: 1).jsonString()
        await server.broadcastRetained(json)
        #expect(try await receiveText(task) == json)
    }

    // Issue #278: 共有画面の `screen` も原点と同じく、接続前に出た分を覚えて、後から接続したクライアントに送る。
    // 覚えるのは種類ごとに最新の 1 件（画像を何枚も溜めない）。接続した直後は、最初に覚えた種類の順（origin → screen）に届く
    @Test("種類ごとに最新の 1 件だけを覚え、後から接続したクライアントには origin → 最後の screen の順で届く（古い screen は届かない）")
    func retainedKeepsLatestPerKindForLateJoiningClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let origin = try HelperEvent.origin(hostTime: 42).jsonString()
        let older = try HelperEvent.screen(start: 1, image: "b2xkZXI=").jsonString()
        let latest = try HelperEvent.screen(start: 2, image: "bGF0ZXN0").jsonString()
        await server.broadcastRetained(origin, key: "origin")
        await server.broadcastRetained(older, key: "screen")
        await server.broadcastRetained(latest, key: "screen") // まだ誰も接続していない

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }

        #expect(try await receiveText(task) == origin)
        #expect(try await receiveText(task) == latest)

        // 古い screen が後ろに残っていないこと: 次に届くのは、その後に broadcast した内容
        let marker = try HelperEvent.partial(track: .相手, start: 3, end: 4, text: "次", duplicate: false).jsonString()
        await server.broadcast(marker)
        #expect(try await receiveText(task) == marker)
    }

    @Test("screen を覚えても、origin は上書きされず、origin だけ覚えていても screen は届かない")
    func retainedKindsDoNotOverwriteEachOther() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let origin = try HelperEvent.origin(hostTime: 7).jsonString()
        await server.broadcastRetained(origin, key: "origin")

        let first = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        first.resume()
        defer { first.cancel(with: .goingAway, reason: nil) }
        #expect(try await receiveText(first) == origin)
        try await waitForClients(server, count: 1)

        // 接続した後に覚えさせた screen は、つながっているクライアントにも届き、origin はそのまま残る
        let screen = try HelperEvent.screen(start: 5, image: "c2NyZWVu").jsonString()
        await server.broadcastRetained(screen, key: "screen")
        #expect(try await receiveText(first) == screen)

        let second = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        second.resume()
        defer { second.cancel(with: .goingAway, reason: nil) }
        #expect(try await receiveText(second) == origin)
        #expect(try await receiveText(second) == screen)
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
