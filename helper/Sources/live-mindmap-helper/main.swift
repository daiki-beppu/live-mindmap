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
  live-mindmap-helper run --app <bundle id> [--port <n>] [--audio-dir <dir>] [--origin <host time>] [--audio-index <n>] [--no-screen] [--self-paused]
  live-mindmap-helper mix --session <dir> --out <path> [--track 自分]
  live-mindmap-helper readings <語>...
"""

private func listApps() throws {
    let apps = meetingApps(audioProcesses: try currentAudioProcesses(), runningApps: currentRunningApps())
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try encoder.encode(apps), as: UTF8.self))
}

private func run(app bundleID: String, port: UInt16, audioDir: String?, origin explicitOrigin: UInt64?, audioIndex: Int, noScreen: Bool, selfPaused: Bool) async throws {
    // 合うプロセスがなければ、ここで失敗する（Mac 全体のタップには切り替えない）。
    let targets = try tapTargets(forApp: bundleID, in: try currentAudioProcesses())
    // 出力先は開始時に 1 回だけ判定する。スピーカーのときだけ、`自分` の確定結果に重複の印を付ける。
    // 途中で入力の機器が変わったら、マイクの流れが `MicrophoneError.configurationChanged` で終わり、ヘルパーは終了コード 75（`microphoneConfigurationChangedExitCode`）で終わる。
    // サーバーは 75 を失敗の連続に数えずに起動し直し（Issue #161）、新しい機器の形式と出力先で取り込み直す（Issue #232）。
    let outputRoute = try currentOutputRoute()
    // 2 トラックは別の SpeechAnalyzer で処理する（1 つの transcriber は 1 回の transcribe にだけ使える）。
    // 区間がほぼ無音の認識結果は、両トラックとも SilenceFilteringTranscriber が捨てる（Issue #144）。
    let tap = ProcessTap(targets: targets)
    // 接続の前に出る `tap-silent` も保持して流せるよう、判定より前に作る（init はポートを覚えるだけ）。
    let server = WebSocketServer(port: port)
    let microphone = MicrophoneCapture()
    let silentJudgement = TapSilentJudgement(
        sleep: { try await Task.sleep(for: $0) },
        hasReceivedFrames: { tap.hasReceivedFrames },
        currentLine: { currentTapDevices(targets: targets, aggregateMainUID: tap.aggregateMainSubDeviceUID) },
        emit: { printError($0) },
        now: { AudioGetCurrentHostTime() },
        emitEvent: { event in
            guard let json = try? event.jsonString() else { return }
            Task { await server.broadcastRetained(json, key: "tap-silent") }
        }
    )
    // `自分` の休止（Issue #1069）。手で選んだ状態で、サーバーが起動し直したときは `--self-paused` で休止のまま始める。
    let selfPause = SelfPause(paused: selfPaused)
    // 話者の区間（`speaker`）と `speaker-off` は 1 つの Task が順に流す（順序を保つ）。話者分離のエラーは `run` に伝えない。
    let (speakerEvents, speakerContinuation) = AsyncStream.makeStream(of: HelperEvent.self)
    let audio = RunAudio(
        requestMicrophonePermission: { try await requestMicrophonePermission() },
        makeTranscriber: { _ in SilenceFilteringTranscriber(wrapping: SpeechAnalyzerTranscriber()) },
        startAudio: { track, origin in
            guard track == .相手 else { return try microphone.start() }
            let stream = try tap.start()
            // 無音の原因を絞るため、開始直後と、10 秒間フレームが届かなかったときに、機器の状態を 1 行ずつ出し、`tap-silent` を流す（読めなくても止めない）。
            printError(currentTapDevices(targets: targets, aggregateMainUID: tap.aggregateMainSubDeviceUID))
            silentJudgement.start(origin: origin)
            return stream
        },
        stopAudio: { track in
            if track == .相手 {
                silentJudgement.stop()
                tap.stop()
            } else {
                microphone.stop()
            }
        },
        recording: audioDir.map { directory in
            { track, stream, origin in
                let base = URL(fileURLWithPath: directory, isDirectory: true)
                let recorder = try TrackRecorder(
                    url: base.appendingPathComponent(recordingFileName(track: track, attempt: audioIndex)),
                    origin: origin
                )
                return recording(stream, to: recorder)
            }
        },
        splitAudio: split,
        echoCancelled: { microphone, reference in
            let stream = try echoCancelled(microphone: microphone, reference: reference)
            printError("echo cancellation: enabled (WebRTC AEC3, reference = process tap, output: \(outputRoute))")
            return stream
        },
        selfPause: selfPause,
        makeDiarizer: { SortformerSpeakerDiarizer() },
        emitSpeaker: { speakerContinuation.yield($0) }
    )
    try await audio.prepare()
    // 画面収録の許可は開始時に 1 回だけ確かめる（会議の途中で確認を出さない）。`--no-screen` なら確かめない。
    // まだ聞いていなければ OS のダイアログが出る。許可が無くても throw せず、音声だけで続ける。
    let screenPlan = screenCapturePlan(noScreen: noScreen) {
        CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    }

    let actualPort = try await server.start()
    printError("listening on ws://127.0.0.1:\(actualPort) (app: \(bundleID), \(targets.count) processes, output: \(outputRoute))")

    // 時刻の基準。音声取得を始める直前に 1 回だけ取る。録音の 0 秒も、共有画面の時刻もこれにそろえる。
    // サーバーがヘルパーを再起動したときは `--origin` で元の基準を渡し、時刻を 0 から振り直さない（Issue #161）。
    let origin = explicitOrigin ?? AudioGetCurrentHostTime()
    // 共有画面の取り込み（Issue #278）。失敗しても throw しない（標準エラーに 1 行出して終わる）ので、音声の `failure` には関わらない。
    // `--no-screen` と許可なしのときは作らない（ScreenCaptureKit を呼ばない）。
    let screen: ScreenCapture? = screenPlan == .capture ? ScreenCapture(bundleID: bundleID, origin: origin) : nil
    // SIGINT / SIGTERM は、タップとマイクを止めて音声の流れを終わらせる。以降は通常の終了経路で片付ける。
    let signalSources = [SIGINT, SIGTERM].map { signalNumber -> DispatchSourceSignal in
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            audio.stop()
            screen?.stop()
        }
        source.resume()
        return source
    }
    defer { signalSources.forEach { $0.cancel() } }

    // `speaker-off(モデルなし)` はサーバーがつながる前に出ることがあるので、保持して流す。`speaker` は通常の broadcast。
    let speakerTask = Task {
        for await event in speakerEvents {
            guard let json = try? event.jsonString() else { continue }
            if case .speakerOff = event {
                await server.broadcastRetained(json, key: "speaker-off")
            } else {
                await server.broadcast(json)
            }
        }
    }
    var screenTasks: [Task<Void, Never>] = []
    var selfPauseTask: Task<Void, Never>?
    var failure: Error?
    do {
        // 原点は接続より前に決まることが多く、通常の broadcast だとクライアント不在時に失われるので、保持して流す。
        try await server.broadcastRetained(HelperEvent.origin(hostTime: origin).jsonString(), key: "origin")
        // 休止の状態が変わるたびに `self-pause` を流す。接続前に出た分も、最新の 1 件を覚えて、つながったら送る。
        // サーバーからの指示は 1 つの Task が順に読む（`自分` を作らないセッションでは `requestSelfPause` が何も変えず、イベントも出ない）。
        let emitSelfPause = { (paused: Bool, hostTime: UInt64) async in
            let start = offsetSeconds(from: origin, to: hostTime)
            guard let json = try? HelperEvent.selfPause(paused: paused, start: start).jsonString() else { return }
            await server.broadcastRetained(json, key: "self-pause")
        }
        // 始めた時点の休止の状態を、最初に 1 回知らせる。サーバーは起動の間に求められた状態（休止も再開も）を、helper が受け付けるまで知らない。
        // 同じ状態なら、サーバーは何も変えない
        await announceSelfPause(audio: audio, now: { AudioGetCurrentHostTime() }, emit: emitSelfPause)
        // 指示は、server が起動時に環境変数で渡したトークンを持つものだけ受け付ける（同じ端末の別のプロセスからの指示を拒否する）。無ければ指示を処理しない
        let controlToken = ProcessInfo.processInfo.environment[helperControlTokenEnvironmentKey] ?? ""
        if controlToken.isEmpty {
            printError("self-pause: \(helperControlTokenEnvironmentKey) が無いので、休止の指示を受け付けない")
        } else {
            selfPauseTask = Task {
                await serveSelfPauseRequests(server.messages, audio: audio, token: controlToken, now: { AudioGetCurrentHostTime() }, emit: emitSelfPause)
            }
        }
        // 共有画面。接続前に出た分も、最新の 1 件を覚えて、つながったら送る。events は 1 つの Task が順に読むので、順序が保たれる。
        if let screen {
            screenTasks = [
                Task { await screen.run() },
                Task {
                    for await event in screen.events {
                        guard let json = try? event.jsonString() else { continue }
                        // `screen-off` は `screen` の最新の 1 件を置き換えないよう、別の key で保持する。
                        if case .screenOff = event {
                            await server.broadcastRetained(json, key: "screen-off")
                        } else {
                            await server.broadcastRetained(json, key: "screen")
                        }
                    }
                },
            ]
        }
        if screenPlan == .denied {
            // 許可が無い・断られた。取り込みを始めず、`screen-off` を 1 回流して音声だけで続ける。サーバーがつながる前に出るので保持する。
            printError("screen: 画面収録の許可が無い（音声だけで続ける。システム設定で、起動したターミナルに許可を与え、ターミナルを開き直す）")
            let time = offsetSeconds(from: origin, to: AudioGetCurrentHostTime())
            if let json = try? HelperEvent.screenOff(start: time, reason: .許可なし).jsonString() {
                await server.broadcastRetained(json, key: "screen-off")
            }
        }
        try await audio.run(origin: origin, marksDuplicates: outputRoute.marksDuplicates) { tracks, marksDuplicates in
            try await relay(tracks: tracks, to: server, duplicates: marksDuplicates ? DuplicateMarker() : nil)
        }
        failure = nil
    } catch {
        failure = error
    }
    audio.stop()
    silentJudgement.stop()
    screen?.stop()
    // 話者の区間は流し切ってから、サーバーを閉じる。
    speakerContinuation.finish()
    await speakerTask.value
    // 録音は全部閉じてから終わる。基準のエラーは、do 節のエラー、なければ 相手 → 自分 の順で最初の録音の失敗。
    do { try await audio.finish() } catch { if failure == nil { failure = error } }
    // 共有画面の取り込みが終わり、最後のイベントを流し切ってから、サーバーを閉じる。
    for task in screenTasks { await task.value }
    await server.stop()
    // サーバーを閉じると指示の流れが終わる
    await selfPauseTask?.value
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
                try await run(app: args.app, port: args.port, audioDir: args.audioDir, origin: args.origin, audioIndex: args.audioIndex, noScreen: args.noScreen, selfPaused: args.selfPaused)
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
