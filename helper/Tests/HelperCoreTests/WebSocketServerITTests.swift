import Foundation
import Testing
@testable import HelperCore

private func waitForClients(_ server: WebSocketServer, count: Int) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while await server.clientCount != count {
        if ContinuousClock.now >= deadline {
            throw WebSocketTestError.clientCountTimedOut(expected: count, actual: await server.clientCount)
        }
        try await Task.sleep(for: .milliseconds(20))
    }
}

private func receiveText(_ task: URLSessionWebSocketTask) async throws -> String {
    switch try await task.receive() {
    case .string(let text): return text
    case .data: throw WebSocketTestError.binaryFrame
    @unknown default: throw WebSocketTestError.binaryFrame
    }
}

private enum WebSocketTestError: Error {
    case binaryFrame
    case clientCountTimedOut(expected: Int, actual: Int)
}

private func markerEvent() -> HelperEvent {
    .partial(track: .相手, start: 99, end: 100, text: "marker", duplicate: false, words: [], wordTimes: [])
}

private final class SendDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func write(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        lines.append(line)
    }

    var text: String {
        lock.lock()
        defer { lock.unlock() }
        return lines.joined(separator: "\n")
    }
}

/// 別 Task で動く待ちが終わったかを、期限付きで確かめるための印
private actor Completion {
    private(set) var done = false
    func mark() { done = true }

    /// 終わるまで、最大 `seconds` 秒待つ。終われば true
    func finishes(within seconds: Double) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !done, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
        return done
    }
}

@Suite("localhost の WebSocket", .timeLimit(.minutes(1)))
struct WebSocketServerITTests {
    @Test("初回接続では保持枠を表の順に送り、その後に接続前の発言・話者イベントを送信順で届ける")
    func firstClientReceivesRetainedTableThenBufferedEvents() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let retained: [HelperEvent] = [
            .origin(hostTime: 42),
            .screen(start: 2, image: "latest", lines: []),
            .screenOff(start: 3, reason: .許可なし),
            .tapSilent(start: 10),
            .selfPause(paused: true, reason: .manual, start: 3),
            .selfPauseState(.initial),
            .speakerOff(start: 1, reason: .モデルなし),
            .fileDuration(duration: 120),
            .fileAudioTracks(count: 2),
        ]
        let buffered: [HelperEvent] = [
            .partial(track: .相手, start: 0, end: 1, text: "途中", duplicate: false, words: [], wordTimes: []),
            .speaker(track: .相手, start: 0, end: 1, slot: 0, isFinal: true),
            .remark(track: .相手, start: 0, end: 1, text: "発言", duplicate: false, words: [], wordTimes: []),
            .speakerSettled(track: .相手, to: 1),
            .speakerMixed(track: .相手, slot: 0, start: 1),
            .speakerCentroid(track: .相手, slot: 0, centroid: [1, 0]),
        ]
        // 登録順や蓄積順をそのまま再送する実装を区別する。
        for (index, event) in retained.reversed().enumerated() {
            await server.send(event)
            if index < buffered.count { await server.send(buffered[index]) }
        }
        let first = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        first.resume()
        defer { first.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)
        await server.send(markerEvent())
        for event in retained + buffered + [markerEvent()] {
            #expect(try await receiveText(first) == event.jsonString())
        }

        let second = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        second.resume()
        defer { second.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 2)
        await server.send(markerEvent())
        for event in retained + [markerEvent()] {
            #expect(try await receiveText(second) == event.jsonString())
        }
    }

    @Test("同じserverで初回配送後に全接続が切れても、通常イベントの蓄積を再開しない")
    func disconnectedServerDoesNotBufferAgain() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let url = URL(string: "ws://127.0.0.1:\(port)")!
        let origin = HelperEvent.origin(hostTime: 42)
        let before = HelperEvent.speakerSettled(track: .相手, to: 1)
        await server.send(origin)
        await server.send(before)
        let first = URLSession.shared.webSocketTask(with: url)
        first.resume()
        defer { first.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)
        #expect(try await receiveText(first) == origin.jsonString())
        #expect(try await receiveText(first) == before.jsonString())
        first.cancel(with: .goingAway, reason: nil)
        try await waitForClients(server, count: 0)
        await server.send(.speakerSettled(track: .相手, to: 2))
        let latest = HelperEvent.origin(hostTime: 43)
        await server.send(latest)

        let second = URLSession.shared.webSocketTask(with: url)
        second.resume()
        defer { second.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)
        await server.send(markerEvent())
        #expect(try await receiveText(second) == latest.jsonString())
        #expect(try await receiveText(second) == markerEvent().jsonString())
    }

    @Test("エンコード失敗は種類を診断へ書いて一件だけ捨て、正常な後続を送る", arguments: [false, true])
    func encodingFailureDoesNotStopDelivery(_ connected: Bool) async throws {
        let diagnostics = SendDiagnostics()
        let server = WebSocketServer(port: 0, writeStderr: { diagnostics.write($0) })
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let client = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        defer { client.cancel(with: .goingAway, reason: nil) }
        if connected {
            client.resume()
            try await waitForClients(server, count: 1)
        }
        let duration = HelperEvent.fileDuration(duration: 120)
        await server.send(duration)
        await server.send(.fileDuration(duration: .infinity))
        await server.send(.partial(track: .相手, start: .nan, end: 1, text: "invalid", duplicate: false, words: [], wordTimes: []))
        await server.send(markerEvent())
        if !connected {
            client.resume()
            try await waitForClients(server, count: 1)
        }
        #expect(try await receiveText(client) == duration.jsonString())
        #expect(try await receiveText(client) == markerEvent().jsonString())
        #expect(diagnostics.text.contains("file-duration") || diagnostics.text.contains("fileDuration"))
        #expect(diagnostics.text.contains("partial"))
    }

    @Test("初回接続前の蓄積があってもwaitUntilSentは接続を待たずに戻る")
    func bufferedEventsDoNotBlockWaitUntilSent() async throws {
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        defer { Task { await server.stop() } }
        await server.send(markerEvent())
        let completion = Completion()
        let waiting = Task { await server.waitUntilSent(); await completion.mark() }
        defer { waiting.cancel() }
        #expect(await completion.finishes(within: 5))
    }

    @Test("closeで確定した保留画像は、配送タスク完了直後にサーバーを止めても最後まで届く")
    func closingRelayFinishesPendingScreenSends() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let emitter = ScreenEventEmitter(bundleID: "com.google.Chrome", writeStderr: { _ in })
        let relay = Task { await relayScreenEvents(emitter.events, to: server) }
        defer { emitter.close() }
        let client = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        client.maximumMessageSize = 2 * 1024 * 1024
        client.resume()
        defer { client.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)
        let receiving = Task {
            var received: [String] = []
            for _ in 0..<4 { received.append(try await receiveText(client)) }
            return received
        }
        defer { receiving.cancel() }

        // 小さいフレームだけでは、送信登録とstopの間に送信が完了してしまう。
        let image = String(repeating: "A", count: 1024 * 1024)
        for (time, value) in [(0.0, UInt8(30)), (1, 200), (15, 200), (16, 30), (30, 30), (31, 200), (45, 200)] {
            emitter.emit(ScreenFrame(luma: [UInt8](repeating: value, count: screenGridWidth * screenGridHeight), time: time, title: "Gmail")) {
                ScreenShot(image: image, lines: ["Gmail OCR"])
            }
        }
        emitter.close()
        await relay.value
        await server.stop()
        let expected = try [0.0, 1, 16, 31].map { try HelperEvent.screen(start: $0, image: image, lines: ["Gmail OCR"]).jsonString() }
        #expect(try await receiving.value == expected)
    }

    @Test("仮画像は接続中へ配送し、後続接続には復帰または継続中の最新画面を再送する", arguments: [false, true])
    func delayedProvisionalImageKeepsLatestRetainedScreen(_ returnsToGmail: Bool) async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let emitter = ScreenEventEmitter(bundleID: "com.google.Chrome", writeStderr: { _ in })
        let relay = Task { await relayScreenEvents(emitter.events, to: server) }
        defer { emitter.close() }
        let url = URL(string: "ws://127.0.0.1:\(port)")!
        let first = URLSession.shared.webSocketTask(with: url)
        first.resume()
        defer { first.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)
        for (time, title, value, image) in [(0.0, "Gmail", UInt8(30), "gmail"), (1, "Meet - abc", 200, "meet"), (2, "Meet - abc", 200, "unused")] {
            emitter.emit(ScreenFrame(luma: [UInt8](repeating: value, count: screenGridWidth * screenGridHeight), time: time, title: title)) {
                ScreenShot(image: image, lines: [image + " OCR"])
            }
        }
        for time in stride(from: 60.0, through: 80, by: 0.25) {
            emitter.emit(ScreenFrame(luma: [UInt8](repeating: returnsToGmail ? 30 : 200, count: screenGridWidth * screenGridHeight), time: time, title: returnsToGmail ? "Gmail" : "Meet - abc")) {
                ScreenShot(image: "gmail-return", lines: ["gmail-return OCR"])
            }
        }
        emitter.close()
        await relay.value
        let meet = HelperEvent.screen(start: 1, image: "meet", lines: ["meet OCR"])
        #expect(try await receiveText(first) == meet.jsonString())
        #expect(try await receiveText(first) == HelperEvent.screen(start: 0, image: "gmail", lines: ["gmail OCR"]).jsonString())
        let latest = returnsToGmail ? HelperEvent.screen(start: 60, image: "gmail-return", lines: ["gmail-return OCR"]) : meet
        if returnsToGmail { #expect(try await receiveText(first) == latest.jsonString()) }
        let late = URLSession.shared.webSocketTask(with: url)
        late.resume()
        defer { late.cancel(with: .goingAway, reason: nil) }
        #expect(try await receiveText(late) == latest.jsonString())
        try await waitForClients(server, count: 2)
        await server.send(markerEvent())
        #expect(try await receiveText(first) == markerEvent().jsonString())
        #expect(try await receiveText(late) == markerEvent().jsonString())
    }

    @Test("画像とnullはstartで保持を選び、同時刻は到着順、他の保持枠は維持する", arguments: [0.0, 1, 2], [false, true])
    func screenRetentionUsesStart(_ start: Double, _ absent: Bool) async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }
        let origin = HelperEvent.origin(hostTime: 42)
        await server.send(origin)
        let old = HelperEvent.screen(start: 1, image: "first", lines: ["first OCR"])
        let arriving = HelperEvent.screen(start: start, image: absent ? nil : "arriving", lines: absent ? nil : ["arriving OCR"])
        let off = HelperEvent.screenOff(start: 3, reason: .許可なし)
        await server.send(old)
        await server.send(arriving)
        if absent && start >= 1 {
            await server.send(.screen(start: 0, image: "delayed", lines: ["delayed OCR"]))
        }
        await server.send(off)
        let late = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        late.resume()
        defer { late.cancel(with: .goingAway, reason: nil) }
        #expect(try await receiveText(late) == origin.jsonString())
        #expect(try await receiveText(late) == (start < 1 ? old : arriving).jsonString())
        #expect(try await receiveText(late) == off.jsonString())
        try await waitForClients(server, count: 1)
        await server.send(markerEvent())
        #expect(try await receiveText(late) == markerEvent().jsonString())
    }

    @Test("接続したクライアントが send したイベントをテキストフレームで受け取る")
    func clientReceivesEvent() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)

        let event = HelperEvent.partial(track: .相手, start: 1, end: 2, text: "こんに", duplicate: false, words: transcriptWords("こんに"), wordTimes: [])
        await server.send(event)
        #expect(try await receiveText(task) == event.jsonString())
    }

    @Test("接続中の全クライアントに同じイベントが届く")
    func sendReachesEveryClient() async throws {
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

        let event = HelperEvent.remark(track: .相手, start: 1, end: 2, text: "了解です", duplicate: false, words: transcriptWords("了解です"), wordTimes: [])
        await server.send(event)
        #expect(try await receiveText(first) == event.jsonString())
        #expect(try await receiveText(second) == event.jsonString())
    }

    @Test("イベントは send した順に届く")
    func preservesOrder() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)

        let events = ["あ", "あい", "あいう"].map { HelperEvent.partial(track: .相手, start: 0, end: 1, text: $0, duplicate: false, words: transcriptWords($0), wordTimes: []) }
        let expected = try events.map { try $0.jsonString() }
        for event in events { await server.send(event) }
        var received: [String] = []
        for _ in expected { received.append(try await receiveText(task)) }
        #expect(received == expected)
    }

    @Test("クライアントがいなくても send は失敗しない")
    func sendWithoutClients() async throws {
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        await server.send(markerEvent())
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

    @Test("保持するイベントを、後から接続したクライアントにも送る（register の受信開始より前に届く）")
    func retainedEventReachesLateJoiningClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let event = HelperEvent.origin(hostTime: 9_007_199_254_740_993)
        await server.send(event) // まだ誰も接続していない

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }

        #expect(try await receiveText(task) == event.jsonString())
    }

    @Test("保持するイベントは、すでに接続しているクライアントにも通常のイベントと同じく届く")
    func retainedEventReachesConnectedClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)

        let event = HelperEvent.origin(hostTime: 1)
        await server.send(event)
        #expect(try await receiveText(task) == event.jsonString())
    }

    @Test("種類ごとに最新の 1 件だけを覚え、後から接続したクライアントには origin → 最後の screen の順で届く（古い screen は届かない）")
    func retainedKeepsLatestPerKindForLateJoiningClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let origin = HelperEvent.origin(hostTime: 42)
        let older = HelperEvent.screen(start: 1, image: "b2xkZXI=", lines: nil)
        let latest = HelperEvent.screen(start: 2, image: "bGF0ZXN0", lines: nil)
        await server.send(origin)
        await server.send(older)
        await server.send(latest) // まだ誰も接続していない

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }

        #expect(try await receiveText(task) == origin.jsonString())
        #expect(try await receiveText(task) == latest.jsonString())

        // 古い screen が後ろに残っていないこと: 次に届くのは、その後に send した内容
        let marker = HelperEvent.partial(track: .相手, start: 3, end: 4, text: "次", duplicate: false, words: transcriptWords("次"), wordTimes: [])
        await server.send(marker)
        #expect(try await receiveText(task) == marker.jsonString())
    }

    @Test("screen を覚えても、origin は上書きされず、origin だけ覚えていても screen は届かない")
    func retainedKindsDoNotOverwriteEachOther() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let origin = HelperEvent.origin(hostTime: 7)
        await server.send(origin)

        let first = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        first.resume()
        defer { first.cancel(with: .goingAway, reason: nil) }
        #expect(try await receiveText(first) == origin.jsonString())
        try await waitForClients(server, count: 1)

        // 接続した後に覚えさせた screen は、つながっているクライアントにも届き、origin はそのまま残る
        let screen = HelperEvent.screen(start: 5, image: "c2NyZWVu", lines: nil)
        await server.send(screen)
        #expect(try await receiveText(first) == screen.jsonString())

        let second = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        second.resume()
        defer { second.cancel(with: .goingAway, reason: nil) }
        #expect(try await receiveText(second) == origin.jsonString())
        #expect(try await receiveText(second) == screen.jsonString())
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

    // Issue #1069: server から helper への最初の指示。受信したテキストを messages に流す
    @Test("クライアントが送ったテキストは messages に届いた順で流れる")
    func clientMessagesReachMessagesStream() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)

        try await task.send(.string(#"{"type":"self-pause","paused":true}"#))
        try await task.send(.string(#"{"type":"self-pause","paused":false}"#))
        var iterator = server.messages.makeAsyncIterator()
        #expect(await iterator.next() == #"{"type":"self-pause","paused":true}"#)
        #expect(await iterator.next() == #"{"type":"self-pause","paused":false}"#)
    }

    @Test("stop すると messages の流れが終わる")
    func stopEndsMessagesStream() async throws {
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        await server.stop()
        var iterator = server.messages.makeAsyncIterator()
        #expect(await iterator.next() == nil)
    }

    @Test("接続前に覚えた self-pause は後から接続したクライアントに届き、同じ種類は最新の 1 件に置き換わる")
    func retainedSelfPauseReachesLateJoiningClient() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let paused = HelperEvent.selfPause(paused: true, reason: .manual, start: 3)
        let resumed = HelperEvent.selfPause(paused: false, reason: .manual, start: 9)
        await server.send(paused)
        await server.send(resumed)

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        #expect(try await receiveText(task) == resumed.jsonString())
    }

    @Test("stop の後は、遅れて届く送信完了の通知があっても、waitUntilSent がすぐ戻る")
    func waitUntilSentReturnsAfterStop() async throws {
        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        defer { Task { await server.stop() } }

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        try await waitForClients(server, count: 1)
        // 送った直後に stop する。送信完了の通知は stop の前にも後にも届きうる（どちらに転ぶかは環境しだいなので、前提にしない）
        await server.send(markerEvent())
        let beforeStop = Completion()
        Task { await server.waitUntilSent(); await beforeStop.mark() }
        await server.stop()
        #expect(await beforeStop.finishes(within: 5))
        for _ in 0..<3 {
            let afterStop = Completion()
            Task { await server.waitUntilSent(); await afterStop.mark() }
            #expect(await afterStop.finishes(within: 5))
            try await Task.sleep(for: .milliseconds(200))
        }
    }
}
