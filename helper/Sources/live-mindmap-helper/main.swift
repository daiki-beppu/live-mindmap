import CoreAudio
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
  live-mindmap-helper list
  live-mindmap-helper run --app <bundle id> [--port <n>] [--audio-dir <dir>] [--origin <host time>] [--audio-index <n>]
  live-mindmap-helper mix --session <dir> --out <path> [--track 自分]
"""

private func listApps() throws {
    let apps = meetingApps(audioProcesses: try currentAudioProcesses(), runningApps: currentRunningApps())
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try encoder.encode(apps), as: UTF8.self))
}

private func run(app bundleID: String, port: UInt16, audioDir: String?, origin explicitOrigin: UInt64?, audioIndex: Int) async throws {
    // 合うプロセスがなければ、ここで失敗する（Mac 全体のタップには切り替えない）。
    let targets = try tapTargets(forApp: bundleID, in: try currentAudioProcesses())
    // 出力先は開始時に 1 回だけ判定する。スピーカーのときだけ、`自分` の確定結果に重複の印を付ける。
    // 途中で入力の機器が変わったら、マイクの流れが `MicrophoneError.configurationChanged` で終わり、ヘルパーは 1 で終わる。
    // サーバーの起動し直し（Issue #161）で、新しい機器の形式と出力先で取り込み直す（Issue #232）。
    let outputRoute = try currentOutputRoute()
    let duplicates = outputRoute.marksDuplicates ? DuplicateMarker() : nil
    // 2 トラックは別の SpeechAnalyzer で処理する（1 つの transcriber は 1 回の transcribe にだけ使える）。
    // 区間がほぼ無音の認識結果は、両トラックとも SilenceFilteringTranscriber が捨てる（Issue #144）。
    let theirTranscriber: Transcriber = SilenceFilteringTranscriber(wrapping: SpeechAnalyzerTranscriber())
    let myTranscriber: Transcriber = SilenceFilteringTranscriber(wrapping: SpeechAnalyzerTranscriber())
    try await theirTranscriber.prepare()
    try await myTranscriber.prepare()
    try await requestMicrophonePermission()

    let server = WebSocketServer(port: port)
    let actualPort = try await server.start()
    printError("listening on ws://127.0.0.1:\(actualPort) (app: \(bundleID), \(targets.count) processes, output: \(outputRoute))")

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

    // 録音を閉じる Task。tap とマイクを止めて音声が終わった後に、終了前に待つ（録音ファイルを閉じてから終わる）。
    var recordings: [Task<Void, Error>] = []
    var failure: Error?
    do {
        // 2 トラック共通の時刻の基準。音声取得を始める直前に 1 回だけ取る。録音の 0 秒もこれにそろえる。
        // サーバーがヘルパーを再起動したときは `--origin` で元の基準を渡し、時刻を 0 から振り直さない（Issue #161）。
        let origin = explicitOrigin ?? AudioGetCurrentHostTime()
        // 原点は接続より前に決まることが多く、通常の broadcast だとクライアント不在時に失われるので、保持して流す。
        try await server.broadcastRetained(HelperEvent.origin(hostTime: origin).jsonString())
        let recorders = try audioDir.map { directory -> (their: TrackRecorder, my: TrackRecorder) in
            let base = URL(fileURLWithPath: directory, isDirectory: true)
            return (
                their: try TrackRecorder(url: base.appendingPathComponent(recordingFileName(track: .相手, attempt: audioIndex)), origin: origin),
                my: try TrackRecorder(url: base.appendingPathComponent(recordingFileName(track: .自分, attempt: audioIndex)), origin: origin)
            )
        }
        var theirAudio = try tap.start()
        var myAudio = try microphone.start()
        // スピーカーのときだけ、タップの音を参照にした AEC3 でマイクのエコーを消してから、`自分` の STT と録音へ渡す。
        // タップの流れは 1 か所でしか読めないので、`相手` の STT と AEC の参照に分ける。イヤホンのときは今まで通り素通し。
        if outputRoute.marksDuplicates {
            let (theirs, reference) = split(theirAudio)
            theirAudio = theirs
            myAudio = try echoCancelled(microphone: myAudio, reference: reference)
            printError("echo cancellation: enabled (WebRTC AEC3, reference = process tap, output: \(outputRoute))")
        }
        // 録音は AEC の「後」の音（STT が聞いた音と同じ）。AEC の前の音は残らない。
        if let recorders {
            let their = recording(theirAudio, to: recorders.their)
            let my = recording(myAudio, to: recorders.my)
            theirAudio = their.stream
            myAudio = my.stream
            recordings = [their.finished, my.finished]
        }
        let theirResults = try await theirTranscriber.transcribe(theirAudio, origin: origin)
        let myResults = try await myTranscriber.transcribe(myAudio, origin: origin)
        try await relay(tracks: [(.相手, theirResults), (.自分, myResults)], to: server, duplicates: duplicates)
        failure = nil
    } catch {
        failure = error
    }
    tap.stop()
    microphone.stop()
    // 録音は全部閉じてから終わる。基準のエラーは、do 節のエラー、なければ 相手 → 自分 の順で最初の録音の失敗。
    for recording in recordings {
        if case .failure(let error) = await recording.result, failure == nil { failure = error }
    }
    await server.stop()
    if let failure { throw failure }
}

private func main() async -> Int32 {
    let arguments = Array(CommandLine.arguments.dropFirst())
    do {
        switch arguments.first {
        case "list":
            try listApps()
        case "run":
            let rest = Array(arguments.dropFirst())
            switch parseRunArguments(rest) {
            case .failure(let error):
                printError("\(error.message)\n\(usage)")
                return 2
            case .success(let args):
                try await run(app: args.app, port: args.port, audioDir: args.audioDir, origin: args.origin, audioIndex: args.audioIndex)
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
