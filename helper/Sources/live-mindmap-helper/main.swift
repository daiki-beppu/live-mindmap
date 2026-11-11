import CoreAudio
import CoreGraphics
import Dispatch
import Foundation
import HelperCore

private func printError(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private let usage = """
usage:
  live-mindmap-helper check [--no-screen]
  live-mindmap-helper install-speech-ja
  live-mindmap-helper install-speaker-models
  live-mindmap-helper list
  live-mindmap-helper run --app <bundle id> --close-deadline-ms <ms> [--port <n>] [--audio-dir <dir>] [--origin <host time>] [--audio-index <n>] [--no-screen] [--self-manual pause|take] [--self-basis using|idle] [--self-last-known using|idle] [--self-idle-for <seconds>]
  live-mindmap-helper transcribe-file --file <path> --close-deadline-ms <ms> [--self-file <path>] [--port <n>] [--audio-dir <dir>] [--from <秒>] [--self-from <秒>]
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

private func run(app bundleID: String, port: UInt16, closeDeadline: Duration, audioDir: String?, origin explicitOrigin: UInt64?, audioIndex: Int, noScreen: Bool, selfPauseCarryOver: SelfPauseCarryOver) async throws {
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
        makeDiarizer: { Nemotron3SpeakerDiarizer() },
        inputUsage: SystemInputUsage(), screen: screen, clock: SystemClock()
    )
    let settings = LiveSettings(
        bundleID: bundleID, ownPID: getpid(), port: port, closeDeadline: closeDeadline, origin: explicitOrigin,
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

private func transcribeFile(file: String, selfFile: String?, port: UInt16, closeDeadline: Duration, audioDir: String?, from: Double?, selfFrom: Double?) async throws {
    let url = URL(fileURLWithPath: file)
    let selfURL = selfFile.map { URL(fileURLWithPath: $0) }
    var header = try await readFileHeader(of: url)
    if let selfURL {
        let selfHeader = try await readFileHeader(of: selfURL)
        header = FileHeader(duration: max(header.duration, selfHeader.duration), audioTrackCount: header.audioTrackCount)
    }
    if let audioDir {
        try await exportFileAudioTracks(theirs: url, mine: selfURL, into: URL(fileURLWithPath: audioDir, isDirectory: true))
    }
    let theirs = FileSessionSource(url: url, transcriber: SpeechAnalyzerTranscriber(), from: from ?? 0)
    try await theirs.transcriber.prepare()
    let mine = selfURL.map { FileSessionSource(url: $0, transcriber: SpeechAnalyzerTranscriber(), from: selfFrom ?? 0) }
    try await mine?.transcriber.prepare()
    let server = WebSocketServer(port: port, closeDeadline: closeDeadline)
    let actualPort = try await server.start()
    printError("listening on ws://127.0.0.1:\(actualPort) (file: \(file), \(header.duration) s)")
    await broadcastFileHeader(header, on: server)
    let diarization = await FileDiarization.prepare(Nemotron3SpeakerDiarizer(), from: from ?? 0) { event in
        await server.send(event)
    }

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
        await server.waitForClient()
        try await diarization.run {
            try await relayFileSession(theirs: theirs, mine: mine, to: server, gate: gate, theirsDiarization: diarization.feed)
        }
    }
    let signalSources = [SIGINT, SIGTERM].map { signalNumber -> DispatchSourceSignal in
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            work.cancel()
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
                try await run(app: args.app, port: args.port, closeDeadline: args.closeDeadline, audioDir: args.audioDir, origin: args.origin, audioIndex: args.audioIndex, noScreen: args.noScreen, selfPauseCarryOver: args.selfPauseCarryOver)
            }
        case "transcribe-file":
            switch parseTranscribeFileArguments(Array(arguments.dropFirst())) {
            case .failure(let error):
                printError("\(error.message)\n\(usage)")
                return 2
            case .success(let args):
                try await transcribeFile(file: args.file, selfFile: args.selfFile, port: args.port, closeDeadline: args.closeDeadline, audioDir: args.audioDir, from: args.from, selfFrom: args.selfFrom)
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
