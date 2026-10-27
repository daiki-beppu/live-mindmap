import CoreAudio
import CoreGraphics
import Dispatch
import Foundation
import HelperCore

// 配線だけの層。STT は Transcriber プロトコルの後ろにあり、ここでは Speech を使わない。
// 引数の解釈は HelperCore の parseRunArguments に任せる（既定のポートもそちら）。

private func printError(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private let usage = """
usage:
  live-mindmap-helper check [--no-screen]
  live-mindmap-helper install-speech-ja
  live-mindmap-helper install-speaker-models
  live-mindmap-helper list
  live-mindmap-helper run --app <bundle id> [--port <n>] [--audio-dir <dir>] [--origin <host time>] [--audio-index <n>] [--no-screen] [--self-manual pause|take] [--self-basis using|idle] [--self-last-known using|idle] [--self-idle-for <seconds>]
  live-mindmap-helper transcribe-file --file <path> [--self-file <path>] [--port <n>] [--audio-dir <dir>] [--from <秒>] [--self-from <秒>]
  live-mindmap-helper creation-date --file <path>
  live-mindmap-helper mix --session <dir> --out <path> [--track 自分]
  live-mindmap-helper readings <語>...
"""

private func listApps() throws {
    let apps = meetingApps(audioProcesses: try currentAudioProcesses(), runningApps: currentRunningApps())
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try encoder.encode(apps), as: UTF8.self))
}

private struct SystemTap: LiveTap {
    let tap: ProcessTap
    let targets: [AudioProcess]
    func start() throws -> AsyncThrowingStream<CapturedAudio, Error> { try tap.start() }
    func stop() { tap.stop() }
    var hasReceivedFrames: Bool { tap.hasReceivedFrames }
    func currentLine() -> String { currentTapDevices(targets: targets, aggregateMainUID: tap.aggregateMainSubDeviceUID) }
}

private struct SystemMicrophone: LiveMicrophone {
    let capture = MicrophoneCapture()
    func requestPermission() async throws { try await requestMicrophonePermission() }
    func start() throws -> AsyncThrowingStream<CapturedAudio, Error> { try capture.start() }
    func stop() { capture.stop() }
}

private struct SystemInputUsage: LiveInputUsage {
    func readProcesses() -> [InputProcess]? { try? currentInputProcesses() }
    func observe(_ onChange: @escaping @Sendable () -> Void) -> () -> Void {
        let observer = AudioInputObserver(onChange: onChange)
        observer.start()
        return { observer.stop() }
    }
}

private struct SystemClock: LiveClock {
    func now() -> UInt64 { AudioGetCurrentHostTime() }
    func sleep(for duration: Duration) async throws { try await Task.sleep(for: duration) }
}

extension ScreenCapture: LiveScreenSource {}

private func run(app bundleID: String, port: UInt16, audioDir: String?, origin explicitOrigin: UInt64?, audioIndex: Int, noScreen: Bool, selfPauseCarryOver: SelfPauseCarryOver) async throws {
    let targets = try tapTargets(forApp: bundleID, in: try currentAudioProcesses())
    let outputRoute = try currentOutputRoute()
    let screen: LiveScreen
    switch screenCapturePlan(noScreen: noScreen, accessGranted: {
        CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    }) {
    case .off: screen = .off
    case .denied: screen = .denied
    case .capture: screen = .capture { ScreenCapture(bundleID: bundleID, origin: $0) }
    }
    let devices = LiveDevices(
        tap: SystemTap(tap: ProcessTap(targets: targets), targets: targets),
        microphone: SystemMicrophone(),
        makeTranscriber: { _ in SilenceFilteringTranscriber(wrapping: SpeechAnalyzerTranscriber()) },
        makeDiarizer: { SortformerSpeakerDiarizer() },
        inputUsage: SystemInputUsage(), screen: screen, clock: SystemClock()
    )
    let settings = LiveSettings(
        bundleID: bundleID, ownPID: getpid(), port: port, origin: explicitOrigin,
        recording: audioDir.map { LiveSettings.Recording(directory: URL(fileURLWithPath: $0, isDirectory: true), attempt: audioIndex) },
        marksDuplicates: outputRoute.marksDuplicates, selfPauseCarryOver: selfPauseCarryOver,
        controlToken: ProcessInfo.processInfo.environment[helperControlTokenEnvironmentKey],
        log: { diagnostic in
            switch diagnostic {
            case .tapDevices(let line): printError(line)
            case .echoCancellationEnabled:
                printError("echo cancellation: enabled (WebRTC AEC3, reference = process tap, output: \(outputRoute))")
            case .screenDenied:
                printError("screen: 画面収録の許可が無い（音声だけで続ける。システム設定で、起動したターミナルに許可を与え、ターミナルを開き直す）")
            case .controlDisabled:
                printError("self-pause: \(helperControlTokenEnvironmentKey) が無いので、休止の指示を受け付けない")
            }
        }
    )
    let session = LiveSession(devices: devices, settings: settings)
    let actualPort = try await session.start()
    printError("listening on ws://127.0.0.1:\(actualPort) (app: \(bundleID), \(targets.count) processes, output: \(outputRoute))")
    let signalSources = [SIGINT, SIGTERM].map { signalNumber -> DispatchSourceSignal in
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler { session.stop() }
        source.resume()
        return source
    }
    defer { signalSources.forEach { $0.cancel() } }
    try await session.run()
}

/// 動画・音声ファイルを文字にして、`相手` の `partial`・`remark` として流す（`cli recorded`）。映像があれば共有画面（`screen`）も流す（読めなければ `screen-off`）。音声の取り込みは扱わない。
/// `selfFile` があるときは、自分用の録音も読み、ライブと同じ 2 トラック（`相手`・`自分`）で流す。2 本の読み手は同じ音声の時刻に揃え、
/// `自分` は `DuplicateMarker` に通して重複の印を付ける（保留は読んだ位置の時計で測る）。映像は、メインにあればメインの、なければ自分用の映像を使う。
/// 流れ: 読めるかを確かめる → 音声を書く → 待ち受けを始める → 全体の長さ（`file-duration`）と音声トラックの本数（`file-audio-tracks`）を保持して流す → 最初のクライアントを待つ →
/// 文字にして流す → 最後のフレームを送り終えるのを待つ → 止める。時刻はファイルの音声の時刻（先頭が 0 秒）。
/// `from` があれば `file`（相手）を、`selfFrom` があれば `selfFile`（自分）を、その時刻（秒）から読む（サーバーの起動し直し。トラックごとの位置。時刻はファイルの時刻のまま）。起動し直しでは `audioDir` を渡さない（書き出し先が既にある）。
private func transcribeFile(file: String, selfFile: String?, port: UInt16, audioDir: String?, from: Double?, selfFrom: Double?) async throws {
    let url = URL(fileURLWithPath: file)
    let selfURL = selfFile.map { URL(fileURLWithPath: $0) }
    // 読めないファイルは、待ち受けを始める前にここで失敗する
    var header = try await readFileHeader(of: url)
    if let selfURL {
        // 進み具合の「全体」は、長いほうの長さ。音声トラックの本数は、メインのファイルのもの
        let selfHeader = try await readFileHeader(of: selfURL)
        header = FileHeader(duration: max(header.duration, selfHeader.duration), audioTrackCount: header.audioTrackCount)
    }
    // 音声は待ち受けを始める前に書き終える。stop（Ctrl-C）がどの時点で来ても、完成した 相手.m4a（と 自分.m4a）が残る
    if let audioDir {
        try await exportFileAudioTracks(theirs: url, mine: selfURL, into: URL(fileURLWithPath: audioDir, isDirectory: true))
    }
    let theirs = FileSessionSource(url: url, transcriber: SpeechAnalyzerTranscriber(), from: from ?? 0)
    try await theirs.transcriber.prepare()
    let mine = selfURL.map { FileSessionSource(url: $0, transcriber: SpeechAnalyzerTranscriber(), from: selfFrom ?? 0) }
    try await mine?.transcriber.prepare()
    let server = WebSocketServer(port: port)
    let actualPort = try await server.start()
    printError("listening on ws://127.0.0.1:\(actualPort) (file: \(file), \(header.duration) s)")
    await broadcastFileHeader(header, on: server)
    // `相手` に話者分離をかける。使えなければ、ここで `speaker-off` を保持して流し（接続前でも後から接続したクライアントに届く）、読む速さは抑えない
    let diarization = await FileDiarization.prepare(SortformerSpeakerDiarizer(), from: from ?? 0) { event in
        await server.send(event)
    }

    // 差分更新が一時停止している間、サーバーは読み取りの停止を指示する（reading-pause）。止められている間は、ファイルを読み進めない。
    // 指示は、server が起動時に環境変数で渡したトークンを持つものだけ受け付ける。無ければ指示を処理しない
    let gate = FileReadingGate()
    let controlToken = ProcessInfo.processInfo.environment[helperControlTokenEnvironmentKey] ?? ""
    var readingPauseTask: Task<Void, Never>?
    if controlToken.isEmpty {
        printError("reading-pause: \(helperControlTokenEnvironmentKey) が無いので、読み取りの停止の指示を受け付けない")
    } else {
        readingPauseTask = Task { await serveFileReadingRequests(server.messages, token: controlToken, gate: gate) }
    }
    defer { readingPauseTask?.cancel() }

    let work = Task {
        // 録画の読み取りは、最初のクライアントが接続してから始める。
        await server.waitForClient()
        // 文字起こしと話者分離を並べて動かす。両方が終わる（話者分離が最後の区間と `settled` を流し切る）まで待つ
        try await diarization.run {
            try await relayFileSession(theirs: theirs, mine: mine, to: server, gate: gate, theirsDiarization: diarization.feed)
        }
    }
    // SIGINT / SIGTERM は、読むのをやめて通常の終了経路で片付ける
    let signalSources = [SIGINT, SIGTERM].map { signalNumber -> DispatchSourceSignal in
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            work.cancel()
            // 止められて待っている読み手も、ここで抜けさせる
            Task { await gate.stop() }
            Task { await server.stop() }
        }
        source.resume()
        return source
    }
    defer { signalSources.forEach { $0.cancel() } }

    var failure: Error?
    do {
        try await work.value
    } catch is CancellationError {
        failure = nil
    } catch {
        failure = error
    }
    // 最後のイベントまで届けてから止める（stop は接続を cancel して、送りかけのフレームを捨てうる）
    await server.waitUntilSent()
    await server.stop()
    if let failure { throw failure }
}

private func main() async -> Int32 {
    let arguments = Array(CommandLine.arguments.dropFirst())
    do {
        switch arguments.first {
        case "check":
            let status = try await systemCheck(noScreen: arguments.dropFirst().contains("--no-screen"))
            print(try status.jsonString())
        case "list":
            try listApps()
        case "install-speech-ja":
            switch parseInstallSpeechJaArguments(Array(arguments.dropFirst())) {
            case .failure(let error):
                printError("\(error.message)\n\(usage)")
                return 2
            case .success:
                try await installSpeechJa(progress: printError)
            }
        case "install-speaker-models":
            switch parseInstallSpeakerModelsArguments(Array(arguments.dropFirst())) {
            case .failure(let error):
                printError("\(error.message)\n\(usage)")
                return 2
            case .success:
                try await installSpeakerModels(progress: printError)
            }
        case "run":
            let rest = Array(arguments.dropFirst())
            switch parseRunArguments(rest) {
            case .failure(let error):
                printError("\(error.message)\n\(usage)")
                return 2
            case .success(let args):
                try await run(app: args.app, port: args.port, audioDir: args.audioDir, origin: args.origin, audioIndex: args.audioIndex, noScreen: args.noScreen, selfPauseCarryOver: args.selfPauseCarryOver)
            }
        case "transcribe-file":
            switch parseTranscribeFileArguments(Array(arguments.dropFirst())) {
            case .failure(let error):
                printError("\(error.message)\n\(usage)")
                return 2
            case .success(let args):
                try await transcribeFile(file: args.file, selfFile: args.selfFile, port: args.port, audioDir: args.audioDir, from: args.from, selfFrom: args.selfFrom)
            }
        case "creation-date":
            switch parseCreationDateArguments(Array(arguments.dropFirst())) {
            case .failure(let error):
                printError("\(error.message)\n\(usage)")
                return 2
            case .success(let file):
                let date = await fileCreationDate(of: URL(fileURLWithPath: file))
                let value = date.map { "\"\($0.formatted(.iso8601))\"" } ?? "null"
                print("{\"creationDate\":\(value)}")
            }
        case "mix":
            switch parseMixArguments(Array(arguments.dropFirst())) {
            case .failure(let error):
                printError("\(error.message)\n\(usage)")
                return 2
            case .success(let args):
                let inputs = try mixInputs(inSession: URL(fileURLWithPath: args.session, isDirectory: true), track: args.track)
                try await mixRecordings(inputs, to: URL(fileURLWithPath: args.out))
            }
        case "readings":
            switch parseReadingsArguments(Array(arguments.dropFirst())) {
            case .failure(let error):
                printError("\(error.message)\n\(usage)")
                return 2
            case .success(let surfaces):
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                print(String(decoding: try encoder.encode(readings(of: surfaces)), as: UTF8.self))
            }
        default:
            printError(usage)
            return 2
        }
        return 0
    } catch {
        printError("error: \(error)")
        return exitCode(for: error)
    }
}

exit(await main())
