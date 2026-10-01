import CoreAudio
import Dispatch
import Foundation
import HelperCore

// 配線だけの層。STT は Transcriber プロトコルの後ろにあり、ここでは Speech を使わない。

private let defaultPort: UInt16 = 8765

private func printError(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private let usage = """
usage:
  live-mindmap-helper list
  live-mindmap-helper run --app <bundle id> [--port <n>]
"""

private func listApps() throws {
    let apps = meetingApps(audioProcesses: try currentAudioProcesses(), runningApps: currentRunningApps())
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try encoder.encode(apps), as: UTF8.self))
}

private func run(app bundleID: String, port: UInt16) async throws {
    // 合うプロセスがなければ、ここで失敗する（Mac 全体のタップには切り替えない）。
    let targets = try tapTargets(forApp: bundleID, in: try currentAudioProcesses())
    // 2 トラックは別の SpeechAnalyzer で処理する（1 つの transcriber は 1 回の transcribe にだけ使える）。
    let theirTranscriber: Transcriber = SpeechAnalyzerTranscriber()
    let myTranscriber: Transcriber = SpeechAnalyzerTranscriber()
    try await theirTranscriber.prepare()
    try await myTranscriber.prepare()
    try await requestMicrophonePermission()

    let server = WebSocketServer(port: port)
    let actualPort = try await server.start()
    printError("listening on ws://127.0.0.1:\(actualPort) (app: \(bundleID), \(targets.count) processes)")

    let tap = ProcessTap(targets: targets)
    let microphone = MicrophoneCapture()
    // SIGINT / SIGTERM は、タップとマイクを止めて音声の流れを終わらせる。以降は通常の終了経路で片付ける。
    let signalSources = [SIGINT, SIGTERM].map { signalNumber -> DispatchSourceSignal in
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            tap.stop()
            microphone.stop()
        }
        source.resume()
        return source
    }
    defer { signalSources.forEach { $0.cancel() } }

    do {
        // 2 トラック共通の時刻の基準。音声取得を始める直前に 1 回だけ取る。
        let origin = AudioGetCurrentHostTime()
        let theirAudio = try tap.start()
        let myAudio = try microphone.start()
        let theirResults = try await theirTranscriber.transcribe(theirAudio, origin: origin)
        let myResults = try await myTranscriber.transcribe(myAudio, origin: origin)
        try await relay(tracks: [(.相手, theirResults), (.自分, myResults)], to: server)
    } catch {
        tap.stop()
        microphone.stop()
        await server.stop()
        throw error
    }
    tap.stop()
    microphone.stop()
    await server.stop()
}

private func main() async -> Int32 {
    let arguments = Array(CommandLine.arguments.dropFirst())
    do {
        switch arguments.first {
        case "list":
            try listApps()
        case "run":
            var app: String?
            var port = defaultPort
            var index = 1
            while index < arguments.count {
                switch arguments[index] {
                case "--app" where index + 1 < arguments.count:
                    app = arguments[index + 1]
                    index += 2
                case "--port" where index + 1 < arguments.count:
                    guard let value = UInt16(arguments[index + 1]) else {
                        printError("--port は 0〜65535 の整数にする\n\(usage)")
                        return 2
                    }
                    port = value
                    index += 2
                default:
                    printError("不明な引数: \(arguments[index])\n\(usage)")
                    return 2
                }
            }
            guard let app else {
                printError("--app が必要\n\(usage)")
                return 2
            }
            try await run(app: app, port: port)
        default:
            printError(usage)
            return 2
        }
        return 0
    } catch {
        printError("error: \(error)")
        return 1
    }
}

exit(await main())
