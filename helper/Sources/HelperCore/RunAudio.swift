public final class RunAudio {
    public typealias AudioStream = AsyncThrowingStream<CapturedAudio, Error>
    public typealias ResultStream = AsyncThrowingStream<TranscriptionResult, Error>
    public typealias Recording = (Track, AudioStream, UInt64) throws -> (stream: AudioStream, finished: Task<Void, Error>)

    private let requestMicrophonePermission: () async throws -> Void
    private let makeTranscriber: (Track) -> Transcriber
    private let startAudio: (Track) throws -> AudioStream
    private let stopAudio: (Track) -> Void
    private let recording: Recording?
    private let splitAudio: (AudioStream) -> (AudioStream, AudioStream)
    private let echoCancelled: (AudioStream, AudioStream) throws -> AudioStream
    private var theirTranscriber: Transcriber?
    private var myTranscriber: Transcriber?
    private var recordings: [Task<Void, Error>] = []

    public init(
        requestMicrophonePermission: @escaping () async throws -> Void,
        makeTranscriber: @escaping (Track) -> Transcriber,
        startAudio: @escaping (Track) throws -> AudioStream,
        stopAudio: @escaping (Track) -> Void,
        recording: Recording?,
        splitAudio: @escaping (AudioStream) -> (AudioStream, AudioStream),
        echoCancelled: @escaping (AudioStream, AudioStream) throws -> AudioStream
    ) {
        self.requestMicrophonePermission = requestMicrophonePermission
        self.makeTranscriber = makeTranscriber
        self.startAudio = startAudio
        self.stopAudio = stopAudio
        self.recording = recording
        self.splitAudio = splitAudio
        self.echoCancelled = echoCancelled
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
    }

    public func run(
        origin: UInt64, marksDuplicates: Bool,
        relay: ([(Track, ResultStream)], Bool) async throws -> Void
    ) async throws {
        guard let theirTranscriber else { preconditionFailure("prepare must complete before run") }
        var theirAudio = try startAudio(.相手)
        var myAudio: AudioStream?
        if myTranscriber != nil {
            myAudio = try startAudio(.自分)
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
            if let microphone = myAudio {
                let mine = try recording(.自分, microphone, origin)
                recordings.append(mine.finished)
                myAudio = mine.stream
            }
        }
        var tracks: [(Track, ResultStream)] = [
            (.相手, try await theirTranscriber.transcribe(theirAudio, origin: origin)),
        ]
        if let myTranscriber, let myAudio {
            tracks.append((.自分, try await myTranscriber.transcribe(myAudio, origin: origin)))
        }
        try await relay(tracks, marksDuplicates)
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
