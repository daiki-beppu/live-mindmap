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

private let closingScreenImage = String(repeating: "A", count: 1024 * 1024)

private func emitClosingScreens(to emitter: ScreenEventEmitter) throws -> [String] {
    for (time, value) in [(0.0, UInt8(30)), (1, 200), (15, 200), (16, 30), (30, 30), (31, 200), (45, 200)] {
        emitter.emit(ScreenFrame(luma: [UInt8](repeating: value, count: screenGridWidth * screenGridHeight), time: time, title: "Gmail")) {
            ScreenShot(image: closingScreenImage, lines: ["Gmail OCR"])
        }
    }
    emitter.close()
    return try [0.0, 1, 16, 31].map { try HelperEvent.screen(start: $0, image: closingScreenImage, lines: ["Gmail OCR"], meetingTabTitle: "Gmail").jsonString() }
}

private enum SlowReaderEnding: Equatable {
    case endOfStream
    case endOfStreamMidFrame(unparsedBytes: Int)
    case socketError(errno: Int32)
}

private struct SlowReaderOutcome {
    var texts: [String] = []
    var closeCode: UInt16?
    var ending = SlowReaderEnding.endOfStream
}

/// 少しずつしか読まない WebSocket クライアント。URLSession は先回りして読み切るので、読み残しの不具合が見えない。
/// 読むたびにスレッドを止めるので、協調スレッドを塞がないように専用のスレッドで動かす。
private func runSlowReader(port: UInt16, answersClose: Bool = true) async -> SlowReaderOutcome {
    await withCheckedContinuation { continuation in
        Thread.detachNewThread { continuation.resume(returning: readSlowly(port: port, answersClose: answersClose)) }
    }
}

private func readSlowly(port: UInt16, answersClose: Bool) -> SlowReaderOutcome {
    var outcome = SlowReaderOutcome()
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else {
        outcome.ending = .socketError(errno: errno)
        return outcome
    }
    defer { close(fd) }
    var timeout = timeval(tv_sec: 10, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSigpipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard connected == 0 else {
        outcome.ending = .socketError(errno: errno)
        return outcome
    }
    let upgrade = "GET / HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    guard writeAll(fd, Array(upgrade.utf8)) else {
        outcome.ending = .socketError(errno: errno)
        return outcome
    }

    var buffer: [UInt8] = []
    var chunk = [UInt8](repeating: 0, count: 16 * 1024)
    var upgraded = false
    while true {
        let count = recv(fd, &chunk, chunk.count, 0)
        if count < 0 {
            outcome.ending = .socketError(errno: errno)
            return outcome
        }
        if count == 0 {
            outcome.ending = buffer.isEmpty ? .endOfStream : .endOfStreamMidFrame(unparsedBytes: buffer.count)
            return outcome
        }
        buffer.append(contentsOf: chunk[..<count])
        if !upgraded, let headerEnd = buffer.firstRange(of: Array("\r\n\r\n".utf8)) {
            buffer.removeFirst(headerEnd.upperBound)
            upgraded = true
        }
        while upgraded, let frame = takeServerFrame(from: &buffer) {
            switch frame.opcode {
            case 0x1:
                outcome.texts.append(String(decoding: frame.payload, as: UTF8.self))
            case 0x8:
                if frame.payload.count >= 2 { outcome.closeCode = UInt16(frame.payload[0]) << 8 | UInt16(frame.payload[1]) }
                if answersClose { _ = writeAll(fd, maskedCloseReply(echoing: frame.payload)) }
            default:
                break
            }
        }
        Thread.sleep(forTimeInterval: 0.002)
    }
}

private func writeAll(_ fd: Int32, _ bytes: [UInt8]) -> Bool {
    var written = 0
    while written < bytes.count {
        let count = bytes[written...].withUnsafeBytes { send(fd, $0.baseAddress, $0.count, 0) }
        if count <= 0 { return false }
        written += count
    }
    return true
}

/// サーバーのフレームはマスクされない。FIN は立っている前提。揃っていなければ nil。
private func takeServerFrame(from buffer: inout [UInt8]) -> (opcode: UInt8, payload: [UInt8])? {
    guard buffer.count >= 2 else { return nil }
    let shortLength = Int(buffer[1] & 0x7f)
    let headerSize = shortLength == 126 ? 4 : shortLength == 127 ? 10 : 2
    guard buffer.count >= headerSize else { return nil }
    let payloadSize = shortLength < 126 ? shortLength : buffer[2..<headerSize].reduce(0) { $0 << 8 | Int($1) }
    guard buffer.count >= headerSize + payloadSize else { return nil }
    let frame = (opcode: buffer[0] & 0x0f, payload: Array(buffer[headerSize..<(headerSize + payloadSize)]))
    buffer.removeFirst(headerSize + payloadSize)
    return frame
}

private func stopAndCountClients(_ server: WebSocketServer) async -> Int {
    await server.stop()
    return await server.clientCount
}

private func maskedCloseReply(echoing payload: [UInt8]) -> [UInt8] {
    let mask: [UInt8] = [1, 2, 3, 4]
    let body = payload.prefix(2).enumerated().map { $0.element ^ mask[$0.offset] }
    return [0x88, 0x80 | UInt8(body.count)] + mask + body
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
            .selfPause(.paused(.manual), start: 3),
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
        #expect(diagnostics.text.contains("helper event file-duration:"))
        #expect(diagnostics.text.contains("partial"))
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
            // URLSession は受信を待っている間しか close に返事をしない
            _ = try? await client.receive()
            return received
        }
        defer { receiving.cancel() }

        let expected = try emitClosingScreens(to: emitter)
        await relay.value
        await server.stop()
        #expect(try await receiving.value == expected)
        #expect(client.closeCode == .normalClosure)
    }

    @Test("読むのが遅いクライアントにも、stop の前に送ったフレームがすべて届き、close コード 1000 で閉じてから、同時に呼んだ stop がどちらも戻る")
    func slowReaderReceivesEveryFrameBeforeStopReturns() async throws {
        let slowReaderCloseDeadline: Duration = .seconds(30)
        let server = WebSocketServer(port: 0, closeDeadline: slowReaderCloseDeadline, writeStderr: { _ in })
        let port = try await server.start()
        let emitter = ScreenEventEmitter(bundleID: "com.google.Chrome", writeStderr: { _ in })
        let relay = Task { await relayScreenEvents(emitter.events, to: server) }
        let reader = Task { await runSlowReader(port: port) }
        try await waitForClients(server, count: 1)

        let expected = try emitClosingScreens(to: emitter)
        await relay.value
        async let firstClientCount = stopAndCountClients(server)
        async let secondClientCount = stopAndCountClients(server)
        #expect(await firstClientCount == 0)
        #expect(await secondClientCount == 0)

        let outcome = await reader.value
        let sameTexts = outcome.texts == expected
        #expect(outcome.texts.count == expected.count)
        #expect(sameTexts)
        #expect(outcome.closeCode == 1000)
        #expect(outcome.ending == .endOfStream)
    }

    @Test("close に返事をしないクライアントがいても、stop は上限で諦めたことを診断へ書いて戻る")
    func stopGivesUpOnClientThatNeverAnswersClose() async throws {
        let diagnostics = SendDiagnostics()
        let server = WebSocketServer(port: 0, closeDeadline: .milliseconds(200), writeStderr: { diagnostics.write($0) })
        let port = try await server.start()
        let reader = Task { await runSlowReader(port: port, answersClose: false) }
        try await waitForClients(server, count: 1)

        await server.stop()

        #expect(await server.clientCount == 0)
        #expect(diagnostics.text.contains("close の返事が来なかった"))
        #expect(await reader.value.closeCode == 1000)
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
        let meet = HelperEvent.screen(start: 1, image: "meet", lines: ["meet OCR"], meetingTabTitle: "Gmail")
        #expect(try await receiveText(first) == meet.jsonString())
        #expect(try await receiveText(first) == HelperEvent.screen(start: 0, image: "gmail", lines: ["gmail OCR"], meetingTabTitle: "Gmail").jsonString())
        let latest = returnsToGmail ? HelperEvent.screen(start: 60, image: "gmail-return", lines: ["gmail-return OCR"], meetingTabTitle: "Gmail") : meet
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
        await server.send(event)

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
        await server.send(latest)

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }

        #expect(try await receiveText(task) == origin.jsonString())
        #expect(try await receiveText(task) == latest.jsonString())

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
        // URLSession は受信を待っている間しか close に返事をしない
        let pending = Task { try await task.receive() }

        await server.stop()
        #expect(await server.clientCount == 0)
        await #expect(throws: (any Error).self) { try await pending.value }
    }

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

        let paused = HelperEvent.selfPause(.paused(.manual), start: 3)
        let resumed = HelperEvent.selfPause(.resumed(.manual), start: 9)
        await server.send(paused)
        await server.send(resumed)

        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        #expect(try await receiveText(task) == resumed.jsonString())
    }
}
