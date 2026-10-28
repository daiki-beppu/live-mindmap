import Foundation

/// ライブの機器とイベントの流れを所有し、配送を完了してから待ち受けを閉じる。
public final class LiveSession {
    private let devices: LiveDevices
    private let settings: LiveSettings
    private let server: WebSocketServer
    private let capture: LiveCapture
    private let speakerContinuation: AsyncStream<HelperEvent>.Continuation
    private let speakerTask: Task<Void, Never>
    private var prepared: (audio: RunAudio, origin: UInt64)?

    public init(devices: LiveDevices, settings: LiveSettings) {
        self.devices = devices
        self.settings = settings
        let server = WebSocketServer(port: settings.port)
        self.server = server
        capture = LiveCapture(devices: devices, settings: settings, server: server)
        let (events, continuation) = AsyncStream.makeStream(of: HelperEvent.self)
        speakerContinuation = continuation
        speakerTask = Task {
            for await event in events { await server.send(event) }
        }
    }

    public func start() async throws -> UInt16 {
        precondition(prepared == nil, "start must be called once")
        let devices = devices
        let settings = settings
        let capture = capture
        let speakerContinuation = speakerContinuation
        let audio = RunAudio(
            requestMicrophonePermission: { try await devices.microphone.requestPermission() },
            makeTranscriber: devices.makeTranscriber,
            startAudio: { try capture.startAudio($0, origin: $1) },
            stopAudio: { capture.stopAudio($0) },
            recording: settings.recording.map { recordingSettings in
                { track, stream, origin in
                    let recorder = try TrackRecorder(
                        url: recordingSettings.directory.appendingPathComponent(recordingFileName(track: track, attempt: recordingSettings.attempt)),
                        origin: origin
                    )
                    return recording(stream, to: recorder)
                }
            },
            splitAudio: split,
            echoCancelled: { microphone, reference in
                let stream = try echoCancelled(microphone: microphone, reference: reference)
                settings.log(.echoCancellationEnabled)
                return stream
            },
            selfPause: SelfPause(paused: SelfPauseRule(app: settings.bundleID, ownPID: settings.ownPID, restoring: settings.selfPauseCarryOver).paused),
            makeDiarizer: devices.makeDiarizer,
            emitSpeaker: { speakerContinuation.yield($0) },
            now: { devices.clock.now() }
        )
        do {
            try await audio.prepare()
            let origin = settings.origin ?? devices.clock.now()
            await server.send(.origin(hostTime: origin))
            if audio.isDiarizerAbsent {
                await server.send(.speakerOff(start: offsetSeconds(from: origin, to: devices.clock.now()), reason: .モデルなし))
            }
            if case .denied = devices.screen {
                settings.log(.screenDenied)
                await server.send(.screenOff(start: offsetSeconds(from: origin, to: devices.clock.now()), reason: .許可なし))
            }
            let port = try await server.start()
            prepared = (audio, origin)
            return port
        } catch {
            capture.stop()
            speakerContinuation.finish()
            await speakerTask.value
            await server.stop()
            throw error
        }
    }

    public func run() async throws {
        guard let (audio, origin) = prepared else { preconditionFailure("start must complete before run") }
        var monitor: SelfPauseMonitor?
        var monitorTask: Task<Void, Never>?
        var stopObserving: (() -> Void)?
        var controlTask: Task<Void, Never>?
        var screenTasks: [Task<Void, Never>] = []
        var failure: Error?
        var recordingFailure: Error?
        do {
            if !capture.isStopped {
                if audio.hasMyTrack {
                    let rule = SelfPauseRule(app: settings.bundleID, ownPID: settings.ownPID, restoring: settings.selfPauseCarryOver)
                    let server = server
                    let emit: @Sendable (HelperEvent) async -> Void = { await server.send($0) }
                    await announceSelfPause(rule, at: devices.clock.now(), origin: origin, emit: emit)
                    let devices = devices
                    let observer = SelfPauseMonitor(
                        rule: rule, origin: origin,
                        readProcesses: { devices.inputUsage.readProcesses() },
                        sleep: { try await devices.clock.sleep(for: $0) },
                        now: { devices.clock.now() },
                        requestGate: { paused, time in _ = audio.requestSelfPause(paused, at: time) },
                        emit: emit
                    )
                    monitor = observer
                    stopObserving = devices.inputUsage.observe { observer.requestRead() }
                    monitorTask = observer.start()
                    if let token = settings.controlToken, !token.isEmpty {
                        controlTask = Task {
                            await serveSelfPauseRequests(server.messages, token: token) { observer.press(paused: $0) }
                        }
                    } else {
                        settings.log(.controlDisabled)
                    }
                }
                if let screen = capture.makeScreen(origin: origin) {
                    let server = server
                    screenTasks = [
                        Task { await screen.run() },
                        Task { await relayScreenEvents(screen.events, to: server) },
                    ]
                }
                try await audio.run(origin: origin, marksDuplicates: settings.marksDuplicates) { tracks, marksDuplicates in
                    try await relay(tracks: tracks, to: server, duplicates: marksDuplicates ? DuplicateMarker() : nil)
                }
            }
        } catch {
            failure = error
        }

        // 1. 止める。開始と停止は capture の同じロックで直列化する。
        capture.stop()
        stopObserving?()
        monitor?.stop()

        // 2. 流し切る。すべての producer と録音が終わるまで server を残す。
        speakerContinuation.finish()
        await speakerTask.value
        for task in screenTasks { await task.value }
        await monitorTask?.value
        do { try await audio.finish() } catch { recordingFailure = error }

        // 3. 送り終わりを待って閉じる。画面の有無によらない。
        await server.waitUntilSent()
        await server.stop()

        // 4. 指示の流れは server を閉じて初めて終わる。
        await controlTask?.value

        // 5. 本処理、相手の録音、自分の録音の順を保つ。
        if let failure { throw failure }
        if let recordingFailure { throw recordingFailure }
    }

    public func stop() { capture.stop() }
}

/// 同期的な stop と、非同期処理中の入力開始が交差しても、停止後の入力を残さない。
private final class LiveCapture {
    private let lock = NSRecursiveLock()
    private let devices: LiveDevices
    private let settings: LiveSettings
    private let silentJudgement: TapSilentJudgement
    private var stopped = false
    private var startedTracks: Set<Track> = []
    private var screen: (any LiveScreenSource)?

    init(devices: LiveDevices, settings: LiveSettings, server: WebSocketServer) {
        self.devices = devices
        self.settings = settings
        silentJudgement = TapSilentJudgement(
            sleep: { try await devices.clock.sleep(for: $0) },
            hasReceivedFrames: { devices.tap.hasReceivedFrames },
            currentLine: { devices.tap.currentLine() },
            emit: { settings.log(.tapDevices($0)) },
            now: { devices.clock.now() },
            emitEvent: { event in Task { await server.send(event) } }
        )
    }

    var isStopped: Bool { lock.withLock { stopped } }

    func startAudio(_ track: Track, origin: UInt64) throws -> AsyncThrowingStream<CapturedAudio, Error> {
        try lock.withLock {
            guard !stopped else { return AsyncThrowingStream { $0.finish() } }
            startedTracks.insert(track)
            if track == .自分 { return try devices.microphone.start() }
            let stream = try devices.tap.start()
            settings.log(.tapDevices(devices.tap.currentLine()))
            silentJudgement.start(origin: origin)
            return stream
        }
    }

    func stopAudio(_ track: Track) {
        lock.withLock {
            guard startedTracks.remove(track) != nil else { return }
            if track == .相手 {
                silentJudgement.stop()
                devices.tap.stop()
            } else {
                devices.microphone.stop()
            }
        }
    }

    func makeScreen(origin: UInt64) -> (any LiveScreenSource)? {
        lock.withLock {
            guard !stopped, case let .capture(make) = devices.screen else { return nil }
            let source = make(origin)
            screen = source
            return source
        }
    }

    func stop() {
        lock.withLock {
            stopped = true
            stopAudio(.相手)
            stopAudio(.自分)
            screen?.stop()
        }
    }
}
