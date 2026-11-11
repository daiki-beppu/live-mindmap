import AVFoundation
import CoreAudio
import Foundation

final class RunAudio {
    typealias AudioStream = AsyncThrowingStream<CapturedAudio, Error>
    typealias ResultStream = AsyncThrowingStream<TranscriptionResult, Error>
    typealias Recording = (Track, AudioStream, UInt64) throws -> (stream: AudioStream, finished: Task<Void, Error>)

    private let requestMicrophonePermission: () async throws -> Void
    private let makeTranscriber: (Track) -> Transcriber
    private let startAudio: (Track, UInt64) throws -> AudioStream
    private let stopAudio: (Track) -> Void
    private let recording: Recording?
    private let splitAudio: (AudioStream) -> (AudioStream, AudioStream)
    private let echoCancelled: (AudioStream, AudioStream) throws -> AudioStream
    private let makeDiarizer: () -> SpeakerDiarizer?
    private let emitSpeaker: (HelperEvent) -> Void
    private let now: () -> UInt64
    private var diarizer: SpeakerDiarizer?
    private var diarizerFailure: SpeakerOffReason?
    private var theirTranscriber: Transcriber?
    private var myTranscriber: Transcriber?
    private var recordings: [Task<Void, Error>] = []
    private let selfPause: SelfPause

    init(
        requestMicrophonePermission: @escaping () async throws -> Void,
        makeTranscriber: @escaping (Track) -> Transcriber,
        startAudio: @escaping (Track, UInt64) throws -> AudioStream,
        stopAudio: @escaping (Track) -> Void,
        recording: Recording?,
        splitAudio: @escaping (AudioStream) -> (AudioStream, AudioStream),
        echoCancelled: @escaping (AudioStream, AudioStream) throws -> AudioStream,
        selfPause: SelfPause,
        makeDiarizer: @escaping () -> SpeakerDiarizer?,
        emitSpeaker: @escaping (HelperEvent) -> Void,
        now: @escaping () -> UInt64 = { AudioGetCurrentHostTime() }
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
        self.now = now
    }

    func prepare() async throws {
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
        if let candidate = makeDiarizer() {
            do {
                try await candidate.prepare()
                diarizer = candidate
            } catch {
                diarizerFailure = speakerOffReason(for: error)
                FileHandle.standardError.write(Data("speaker diarization: 使えない（認識は続ける）: \(error)\n".utf8))
            }
        }
    }

    func run(
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
        if let recording {
            let their = try recording(.相手, theirAudio, origin)
            recordings.append(their.finished)
            theirAudio = their.stream
        }
        let diarizerTask = await startDiarizer(on: &theirAudio, origin: origin)
        var tracks: [(Track, ResultStream)] = []
        do {
            tracks.append((.相手, try await theirTranscriber.transcribe(theirAudio, origin: origin)))
            if let myTranscriber, let myAudio {
                let gated = try startGatedRecording(origin: origin)
                tracks.append((.自分, mySegmentedResults(
                    microphone: myAudio, first: myTranscriber,
                    recording: gated?.input, recordingOutput: gated?.output, origin: origin)))
            }
            try await relay(tracks, marksDuplicates)
        } catch {
            stop()
            diarizerTask?.cancel()
            await diarizerTask?.value
            throw error
        }
        await diarizerTask?.value
    }

    private func startGatedRecording(origin: UInt64) throws -> (input: AudioStream.Continuation, output: AudioStream)? {
        guard let recording else { return nil }
        let (accepted, input) = AudioStream.makeStream(
            of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(downstreamBacklogLimit))
        let mine = try recording(.自分, accepted, origin)
        recordings.append(mine.finished)
        return (input, mine.stream)
    }

    private func startDiarizer(on audio: inout AudioStream, origin: UInt64) async -> Task<Void, Never>? {
        func emitOff(_ reason: SpeakerOffReason) {
            emitSpeaker(.speakerOff(start: offsetSeconds(from: origin, to: now()), reason: reason))
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
                    for try await item in segments { emit(event(from: item, track: .相手)) }
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

    private static func silence(like item: CapturedAudio) throws -> CapturedAudio {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: item.buffer.format, frameCapacity: item.buffer.frameLength) else {
            throw TranscriberError.conversionFailed("無音のバッファを作れない")
        }
        buffer.frameLength = item.buffer.frameLength
        for audioBuffer in UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList) {
            if let data = audioBuffer.mData { memset(data, 0, Int(audioBuffer.mDataByteSize)) }
        }
        return CapturedAudio(buffer: buffer, hostTime: item.hostTime)
    }

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
                        try await before?.value
                        for try await result in stream { output.yield(result) }
                    } catch {
                        output.finish(throwing: error)
                        throw error
                    }
                }
                previous = forwarded
                return continuation
            }
            do {
                for try await item in microphone {
                    let state = selfPause.resolve(at: item.hostTime)
                    if state.enteredPause {
                        segment?.finish()
                        segment = nil
                    }
                    if state.paused {
                        if let recording {
                            if case .dropped = recording.yield(try Self.silence(like: item)) {
                                throw TranscriberError.backlogExceeded(limit: downstreamBacklogLimit)
                            }
                        }
                        continue
                    }
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
            Task {
                do { for try await _ in recordingOutput {} }
                catch { output.finish(throwing: error); gate.cancel() }
            }
        }
        return results
    }

    var hasMyTrack: Bool { myTranscriber != nil }

    var isDiarizerAbsent: Bool { diarizer == nil && diarizerFailure == nil }

    func requestSelfPause(_ paused: Bool, at hostTime: UInt64) -> Bool {
        guard hasMyTrack else { return false }
        return selfPause.request(paused, at: hostTime)
    }

    func stop() {
        stopAudio(.相手)
        if myTranscriber != nil { stopAudio(.自分) }
    }

    func finish() async throws {
        var failure: Error?
        for task in recordings {
            if case .failure(let error) = await task.result, failure == nil { failure = error }
        }
        if let failure { throw failure }
    }
}
