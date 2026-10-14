import CoreAudio
import Foundation

public final class RunAudio {
    public typealias AudioStream = AsyncThrowingStream<CapturedAudio, Error>
    public typealias ResultStream = AsyncThrowingStream<TranscriptionResult, Error>
    public typealias Recording = (Track, AudioStream, UInt64) throws -> (stream: AudioStream, finished: Task<Void, Error>)

    private let requestMicrophonePermission: () async throws -> Void
    private let makeTranscriber: (Track) -> Transcriber
    private let startAudio: (Track, UInt64) throws -> AudioStream
    private let stopAudio: (Track) -> Void
    private let recording: Recording?
    private let splitAudio: (AudioStream) -> (AudioStream, AudioStream)
    private let echoCancelled: (AudioStream, AudioStream) throws -> AudioStream
    private let makeDiarizer: () -> SpeakerDiarizer?
    private let emitSpeaker: (HelperEvent) -> Void
    private var diarizer: SpeakerDiarizer?
    private var diarizerFailure: SpeakerOffReason?
    private var theirTranscriber: Transcriber?
    private var myTranscriber: Transcriber?
    private var recordings: [Task<Void, Error>] = []
    private let selfPause: SelfPause

    public init(
        requestMicrophonePermission: @escaping () async throws -> Void,
        makeTranscriber: @escaping (Track) -> Transcriber,
        startAudio: @escaping (Track, UInt64) throws -> AudioStream,
        stopAudio: @escaping (Track) -> Void,
        recording: Recording?,
        splitAudio: @escaping (AudioStream) -> (AudioStream, AudioStream),
        echoCancelled: @escaping (AudioStream, AudioStream) throws -> AudioStream,
        selfPause: SelfPause,
        makeDiarizer: @escaping () -> SpeakerDiarizer?,
        emitSpeaker: @escaping (HelperEvent) -> Void
    ) {
        self.requestMicrophonePermission = requestMicrophonePermission
        self.makeTranscriber = makeTranscriber
        self.startAudio = startAudio
        self.stopAudio = stopAudio
        self.recording = recording
        self.splitAudio = splitAudio
        self.echoCancelled = echoCancelled
        self.selfPause = selfPause
        self.makeDiarizer = makeDiarizer
        self.emitSpeaker = emitSpeaker
    }

    public func prepare() async throws {
        var microphoneAllowed = true
        do { try await requestMicrophonePermission() }
        catch MicrophoneError.permissionDenied { microphoneAllowed = false }
        let their = makeTranscriber(.相手)
        try await their.prepare()
        theirTranscriber = their
        if microphoneAllowed {
            let mine = makeTranscriber(.自分)
            try await mine.prepare()
            myTranscriber = mine
        }
        // 話者分離は補助。準備に失敗しても throw せず、`run` の開始時に `speaker-off` を流して認識だけで続ける。
        if let candidate = makeDiarizer() {
            do {
                try await candidate.prepare()
                diarizer = candidate
            } catch {
                if case SpeakerDiarizerError.modelMissing = error { diarizerFailure = .モデルなし } else { diarizerFailure = .読み込みに失敗 }
                FileHandle.standardError.write(Data("speaker diarization: 使えない（認識は続ける）: \(error)\n".utf8))
            }
        }
    }

    public func run(
        origin: UInt64, marksDuplicates: Bool,
        relay: ([(Track, ResultStream)], Bool) async throws -> Void
    ) async throws {
        guard let theirTranscriber else { preconditionFailure("prepare must complete before run") }
        var theirAudio = try startAudio(.相手, origin)
        var myAudio: AudioStream?
        if myTranscriber != nil {
            myAudio = try startAudio(.自分, origin)
            if marksDuplicates, let microphone = myAudio {
                let (theirs, reference) = splitAudio(theirAudio)
                theirAudio = theirs
                myAudio = try echoCancelled(microphone, reference)
            }
        }
        // 休止のゲートを通った音だけを録音へ流す（休止の間の音は録音に残さない）。STT へは区間ごとに分けて流す
        var gatedRecording: AudioStream.Continuation?
        var recordingOutput: AudioStream?
        if let recording {
            let their = try recording(.相手, theirAudio, origin)
            recordings.append(their.finished)
            theirAudio = their.stream
            if myAudio != nil {
                // 未消費は 2048 個まで。溢れたらゲートが backlogExceeded で失敗させる（音を黙って捨てない）
                let (accepted, continuation) = AudioStream.makeStream(
                    of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(downstreamBacklogLimit))
                gatedRecording = continuation
                let mine = try recording(.自分, accepted, origin)
                recordings.append(mine.finished)
                // 録音の出力は音としては使わない（STT へはゲートが直接流す）。読み捨てながら、録音の失敗を結果の流れへ伝える
                recordingOutput = mine.stream
            }
        }
        // 話者分離は `相手` のトラックにだけ掛ける。録音を通した後の音声を分け、認識とは別の流れで読む。
        let diarizerTask = await startDiarizer(on: &theirAudio, origin: origin)
        var tracks: [(Track, ResultStream)] = []
        do {
            tracks.append((.相手, try await theirTranscriber.transcribe(theirAudio, origin: origin)))
        } catch {
            // ゲートを始める前に失敗したら、作った録音の入力を終わらせる（終わらせないと finish が録音の終了を待ち続ける）
            gatedRecording?.finish(throwing: error)
            diarizerTask?.cancel()
            await diarizerTask?.value
            throw error
        }
        if let myTranscriber, let myAudio {
            tracks.append((.自分, mySegmentedResults(microphone: myAudio, first: myTranscriber, recording: gatedRecording, recordingOutput: recordingOutput, origin: origin)))
        }
        do {
            try await relay(tracks, marksDuplicates)
        } catch {
            diarizerTask?.cancel()
            await diarizerTask?.value
            throw error
        }
        // 上流が終われば、残りの区間を確定させて流れが終わる。待ってから戻る（サーバーを閉じる前に流し切る）。
        await diarizerTask?.value
    }

    /// 話者分離を始める。使えない場合は `speaker-off` を 1 回流して nil を返す。使えるなら `audio` の流れを 2 つに分け、片方を話者分離に渡す。
    private func startDiarizer(on audio: inout AudioStream, origin: UInt64) async -> Task<Void, Never>? {
        func emitOff(_ reason: SpeakerOffReason) {
            emitSpeaker(.speakerOff(start: offsetSeconds(from: origin, to: AudioGetCurrentHostTime()), reason: reason))
        }
        if let diarizerFailure {
            emitOff(diarizerFailure)
            return nil
        }
        guard let diarizer else { return nil }
        let (transcribed, diarized) = splitAudio(audio)
        do {
            let segments = try await diarizer.diarize(diarized, origin: origin)
            audio = transcribed
            let emit = emitSpeaker
            return Task {
                do {
                    for try await segment in segments { emit(event(from: segment, track: .相手)) }
                } catch {
                    FileHandle.standardError.write(Data("speaker diarization: 途中で停止（認識は続ける）: \(error)\n".utf8))
                    emitOff(.途中で停止)
                }
            }
        } catch {
            audio = transcribed
            FileHandle.standardError.write(Data("speaker diarization: 開始できない（認識は続ける）: \(error)\n".utf8))
            emitOff(.読み込みに失敗)
            return nil
        }
    }

    /// `自分` の音を休止のゲートに通し、休止していない間の音だけを、録音と STT に流す。
    /// STT は休止に入るたびに区間を閉じて（`Transcriber` の音声の流れが終わると、届いた分が確定する）、再開後は新しい `Transcriber` で次の区間を始める。
    /// 区間の結果は 1 本の流れにつなぐ。休止の間もマイクの音は読み続けて捨てる（取り込みは止めない）。
    private func mySegmentedResults(
        microphone: AudioStream, first: Transcriber, recording: AudioStream.Continuation?, recordingOutput: AudioStream?, origin: UInt64
    ) -> ResultStream {
        let selfPause = selfPause
        let makeTranscriber = makeTranscriber
        let (results, output) = ResultStream.makeStream(of: TranscriptionResult.self, throwing: Error.self)

        let gate = Task {
            var unused: Transcriber? = first
            var previous: Task<Void, Error>?
            var segment: AudioStream.Continuation?
            func open() async throws -> AudioStream.Continuation {
                let transcriber: Transcriber
                if let ready = unused { transcriber = ready; unused = nil }
                else {
                    transcriber = makeTranscriber(.自分)
                    try await transcriber.prepare()
                }
                let (audio, continuation) = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(downstreamBacklogLimit))
                let before = previous
                let forwarded = Task {
                    do {
                        let stream = try await transcriber.transcribe(audio, origin: origin)
                        // 前の区間の結果を流し終えてから、この区間の結果を流す
                        try await before?.value
                        for try await result in stream { output.yield(result) }
                    } catch {
                        // 認識の失敗は、マイクの流れが終わるのを待たずに結果の流れへ伝える
                        output.finish(throwing: error)
                        throw error
                    }
                }
                previous = forwarded
                return continuation
            }
            do {
                for try await item in microphone {
                    // バッファを取得した時刻で、休止・再開の境界と照らす（読んだ時刻ではない）
                    let state = selfPause.resolve(at: item.hostTime)
                    if state.enteredPause {
                        // 休止に入った。それより前に取った音を発言に締める（休止と再開が音を挟まずに届いた場合も閉じる）
                        segment?.finish()
                        segment = nil
                    }
                    // 休止中に取った音は捨てる
                    if state.paused { continue }
                    if segment == nil { segment = try await open() }
                    if case .dropped = recording?.yield(item) {
                        throw TranscriberError.backlogExceeded(limit: downstreamBacklogLimit)
                    }
                    if case .dropped = segment?.yield(item) {
                        throw TranscriberError.backlogExceeded(limit: downstreamBacklogLimit)
                    }
                }
                segment?.finish()
                recording?.finish()
                try await previous?.value
                output.finish()
            } catch {
                segment?.finish(throwing: error)
                recording?.finish(throwing: error)
                output.finish(throwing: error)
            }
        }
        output.onTermination = { _ in gate.cancel() }
        if let recordingOutput {
            // 録音の書き込みの失敗は、従来どおり認識と転送の失敗として run に伝える（休止で STT が録音を経由しなくなっても、失敗を終了まで隠さない）
            Task {
                do { for try await _ in recordingOutput {} }
                catch { output.finish(throwing: error); gate.cancel() }
            }
        }
        return results
    }

    /// `自分` のトラックがあるか（マイクの許可がある）。無いセッションでは休止の指示が効かない。
    public var hasMyTrack: Bool { myTranscriber != nil }

    /// `自分` があるときだけ、現在の休止の要求状態。無ければ nil。
    var currentSelfPause: Bool? { hasMyTrack ? selfPause.requestedState : nil }

    /// 休止・再開を、指示を受け付けた時刻 `hostTime` の境界として求める（Issue #1069）。状態が変わったときだけ true を返す。`自分` を作らないセッション（マイクの許可が無い）では何も変えず false。
    public func requestSelfPause(_ paused: Bool, at hostTime: UInt64) -> Bool {
        guard hasMyTrack else { return false }
        return selfPause.request(paused, at: hostTime)
    }

    public func stop() {
        stopAudio(.相手)
        if myTranscriber != nil { stopAudio(.自分) }
    }

    public func finish() async throws {
        var failure: Error?
        for task in recordings {
            if case .failure(let error) = await task.result, failure == nil { failure = error }
        }
        if let failure { throw failure }
    }
}
