import AVFoundation
import Foundation
import Speech
import Testing
@testable import HelperCore

// Issue #1092: 止められている間、録画ファイルの読み手が読み進めないこと（invNoReadWhilePaused）を、本物の `transcribeFile` と合成の WAV で確かめる。

private typealias Support = FileAudioTestSupport

@Suite("止められている間、録画ファイルを読み進めない（invNoReadWhilePaused）", .timeLimit(.minutes(1)))
struct FileReadingPauseITTests {
    @Test("読んだ途中で止めると、読んだ最も先の位置が止めている間は増えない。止めを解くと、止めた位置の続きから重複も抜けもなく最後まで読む")
    func pausedReadingDoesNotAdvance() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(wav, loudSeconds: 30, silentSeconds: 0)
        let gate = FileReadingGate()
        let log = GatePullLog()
        let pausedAfterFirst = GateFlag()
        // 最初の入力を引いたところで止める（サーバーが一時停止に入ったときと同じ）
        let transcriber = GateRecordingTranscriber("相手", log: log) { _ in
            if !pausedAfterFirst.isRaised {
                pausedAfterFirst.raise()
                await gate.pause()
            }
        }
        let task = Task { try await gateDrain(try await transcribeFile(at: wav, with: transcriber, gate: gate)) }
        defer { task.cancel() }
        try await gateWaitUntil("最初の入力を引く") { pausedAfterFirst.isRaised }
        try await Task.sleep(for: .milliseconds(500)) // 止めが無ければ、この間に 30 秒を読み切る
        let stoppedAt = log.maxEnd(of: "相手")
        let widest = log.values.map { $0.end - $0.start }.max() ?? 0
        try #require(stoppedAt > 0)
        try #require(stoppedAt + widest < 30) // 前提: ファイルの終わりに届いていない
        try await Task.sleep(for: .milliseconds(500))
        #expect(log.maxEnd(of: "相手") == stoppedAt, "止めている間に、読んだ最も先の位置が \(stoppedAt) 秒から \(log.maxEnd(of: "相手")) 秒へ進んだ")

        await gate.resume()
        try await task.value
        let pulled = log.items(of: "相手")
        #expect(abs((pulled.last?.end ?? 0) - 30) < 0.5) // 最後まで読み切る
        // 止めた位置の続きから、隙間も重なりもなく
        for (previous, next) in zip(pulled, pulled.dropFirst()) {
            #expect(abs(next.start - previous.end) < 0.001, "入力の位置が続いていない: \(previous.end) → \(next.start)")
        }
    }

    @Test("読み始める前から止めていると、1 つも読まない。止めを解くと先頭から読む")
    func pausedBeforeStartReadsNothing() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(wav, loudSeconds: 10, silentSeconds: 0)
        let gate = FileReadingGate()
        await gate.pause()
        let log = GatePullLog()
        let task = Task { try await gateDrain(try await transcribeFile(at: wav, with: GateRecordingTranscriber("相手", log: log), gate: gate)) }
        defer { task.cancel() }
        try await Task.sleep(for: .milliseconds(500))
        #expect(log.values.isEmpty)

        await gate.resume()
        try await task.value
        #expect(log.items(of: "相手").first?.start == 0)
        #expect(abs(log.maxEnd(of: "相手") - 10) < 0.5)
    }

    @Test("2 本の読み手（--self）が同じ門を共有すると、止めている間は両方とも読み進めず、止めを解くと両方が最後まで読む")
    func pausedPairDoesNotAdvance() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = dir.appendingPathComponent("them.wav")
        let mine = dir.appendingPathComponent("me.wav")
        try Support.writeWAV(theirs, loudSeconds: 20, silentSeconds: 0)
        try Support.writeWAV(mine, loudSeconds: 20, silentSeconds: 0)
        let alignment = FileReadingAlignment()
        let theirsReader = await alignment.addReader()
        let mineReader = await alignment.addReader()
        let gate = FileReadingGate()
        let log = GatePullLog()
        let paused = GateFlag()
        // 両方が最初の入力を引いてから止める。読み手は afterPull を抜けるまで次を引かないので、止めた時点で門を通った後の読みが残らない（#1681）
        let pauseAfterBothPulled: @Sendable (GatePulled) async throws -> Void = { _ in
            if paused.isRaised { return }
            if Set(log.values.map(\.reader)).count == 2 {
                await gate.pause()
                paused.raise()
            } else {
                try await gateWaitUntil("もう一方も最初の入力を引き、門が止まる") { paused.isRaised }
            }
        }
        let theirsTask = Task {
            try await gateDrain(try await transcribeFile(at: theirs, with: GateRecordingTranscriber("相手", log: log, afterPull: pauseAfterBothPulled), alignment: theirsReader, gate: gate))
        }
        let mineTask = Task {
            try await gateDrain(try await transcribeFile(at: mine, with: GateRecordingTranscriber("自分", log: log, afterPull: pauseAfterBothPulled), alignment: mineReader, gate: gate))
        }
        defer {
            theirsTask.cancel()
            mineTask.cancel()
        }
        try await gateWaitUntil("両方が最初の入力を引き、門が止まる") { paused.isRaised }
        let theirsStopped = log.maxEnd(of: "相手")
        let mineStopped = log.maxEnd(of: "自分")
        try await Task.sleep(for: .milliseconds(500)) // 止めている間に読み進めないかを見る間
        #expect(log.maxEnd(of: "相手") == theirsStopped)
        #expect(log.maxEnd(of: "自分") == mineStopped)
        #expect(max(theirsStopped, mineStopped) < 20)

        await gate.resume()
        try await theirsTask.value
        try await mineTask.value
        #expect(abs(log.maxEnd(of: "相手") - 20) < 0.5)
        #expect(abs(log.maxEnd(of: "自分") - 20) < 0.5)
    }

    @Test("2 本の読み手の一方が相手を待っている間に止めても、相手が進んだ後に読み進めない。止めを解くと続きから最後まで読む")
    func pausedWhileWaitingForTurnDoesNotAdvance() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(wav, loudSeconds: 30, silentSeconds: 0)
        let alignment = FileReadingAlignment()
        let reader = await alignment.addReader()
        let partner = await alignment.addReader() // テストが進める相手
        let gate = FileReadingGate()
        let log = GatePullLog()
        let task = Task { try await gateDrain(try await transcribeFile(at: wav, with: GateRecordingTranscriber("相手", log: log), alignment: reader, gate: gate)) }
        defer { task.cancel() }
        try await gateWaitUntil("最初の入力を引く") { !log.values.isEmpty }
        try await Task.sleep(for: .milliseconds(300)) // 2 つ目の入力の開始位置で、相手を待つ
        await gate.pause()
        try #require(await gate.isPaused)
        let stoppedAt = log.maxEnd(of: "相手")
        try #require(stoppedAt > 0)
        try #require(stoppedAt < 30)

        await partner.advance(to: 1000) // 待ちが解ける。止められているので、読んではならない
        try await Task.sleep(for: .milliseconds(500))
        #expect(log.maxEnd(of: "相手") == stoppedAt, "待ちが解けた後、止めている間に \(stoppedAt) 秒から \(log.maxEnd(of: "相手")) 秒へ進んだ")

        await gate.resume()
        await partner.finish()
        try await task.value
        let pulled = log.items(of: "相手")
        #expect(abs((pulled.last?.end ?? 0) - 30) < 0.5)
        for (previous, next) in zip(pulled, pulled.dropFirst()) {
            #expect(abs(next.start - previous.end) < 0.001, "入力の位置が続いていない: \(previous.end) → \(next.start)")
        }
    }

    @Test("relayFileSession に渡した門で、止めている間は 2 本の音声も映像も読み進めない。止めを解くと両方の音声が最後まで読まれ、画面のイベントが続く")
    func pausedRelayFilePairDoesNotAdvance() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let audio = dir.appendingPathComponent("audio.wav")
        try Support.writeWAV(audio, loudSeconds: 4, silentSeconds: 0)
        let theirs = dir.appendingPathComponent("them.mov")
        try await Support.writeMovie(theirs, audio: audio, videoSeconds: 4, video: .slides(switchAt: 1))
        let mine = dir.appendingPathComponent("me.wav")
        try Support.writeWAV(mine, loudSeconds: 4, silentSeconds: 0)
        // 画面の文字認識は、プロセスで最初の 1 回だけモデルを組み立てて遅い。測る前に 1 回読ませておく（FileSessionRelayITTests と同じ）
        let context = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        context?.setFillColor(gray: 1, alpha: 1)
        context?.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        _ = await recognizeScreenText(try #require(context?.makeImage()))

        let server = WebSocketServer(port: 0)
        let port = try await server.start()
        let socket = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        socket.resume()
        for _ in 0..<100 where await server.clientCount != 1 { try await Task.sleep(for: .milliseconds(50)) }
        try #require(await server.clientCount == 1)
        let screens = GateCounter()
        let receiving = Task {
            while let message = try? await socket.receive() {
                if case .string(let text) = message, text.contains(#""type":"screen""#) { screens.increment() }
            }
        }
        let gate = FileReadingGate()
        await gate.pause()
        let theirsLog = GatePullLog()
        let mineLog = GatePullLog()
        let relaying = Task {
            try await relayFileSession(
                theirs: FileSessionSource(url: theirs, transcriber: GateBackgroundTranscriber("相手", log: theirsLog), from: 0),
                mine: FileSessionSource(url: mine, transcriber: GateBackgroundTranscriber("自分", log: mineLog), from: 0),
                to: server, gate: gate)
        }
        defer {
            relaying.cancel()
            receiving.cancel()
            socket.cancel(with: .goingAway, reason: nil)
        }
        try await Task.sleep(for: .milliseconds(800))
        #expect(theirsLog.values.isEmpty, "止めている間に 相手 の音声を読んだ")
        #expect(mineLog.values.isEmpty, "止めている間に 自分 の音声を読んだ")
        #expect(screens.value == 0, "止めている間に画面のイベントが出た")

        await gate.resume()
        try await relaying.value
        #expect(abs(theirsLog.maxEnd(of: "相手") - 4) < 0.5)
        #expect(abs(mineLog.maxEnd(of: "自分") - 4) < 0.5)
        try await gateWaitUntil("画面のイベントが届く") { screens.value >= 1 }
        await server.stop()
    }

    @Test("映像のない 2 本（音声のみ）でも、relayFileSession に渡した門で止めている間は両方の音声が読み進めない。止めを解くと両方が最後まで読まれる")
    func pausedRelayFilePairAudioOnlyDoesNotAdvance() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = dir.appendingPathComponent("them.wav")
        let mine = dir.appendingPathComponent("me.wav")
        try Support.writeWAV(theirs, loudSeconds: 4, silentSeconds: 0)
        try Support.writeWAV(mine, loudSeconds: 4, silentSeconds: 0)
        let server = WebSocketServer(port: 0)
        _ = try await server.start()
        let gate = FileReadingGate()
        await gate.pause()
        let theirsLog = GatePullLog()
        let mineLog = GatePullLog()
        let relaying = Task {
            try await relayFileSession(
                theirs: FileSessionSource(url: theirs, transcriber: GateBackgroundTranscriber("相手", log: theirsLog), from: 0),
                mine: FileSessionSource(url: mine, transcriber: GateBackgroundTranscriber("自分", log: mineLog), from: 0),
                to: server, gate: gate)
        }
        defer { relaying.cancel() }
        try await Task.sleep(for: .milliseconds(800))
        #expect(theirsLog.values.isEmpty, "止めている間に 相手 の音声を読んだ")
        #expect(mineLog.values.isEmpty, "止めている間に 自分 の音声を読んだ")

        await gate.resume()
        try await relaying.value
        #expect(abs(theirsLog.maxEnd(of: "相手") - 4) < 0.5)
        #expect(abs(mineLog.maxEnd(of: "自分") - 4) < 0.5)
        await server.stop()
    }

    @Test("止められているときのキャンセル（SIGTERM）で、読み手は終わる")
    func cancelWhilePausedEndsReading() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(wav, loudSeconds: 10, silentSeconds: 0)
        let gate = FileReadingGate()
        await gate.pause()
        let ended = GateFlag()
        let log = GatePullLog()
        let task = Task {
            defer { ended.raise() }
            try await gateDrain(try await transcribeFile(at: wav, with: GateRecordingTranscriber("相手", log: log), gate: gate))
        }
        try await Task.sleep(for: .milliseconds(300))
        #expect(!ended.isRaised)
        task.cancel()
        try await gateWaitUntil("キャンセルで読み手が終わる") { ended.isRaised }
        #expect(log.values.isEmpty)
    }

    @Test("サーバーの指示（reading-pause）を受け取る経路: 止めの指示で読み進めなくなり、再開の指示で続きから最後まで読む。トークンが違う指示は効かない")
    func instructionsDriveTheGate() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(wav, loudSeconds: 30, silentSeconds: 0)
        let token = String(repeating: "a", count: 64)
        @Sendable func instruction(_ paused: Bool, token: String) -> String { #"{"type":"reading-pause","paused":\#(paused),"token":"\#(token)"}"# }
        let (messages, sender) = AsyncStream.makeStream(of: String.self)
        let gate = FileReadingGate()
        let serving = Task { await serveFileReadingRequests(messages, token: token, gate: gate) }
        defer { serving.cancel() }
        let log = GatePullLog()
        let pausedAfterFirst = GateFlag()
        // 最初の入力を引いたところで、サーバーが止めの指示を送る
        let transcriber = GateRecordingTranscriber("相手", log: log) { _ in
            if !pausedAfterFirst.isRaised {
                pausedAfterFirst.raise()
                sender.yield(instruction(true, token: token))
                try await gateWaitUntilAsync("指示が門に届く") { await gate.isPaused }
            }
        }
        let task = Task { try await gateDrain(try await transcribeFile(at: wav, with: transcriber, gate: gate)) }
        defer { task.cancel() }
        try await gateWaitUntil("最初の入力を引く") { pausedAfterFirst.isRaised }
        try await Task.sleep(for: .milliseconds(500))
        let stoppedAt = log.maxEnd(of: "相手")
        try #require(stoppedAt > 0)
        try #require(stoppedAt < 30)
        sender.yield(instruction(false, token: String(repeating: "b", count: 64))) // 違うトークンの再開は効かない
        try await Task.sleep(for: .milliseconds(500))
        #expect(log.maxEnd(of: "相手") == stoppedAt)

        sender.yield(instruction(false, token: token))
        try await task.value
        #expect(abs(log.maxEnd(of: "相手") - 30) < 0.5)
    }

}
