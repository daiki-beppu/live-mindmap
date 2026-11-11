import AVFoundation
import CoreAudio
import Foundation
import Testing
@testable import HelperCore

private typealias AudioStream = AsyncThrowingStream<CapturedAudio, Error>
private typealias ResultStream = AsyncThrowingStream<TranscriptionResult, Error>

private enum AudioFailure: Error, Equatable {
    case permission, preparation, capture, recognition, relay, theirRecording, myRecording
}

private enum AudioObservation: Equatable {
    case permission, created(Track), prepared(Track), started(Track), stopped(Track)
    case split, echo, recorded(Track, Float), heard(Track, Float), origin(Track, UInt64)
    case recordingOrigin(Track, UInt64)
    case recordedBuffer(Track, frames: Int, hostTime: UInt64, silent: Bool)
    case startedOrigin(Track, UInt64)
    case forwarded(Track, TranscriptionResult), duplicates(Bool), finished(Track)
    case diarizerPrepared, diarizerHeard(Float), diarizerOrigin(UInt64), speakerEvent(HelperEvent)
    case segmentHeard(Track, Int, Float), segmentEnded(Track, Int)
}

private enum MicrophoneStep {
    case audio(Float, at: UInt64)
    case sizedAudio(Float, frames: Int, at: UInt64)
    case requestPause(Bool, at: UInt64)
    case waitFor(AudioObservation)
}

private final class Latch: @unchecked Sendable {
    private let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    init() { (stream, continuation) = AsyncStream.makeStream(of: Void.self) }
    func wait() async { for await _ in stream { return } }
    func release() { continuation.yield(); continuation.finish() }
}

private struct DeadlineExceeded: Error {}

private func within<T: Sendable>(seconds: Double = 5, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    let (results, continuation) = AsyncStream.makeStream(of: Result<T, Error>.self)
    let work = Task {
        do { continuation.yield(.success(try await operation())) }
        catch { continuation.yield(.failure(error)) }
    }
    let timer = Task {
        try? await Task.sleep(for: .seconds(seconds))
        continuation.yield(.failure(DeadlineExceeded()))
    }
    defer { work.cancel(); timer.cancel() }
    for await result in results { return try result.get() }
    throw DeadlineExceeded()
}

private final class MicrophoneScript: @unchecked Sendable {
    private let lock = NSLock()
    private var steps: [MicrophoneStep]
    init(_ steps: [MicrophoneStep]) { self.steps = steps }
    func next() -> MicrophoneStep? { lock.withLock { steps.isEmpty ? nil : steps.removeFirst() } }
}

private final class TranscriberCounts: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [Track: Int] = [:]
    func next(_ track: Track) -> Int { lock.withLock { let value = counts[track, default: 0]; counts[track] = value + 1; return value } }
}

private final class AudioObservations: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [AudioObservation] = []
    var values: [AudioObservation] { lock.withLock { entries } }
    func append(_ entry: AudioObservation) { lock.withLock { entries.append(entry) } }
}

private func audioStream(_ values: [CapturedAudio]) -> AudioStream {
    AudioStream { continuation in
        values.forEach { continuation.yield($0) }
        continuation.finish()
    }
}

private func runSample(_ value: Float, frames: Int = 1, hostTime: UInt64 = 123) -> CapturedAudio {
    constantAudio(value: value, frames: frames, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: hostTime)
}

private func runResult(_ track: Track, instance: Int = 0) -> TranscriptionResult {
    TranscriptionResult(text: instance == 0 ? track.rawValue : "\(track.rawValue)\(instance)", isFinal: true, start: 1, end: 2)
}

private struct RunTranscriber: Transcriber {
    let track: Track
    let instance: Int
    let observations: AudioObservations
    let prepareFailure: AudioFailure?
    let recognitionFailure: AudioFailure?
    var transcribeFailure: AudioFailure?
    var stall: Latch?
    var alignsToTimeline = false

    func prepare() async throws {
        observations.append(.prepared(track))
        if let prepareFailure { throw prepareFailure }
    }

    func transcribe(_ audio: AudioStream, origin: UInt64) async throws -> ResultStream {
        observations.append(.origin(track, origin))
        if let transcribeFailure { throw transcribeFailure }
        await stall?.wait()
        let timeline = TrackTimeline(origin: origin)
        for try await item in audio {
            timeline.record(item)
            let data = try #require(item.buffer.floatChannelData)
            observations.append(.heard(track, data[0][0]))
            observations.append(.segmentHeard(track, instance, data[0][0]))
        }
        observations.append(.segmentEnded(track, instance))
        return ResultStream { continuation in
            if let recognitionFailure { continuation.finish(throwing: recognitionFailure) }
            else {
                let result = runResult(track, instance: instance)
                continuation.yield(alignsToTimeline ? timeline.align(result) : result)
                continuation.finish()
            }
        }
    }
}

private struct DiarizerPreparationFailure: Error {}
private struct DiarizerStreamFailure: Error {}

private struct FakeDiarizer: SpeakerDiarizer {
    let observations: AudioObservations
    let prepareFailure: Error?
    let segments: [SpeakerSegment]
    let settledTo: Double?
    let streamFailure: Error?
    let failsOnFirstAudio: Bool

    func prepare() async throws {
        observations.append(.diarizerPrepared)
        if let prepareFailure { throw prepareFailure }
    }

    func diarize(_ audio: AudioStream, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerDiarization, Error> {
        observations.append(.diarizerOrigin(origin))
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await item in audio {
                        let data = try #require(item.buffer.floatChannelData)
                        observations.append(.diarizerHeard(data[0][0]))
                        if failsOnFirstAudio {
                            segments.forEach { continuation.yield(.segment($0)) }
                            continuation.finish(throwing: streamFailure ?? DiarizerStreamFailure())
                            return
                        }
                    }
                    segments.forEach { continuation.yield(.segment($0)) }
                    if let settledTo { continuation.yield(.settled(to: settledTo)) }
                    if let streamFailure { continuation.finish(throwing: streamFailure) } else { continuation.finish() }
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private final class RunAudioFixture {
    let observations = AudioObservations()
    var permissionFailure: Error?
    var prepareFailure: AudioFailure?
    var captureFailure: AudioFailure?
    var recognitionFailure: AudioFailure?
    var recordingFailures: (their: AudioFailure?, my: AudioFailure?) = (nil, nil)
    var relayFailure: AudioFailure?
    var recordingEnabled = true
    var heldAudio: (stream: AudioStream, continuation: AudioStream.Continuation)?
    var diarizerEnabled = false
    var diarizerPrepareFailure: Error?
    var diarizerSegments: [SpeakerSegment] = []
    var diarizerSettledTo: Double?
    var diarizerStreamFailure: Error?
    var diarizerFailsOnFirstAudio = false
    let started = AsyncStream<Track>.makeStream()
    var initiallySelfPaused = false
    var heldMicrophone: (stream: AudioStream, continuation: AudioStream.Continuation)?
    var stallMyRecording: Latch?
    var stallMyTranscriber: Latch?
    var theirTranscribeFailure: AudioFailure?
    var myRecordingOutputFails = false
    var microphoneScript: MicrophoneScript?
    var alignsMyTranscriberToTimeline = false
    var requestPause: @Sendable (Bool, UInt64) -> Void = { _, _ in }
    let transcriberCounts = TranscriberCounts()

    func makeAudio() -> RunAudio {
        RunAudio(
            requestMicrophonePermission: {
                self.observations.append(.permission)
                if let error = self.permissionFailure { throw error }
            },
            makeTranscriber: { track in
                self.observations.append(.created(track))
                return RunTranscriber(
                    track: track, instance: self.transcriberCounts.next(track), observations: self.observations,
                    prepareFailure: self.prepareFailure, recognitionFailure: self.recognitionFailure,
                    transcribeFailure: track == .相手 ? self.theirTranscribeFailure : nil,
                    stall: track == .自分 ? self.stallMyTranscriber : nil,
                    alignsToTimeline: track == .自分 && self.alignsMyTranscriberToTimeline
                )
            },
            startAudio: { track, origin in
                self.observations.append(.started(track))
                self.observations.append(.startedOrigin(track, origin))
                self.started.continuation.yield(track)
                if let error = self.captureFailure, track == .自分 { throw error }
                if let held = self.heldAudio, track == .相手 { return held.stream }
                if let held = self.heldMicrophone, track == .自分 { return held.stream }
                if let script = self.microphoneScript, track == .自分 {
                    let observations = self.observations
                    let requestPause = self.requestPause
                    return AudioStream(unfolding: {
                        while let step = script.next() {
                            switch step {
                            case .audio(let value, let hostTime): return runSample(value, hostTime: hostTime)
                            case .sizedAudio(let value, let frames, let hostTime): return runSample(value, frames: frames, hostTime: hostTime)
                            case .requestPause(let paused, let hostTime): requestPause(paused, hostTime)
                            case .waitFor(let expected):
                                var waited = 0
                                while !observations.values.contains(expected) {
                                    if waited >= 500 { throw AudioFailure.recognition }
                                    try await Task.sleep(for: .milliseconds(10))
                                    waited += 1
                                }
                            }
                        }
                        return nil
                    })
                }
                return audioStream([runSample(track == .相手 ? 1 : 4)])
            },
            stopAudio: { track in
                self.observations.append(.stopped(track))
                if track == .相手 { self.heldAudio?.continuation.finish() }
                if track == .自分 { self.heldMicrophone?.continuation.finish() }
            },
            recording: recordingEnabled ? { track, stream, origin in
                self.observations.append(.recordingOrigin(track, origin))
                let (output, continuation) = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
                let finished = Task<Void, Error> {
                    defer { self.observations.append(.finished(track)) }
                    do {
                        if track == .自分 { await self.stallMyRecording?.wait() }
                        var outputFailed = false
                        for try await item in stream {
                            let data = try #require(item.buffer.floatChannelData)
                            self.observations.append(.recorded(track, data[0][0]))
                            let frames = Int(item.buffer.frameLength)
                            let silent = (0..<frames).allSatisfy { data[0][$0] == 0 }
                            self.observations.append(.recordedBuffer(track, frames: frames, hostTime: item.hostTime, silent: silent))
                            if track == .自分, self.myRecordingOutputFails {
                                if !outputFailed { continuation.finish(throwing: AudioFailure.myRecording) }
                                outputFailed = true
                                continue
                            }
                            continuation.yield(item)
                        }
                        continuation.finish()
                    } catch {
                        continuation.finish(throwing: error)
                        throw error
                    }
                    let failure = track == .相手 ? self.recordingFailures.their : self.recordingFailures.my
                    if let failure { throw failure }
                }
                return (stream: output, finished: finished)
            } : nil,
            splitAudio: { stream in
                self.observations.append(.split)
                return split(stream)
            },
            echoCancelled: { microphone, reference in
                self.observations.append(.echo)
                return AudioStream { continuation in
                    Task {
                        do {
                            for try await _ in reference {}
                            for try await item in microphone {
                                let data = try #require(item.buffer.floatChannelData)
                                continuation.yield(runSample(data[0][0] / 2, hostTime: item.hostTime))
                            }
                            continuation.finish()
                        } catch { continuation.finish(throwing: error) }
                    }
                }
            },
            selfPause: SelfPause(paused: initiallySelfPaused),
            makeDiarizer: {
                guard self.diarizerEnabled else { return nil }
                return FakeDiarizer(
                    observations: self.observations, prepareFailure: self.diarizerPrepareFailure,
                    segments: self.diarizerSegments, settledTo: self.diarizerSettledTo, streamFailure: self.diarizerStreamFailure,
                    failsOnFirstAudio: self.diarizerFailsOnFirstAudio
                )
            },
            emitSpeaker: { self.observations.append(.speakerEvent($0)) }
        )
    }

    func relay(_ tracks: [(Track, ResultStream)], _ duplicates: Bool) async throws {
        observations.append(.duplicates(duplicates))
        if let relayFailure { throw relayFailure }
        for (track, results) in tracks {
            for try await result in results { observations.append(.forwarded(track, result)) }
        }
    }
}

@Suite("開始時の音声処理", .timeLimit(.minutes(1)))
struct RunAudioTests {
    @Test("C2: マイク拒否でも相手を認識・録音・転送し、自分と AEC は開始しない")
    func deniedMicrophoneKeepsTheirAudio() async throws {
        let fixture = RunAudioFixture()
        fixture.permissionFailure = MicrophoneError.permissionDenied
        let audio = fixture.makeAudio()
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: true, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values
        #expect(events.contains(.permission))
        #expect(events.contains(.prepared(.相手)))
        #expect(events.contains(.heard(.相手, 1)))
        #expect(events.contains(.recorded(.相手, 1)))
        #expect(events.contains(.origin(.相手, 123)))
        #expect(events.contains(.recordingOrigin(.相手, 123)))
        #expect(events.contains(.startedOrigin(.相手, 123)))
        #expect(events.contains(.forwarded(.相手, runResult(.相手))))
        #expect(events.contains(.stopped(.相手)))
        #expect(events.contains(.finished(.相手)))
        #expect(!events.contains(.created(.自分)))
        #expect(!events.contains(.prepared(.自分)))
        #expect(!events.contains(.started(.自分)))
        #expect(!events.contains(.echo))
        #expect(!events.contains(.split))
        #expect(!events.contains { if case .recorded(.自分, _) = $0 { return true }; return false })
        #expect(!events.contains { if case .forwarded(.自分, _) = $0 { return true }; return false })
    }

    @Test("C2: 許可時は両トラックを転送し、スピーカーだけ AEC 後の音を録音・認識する", arguments: [false, true])
    func authorizedMicrophoneKeepsBothTracks(speaker: Bool) async throws {
        let fixture = RunAudioFixture()
        let audio = fixture.makeAudio()
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: speaker, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values
        for track in [Track.相手, .自分] {
            #expect(events.contains(.prepared(track)))
            #expect(events.contains(.started(track)))
            #expect(events.contains(.origin(track, 123)))
            #expect(events.contains(.recordingOrigin(track, 123)))
            #expect(events.contains(.forwarded(track, runResult(track))))
            #expect(events.contains(.stopped(track)))
            #expect(events.contains(.finished(track)))
        }
        #expect(events.contains(.heard(.相手, 1)))
        #expect(events.contains(.recorded(.相手, 1)))
        #expect(events.contains(.heard(.自分, speaker ? 2 : 4)))
        #expect(events.contains(.recorded(.自分, speaker ? 2 : 4)))
        #expect(events.contains(.duplicates(speaker)))
        #expect(events.filter { $0 == .echo }.count == (speaker ? 1 : 0))
        #expect(events.filter { $0 == .split }.count == (speaker ? 1 : 0))
    }

    @Test("C2: 録音なしでも拒否後の相手音声を転送する")
    func noRecordingStillRelays() async throws {
        let fixture = RunAudioFixture()
        fixture.permissionFailure = MicrophoneError.permissionDenied
        fixture.recordingEnabled = false
        let audio = fixture.makeAudio()
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values
        #expect(events.contains(.forwarded(.相手, runResult(.相手))))
        #expect(!events.contains { if case .recorded = $0 { return true }; return false })
    }

    @Test("C2: 許可拒否以外の許可要求エラーは隠さない")
    func permissionFailurePropagates() async {
        let fixture = RunAudioFixture()
        fixture.permissionFailure = AudioFailure.permission
        let audio = fixture.makeAudio()
        await #expect(throws: AudioFailure.permission) { try await audio.prepare() }
        #expect(fixture.observations.values.contains(.permission))
        #expect(!fixture.observations.values.contains(.started(.相手)))
    }

    @Test("C2: 拒否後も相手の認識準備エラーは隠さない")
    func preparationFailurePropagates() async {
        let fixture = RunAudioFixture()
        fixture.permissionFailure = MicrophoneError.permissionDenied
        fixture.prepareFailure = .preparation
        let audio = fixture.makeAudio()
        await #expect(throws: AudioFailure.preparation) { try await audio.prepare() }
        #expect(fixture.observations.values.contains(.prepared(.相手)))
        #expect(!fixture.observations.values.contains(.started(.相手)))
    }

    @Test("C2: 取得・認識・転送の失敗を返し、開始済み音声と録音を終了できる", arguments: [
        AudioFailure.capture, .recognition, .relay,
    ])
    fileprivate func runFailureAllowsCleanup(failure: AudioFailure) async throws {
        let fixture = RunAudioFixture()
        if failure == .capture { fixture.captureFailure = failure }
        if failure == .recognition { fixture.recognitionFailure = failure }
        if failure == .relay { fixture.relayFailure = failure }
        let audio = fixture.makeAudio()
        try await audio.prepare()
        await #expect(throws: failure) {
            try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        }
        audio.stop()
        try await audio.finish()
        #expect(fixture.observations.values.contains(.started(.相手)))
        #expect(fixture.observations.values.contains(.stopped(.相手)))
        #expect(fixture.observations.values.contains(.stopped(.自分)))
        if failure != .capture {
            #expect(fixture.observations.values.contains(.finished(.相手)))
            #expect(fixture.observations.values.contains(.finished(.自分)))
        }
    }

    @Test("C2: finish は両録音を待ち、相手の失敗を自分より優先する", arguments: [false, true])
    func recordingFailurePriority(theirFails: Bool) async throws {
        let fixture = RunAudioFixture()
        fixture.recordingFailures = (theirFails ? .theirRecording : nil, .myRecording)
        let audio = fixture.makeAudio()
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        await #expect(throws: theirFails ? AudioFailure.theirRecording : AudioFailure.myRecording) {
            try await audio.finish()
        }
        #expect(fixture.observations.values.contains(.forwarded(.相手, runResult(.相手))))
        #expect(fixture.observations.values.contains(.finished(.相手)))
        #expect(fixture.observations.values.contains(.finished(.自分)))
    }

    @Test("C2: 取得中の stop は流れを閉じ、録音を終了して run を完了させる")
    func stopEndsActiveAudio() async throws {
        let fixture = RunAudioFixture()
        fixture.permissionFailure = MicrophoneError.permissionDenied
        fixture.heldAudio = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let audio = fixture.makeAudio()
        try await audio.prepare()
        let running = Task { try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay) }
        defer { running.cancel(); fixture.heldAudio?.continuation.finish() }
        var starts = fixture.started.stream.makeAsyncIterator()
        let track = try #require(await starts.next())
        #expect(track == .相手)
        fixture.heldAudio?.continuation.yield(runSample(1))
        audio.stop()
        try await running.value
        try await audio.finish()
        #expect(fixture.observations.values.contains(.heard(.相手, 1)))
        #expect(fixture.observations.values.contains(.forwarded(.相手, runResult(.相手))))
        #expect(fixture.observations.values.contains(.stopped(.相手)))
        #expect(fixture.observations.values.contains(.finished(.相手)))
    }

    private var tentative: SpeakerSegment { SpeakerSegment(start: 1.5, end: 2.5, slot: 1, isFinal: false) }
    private var confirmed: SpeakerSegment { SpeakerSegment(start: 0, end: 1.5, slot: 0, isFinal: true) }

    private func speakerEvents(_ fixture: RunAudioFixture) -> [HelperEvent] {
        fixture.observations.values.compactMap { if case .speakerEvent(let event) = $0 { return event }; return nil }
    }

    @Test("C3: 話者分離は相手の音声だけを受け取り、区間（仮・確定）を届いた順に speaker イベントとして流す", arguments: [false, true])
    func diarizerHearsOnlyTheirAudioAndEmitsSegments(speaker: Bool) async throws {
        let fixture = RunAudioFixture()
        fixture.diarizerEnabled = true
        fixture.diarizerSegments = [tentative, confirmed]
        fixture.diarizerSettledTo = 1.5
        let audio = fixture.makeAudio()
        try await audio.prepare()
        try await audio.run(origin: AudioGetCurrentHostTime(), marksDuplicates: speaker, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values
        let origin = try #require(events.compactMap { if case .startedOrigin(.相手, let origin) = $0 { return origin }; return nil }.first)
        #expect(events.contains(.diarizerOrigin(origin)))
        #expect(events.contains(.diarizerHeard(1)))
        #expect(!events.contains(.diarizerHeard(4)))
        #expect(!events.contains(.diarizerHeard(2)))
        #expect(speakerEvents(fixture) == [
            .speaker(track: .相手, start: 1.5, end: 2.5, slot: 1, isFinal: false),
            .speaker(track: .相手, start: 0, end: 1.5, slot: 0, isFinal: true),
            .speakerSettled(track: .相手, to: 1.5),
        ])
        #expect(events.contains(.heard(.相手, 1)))
        #expect(events.contains(.recorded(.相手, 1)))
        #expect(events.contains(.forwarded(.相手, runResult(.相手))))
        #expect(events.contains(.forwarded(.自分, runResult(.自分))))
    }

    @Test("C3: マイク拒否でも話者分離は相手の音声に掛かる")
    func diarizerRunsWhenMicrophoneDenied() async throws {
        let fixture = RunAudioFixture()
        fixture.permissionFailure = MicrophoneError.permissionDenied
        fixture.diarizerEnabled = true
        fixture.diarizerSegments = [confirmed]
        let audio = fixture.makeAudio()
        try await audio.prepare()
        try await audio.run(origin: AudioGetCurrentHostTime(), marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        #expect(fixture.observations.values.contains(.diarizerHeard(1)))
        #expect(speakerEvents(fixture) == [.speaker(track: .相手, start: 0, end: 1.5, slot: 0, isFinal: true)])
    }

    @Test("C3: 話者分離の準備は音声の取得より前に済み、成功なら speaker-off は流れない")
    func diarizerIsPreparedBeforeAudioStarts() async throws {
        let fixture = RunAudioFixture()
        fixture.diarizerEnabled = true
        let audio = fixture.makeAudio()
        try await audio.prepare()
        try await audio.run(origin: AudioGetCurrentHostTime(), marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values
        let prepared = try #require(events.firstIndex(of: .diarizerPrepared))
        let started = try #require(events.firstIndex(of: .started(.相手)))
        #expect(prepared < started)
        #expect(events.filter { $0 == .diarizerPrepared }.count == 1)
        #expect(!speakerEvents(fixture).contains { if case .speakerOff = $0 { return true }; return false })
    }

    @Test("C5: 準備の失敗は prepare も run も止めず、原因に応じた speaker-off を 1 回だけ流し、認識・録音・転送は続く", arguments: [
        (DiarizerFailureKind.missing, SpeakerOffReason.モデルなし),
        (DiarizerFailureKind.loading, SpeakerOffReason.読み込みに失敗),
    ])
    fileprivate func preparationFailureEmitsSpeakerOff(kind: DiarizerFailureKind, reason: SpeakerOffReason) async throws {
        let fixture = RunAudioFixture()
        fixture.diarizerEnabled = true
        fixture.diarizerSegments = [confirmed]
        fixture.diarizerPrepareFailure = kind == .missing
            ? SpeakerDiarizerError.modelMissing(URL(fileURLWithPath: "/nonexistent/Sortformer"))
            : DiarizerPreparationFailure()
        let audio = fixture.makeAudio()
        try await audio.prepare()
        let origin = AudioGetCurrentHostTime()
        try await audio.run(origin: origin, marksDuplicates: false, relay: fixture.relay)
        let returned = AudioGetCurrentHostTime()
        audio.stop()
        try await audio.finish()
        let emitted = speakerEvents(fixture)
        #expect(emitted.count == 1)
        guard case .speakerOff(let start, let actual)? = emitted.first else {
            Issue.record("speaker-off が流れていません: \(emitted)")
            return
        }
        #expect(actual == reason)
        #expect(start >= 0 && start <= offsetSeconds(from: origin, to: returned))
        let events = fixture.observations.values
        #expect(events.contains(.heard(.相手, 1)))
        #expect(events.contains(.recorded(.相手, 1)))
        #expect(events.contains(.forwarded(.相手, runResult(.相手))))
        #expect(events.contains(.forwarded(.自分, runResult(.自分))))
        #expect(events.contains(.finished(.相手)))
        #expect(!events.contains { if case .diarizerHeard = $0 { return true }; return false })
    }

    @Test("C5: 区間の流れが途中でエラーになると、それまでの区間の後に speaker-off（途中で停止）を流し、run は成功して認識は続く")
    func streamFailureEmitsSpeakerOffAfterSegments() async throws {
        let fixture = RunAudioFixture()
        fixture.diarizerEnabled = true
        fixture.diarizerSegments = [confirmed]
        fixture.diarizerStreamFailure = DiarizerStreamFailure()
        let audio = fixture.makeAudio()
        try await audio.prepare()
        try await audio.run(origin: AudioGetCurrentHostTime(), marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let emitted = speakerEvents(fixture)
        #expect(emitted.count == 2)
        #expect(emitted.first == .speaker(track: .相手, start: 0, end: 1.5, slot: 0, isFinal: true))
        guard case .speakerOff(let start, let reason)? = emitted.last else {
            Issue.record("最後が speaker-off ではありません: \(emitted)")
            return
        }
        #expect(reason == .途中で停止)
        #expect(start >= 0)
        let events = fixture.observations.values
        #expect(events.contains(.forwarded(.相手, runResult(.相手))))
        #expect(events.contains(.forwarded(.自分, runResult(.自分))))
        #expect(events.contains(.finished(.相手)))
    }

    @Test("C5: 取得の途中（入力が開いたまま）で話者分離が失敗しても、speaker-off の後に届いた音声は認識に届き続ける")
    func recognitionContinuesAfterDiarizerFailsMidStream() async throws {
        let fixture = RunAudioFixture()
        fixture.permissionFailure = MicrophoneError.permissionDenied
        fixture.diarizerEnabled = true
        fixture.diarizerFailsOnFirstAudio = true
        fixture.diarizerSegments = [confirmed]
        fixture.heldAudio = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let audio = fixture.makeAudio()
        try await audio.prepare()
        let running = Task { try await audio.run(origin: AudioGetCurrentHostTime(), marksDuplicates: false, relay: fixture.relay) }
        defer { running.cancel(); fixture.heldAudio?.continuation.finish() }
        var starts = fixture.started.stream.makeAsyncIterator()
        _ = await starts.next()
        fixture.heldAudio?.continuation.yield(runSample(1))
        try await waitUntil { speakerEvents(fixture).contains { if case .speakerOff = $0 { return true }; return false } }
        fixture.heldAudio?.continuation.yield(runSample(5))
        try await waitUntil { fixture.observations.values.contains(.heard(.相手, 5)) }
        audio.stop()
        try await running.value
        try await audio.finish()
        let events = fixture.observations.values
        #expect(events.contains(.recorded(.相手, 5)))
        #expect(!events.contains(.diarizerHeard(5)))
        #expect(events.contains(.forwarded(.相手, runResult(.相手))))
        let emitted = speakerEvents(fixture)
        #expect(emitted.count == 2)
        guard case .speakerOff(_, let reason)? = emitted.last else {
            Issue.record("最後が speaker-off ではありません: \(emitted)")
            return
        }
        #expect(reason == .途中で停止)
    }

    @Test("C3: 取得中の stop は話者分離の流れも閉じ、run を完了させる")
    func stopEndsDiarizerStream() async throws {
        let fixture = RunAudioFixture()
        fixture.permissionFailure = MicrophoneError.permissionDenied
        fixture.diarizerEnabled = true
        fixture.diarizerSegments = [confirmed]
        fixture.heldAudio = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let audio = fixture.makeAudio()
        try await audio.prepare()
        let running = Task { try await audio.run(origin: AudioGetCurrentHostTime(), marksDuplicates: false, relay: fixture.relay) }
        defer { running.cancel(); fixture.heldAudio?.continuation.finish() }
        var starts = fixture.started.stream.makeAsyncIterator()
        _ = await starts.next()
        fixture.heldAudio?.continuation.yield(runSample(1))
        audio.stop()
        try await running.value
        try await audio.finish()
        #expect(fixture.observations.values.contains(.diarizerHeard(1)))
        #expect(fixture.observations.values.contains(.forwarded(.相手, runResult(.相手))))
        #expect(speakerEvents(fixture) == [.speaker(track: .相手, start: 0, end: 1.5, slot: 0, isFinal: true)])
    }

    private func forwardedMine(_ events: [AudioObservation]) -> [TranscriptionResult] {
        events.compactMap { if case .forwarded(.自分, let result) = $0 { return result }; return nil }
    }
    private func recordedMine(_ events: [AudioObservation]) -> [Float] {
        events.compactMap { if case .recorded(.自分, let value) = $0 { return value }; return nil }
    }
    private func heardMine(_ events: [AudioObservation]) -> [Float] {
        events.compactMap { if case .heard(.自分, let value) = $0 { return value }; return nil }
    }

    @Test("C9: 休止の間の音は STT に届かず（録音には同じ長さの無音が入り）、休止に入るまでの音は発言に確定し、再開後の音は新しい Transcriber に届く。相手は止まらない")
    func pausedMicrophoneAudioIsDroppedAndEarlierAudioIsFinalized() async throws {
        let fixture = RunAudioFixture()
        fixture.microphoneScript = MicrophoneScript([
            .audio(4, at: 100), .requestPause(true, at: 150), .audio(5, at: 200),
            .waitFor(.segmentEnded(.自分, 0)),
            .requestPause(false, at: 250), .audio(6, at: 300),
        ])
        let audio = fixture.makeAudio()
        fixture.requestPause = { paused, hostTime in _ = audio.requestSelfPause(paused, at: hostTime) }
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values

        #expect(recordedMine(events) == [4, 0, 6])
        #expect(heardMine(events) == [4, 6])
        #expect(events.contains(.segmentHeard(.自分, 0, 4)))
        #expect(events.contains(.segmentHeard(.自分, 1, 6)))
        #expect(!events.contains { if case .segmentHeard(.自分, _, 5) = $0 { return true }; return false })
        #expect(forwardedMine(events) == [runResult(.自分, instance: 0), runResult(.自分, instance: 1)])
        #expect(events.filter { $0 == .created(.自分) }.count == 2)
        #expect(events.filter { $0 == .prepared(.自分) }.count == 2)
        #expect(events.contains(.heard(.相手, 1)))
        #expect(events.contains(.recorded(.相手, 1)))
        #expect(events.contains(.forwarded(.相手, runResult(.相手))))
    }

    @Test("C9: 休止のまま始めると、最初の音は STT に届かず（録音には無音が入り）、再開した後の音が STT と録音に届く（起動し直しで休止が続く）")
    func startsPausedDropsAudioUntilResumed() async throws {
        let fixture = RunAudioFixture()
        fixture.initiallySelfPaused = true
        fixture.microphoneScript = MicrophoneScript([.audio(4, at: 100), .requestPause(false, at: 150), .audio(6, at: 200)])
        let audio = fixture.makeAudio()
        fixture.requestPause = { paused, hostTime in _ = audio.requestSelfPause(paused, at: hostTime) }
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values

        #expect(recordedMine(events) == [0, 6])
        #expect(heardMine(events) == [6])
        #expect(!forwardedMine(events).isEmpty)
    }

    @Test("C9: 休止のままマイクの流れが終わっても、run は完了し、録音も終わる（休止中に stop できる）")
    func pausedRunCompletesWhenMicrophoneEnds() async throws {
        let fixture = RunAudioFixture()
        fixture.microphoneScript = MicrophoneScript([.audio(4, at: 100), .requestPause(true, at: 150), .audio(5, at: 200)])
        let audio = fixture.makeAudio()
        fixture.requestPause = { paused, hostTime in _ = audio.requestSelfPause(paused, at: hostTime) }
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values

        #expect(recordedMine(events) == [4, 0])
        #expect(events.contains(.segmentEnded(.自分, 0)))
        #expect(events.contains(.finished(.自分)))
        #expect(forwardedMine(events) == [runResult(.自分, instance: 0)])
    }


    private func recordedBuffersMine(_ events: [AudioObservation]) -> [(frames: Int, hostTime: UInt64, silent: Bool)] {
        events.compactMap {
            if case .recordedBuffer(.自分, let frames, let hostTime, let silent) = $0 { return (frames, hostTime, silent) }
            return nil
        }
    }

    @Test("C10: 休止中に捨てた音ごとに、同じフレーム数・同じ取得時刻の無音が 自分 の録音に流れる。録音ファイルは増えない")
    func pausedAudioIsRecordedAsSilenceOfTheSameLength() async throws {
        let fixture = RunAudioFixture()
        fixture.microphoneScript = MicrophoneScript([
            .sizedAudio(4, frames: 480, at: 100), .requestPause(true, at: 150),
            .sizedAudio(5, frames: 960, at: 200), .sizedAudio(5, frames: 240, at: 210),
            .waitFor(.segmentEnded(.自分, 0)),
            .requestPause(false, at: 250), .sizedAudio(6, frames: 100, at: 300),
        ])
        let audio = fixture.makeAudio()
        fixture.requestPause = { paused, hostTime in _ = audio.requestSelfPause(paused, at: hostTime) }
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values

        let recorded = recordedBuffersMine(events)
        #expect(recorded.map(\.frames) == [480, 960, 240, 100])
        #expect(recorded.map(\.hostTime) == [100, 200, 210, 300])
        #expect(recorded.map(\.silent) == [false, true, true, false])
        #expect(heardMine(events) == [4, 6])
        #expect(events.filter { $0 == .recordingOrigin(.自分, 123) }.count == 1)
        #expect(events.filter { $0 == .finished(.自分) }.count == 1)
    }

    @Test("C10: 休止のまま始めても、最初の音と同じ長さの無音から 自分 の録音が始まる")
    func startingPausedRecordsSilenceFromTheFirstBuffer() async throws {
        let fixture = RunAudioFixture()
        fixture.initiallySelfPaused = true
        fixture.microphoneScript = MicrophoneScript([
            .sizedAudio(4, frames: 480, at: 100), .requestPause(false, at: 150), .sizedAudio(6, frames: 100, at: 200),
        ])
        let audio = fixture.makeAudio()
        fixture.requestPause = { paused, hostTime in _ = audio.requestSelfPause(paused, at: hostTime) }
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()

        let recorded = recordedBuffersMine(fixture.observations.values)
        #expect(recorded.map(\.frames) == [480, 100])
        #expect(recorded.map(\.hostTime) == [100, 200])
        #expect(recorded.map(\.silent) == [true, false])
    }

    @Test("C10: 休止のあとの発言の時刻と、録音のその位置が秒単位で一致する")
    func speechTimeAfterPauseMatchesRecordingPosition() async throws {
        let origin: UInt64 = 1_000_000
        func tick(_ seconds: Double) -> UInt64 { origin + AudioConvertNanosToHostTime(UInt64(seconds * 1_000_000_000)) }
        let frames = 4800
        let fixture = RunAudioFixture()
        fixture.alignsMyTranscriberToTimeline = true
        fixture.microphoneScript = MicrophoneScript([
            .sizedAudio(4, frames: frames, at: tick(0.0)), .sizedAudio(4, frames: frames, at: tick(0.1)),
            .requestPause(true, at: tick(0.2)),
            .sizedAudio(5, frames: frames, at: tick(0.2)), .sizedAudio(5, frames: frames, at: tick(0.3)),
            .waitFor(.segmentEnded(.自分, 0)),
            .requestPause(false, at: tick(0.4)),
            .sizedAudio(6, frames: frames, at: tick(0.4)), .sizedAudio(6, frames: frames, at: tick(0.5)),
        ])
        let audio = fixture.makeAudio()
        fixture.requestPause = { paused, hostTime in _ = audio.requestSelfPause(paused, at: hostTime) }
        try await audio.prepare()
        try await audio.run(origin: origin, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values

        let results = forwardedMine(events)
        #expect(results.count == 2)
        let speechOffset = try #require(results.last).start - 1

        let recorded = recordedBuffersMine(events)
        let resumed = try #require(recorded.firstIndex { $0.hostTime == tick(0.4) })
        let leading = leadingSilenceFrames(origin: origin, firstHostTime: try #require(recorded.first).hostTime, sampleRate: 48_000)
        let writtenBefore = recorded[..<resumed].reduce(Int(leading)) { $0 + $1.frames }
        let recordingPosition = Double(writtenBefore) / 48_000

        #expect(abs(speechOffset - 0.4) < 0.001)
        #expect(abs(recordingPosition - speechOffset) < 0.001)
    }

    @Test("U1: 休止の前に取った音は、休止の後に読んでも STT と録音に流れ、休止の後の区間は新しい Transcriber になる")
    func audioAcquiredBeforePauseIsKeptWhenReadAfter() async throws {
        let fixture = RunAudioFixture()
        fixture.microphoneScript = MicrophoneScript([
            .audio(4, at: 100), .requestPause(true, at: 150), .audio(5, at: 200),
            .waitFor(.segmentEnded(.自分, 0)),
            .requestPause(false, at: 250), .requestPause(true, at: 350), .audio(6, at: 300), .audio(7, at: 400),
        ])
        let audio = fixture.makeAudio()
        fixture.requestPause = { paused, hostTime in _ = audio.requestSelfPause(paused, at: hostTime) }
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values

        #expect(recordedMine(events) == [4, 0, 6, 0])
        #expect(heardMine(events) == [4, 6])
        #expect(events.contains(.segmentHeard(.自分, 1, 6)))
        #expect(forwardedMine(events).count == 2)
    }

    @Test("U1: 休止中に取った音は、再開の後に読んでも STT に流れず、録音には無音が入る")
    func audioAcquiredDuringPauseIsDroppedWhenReadAfterResume() async throws {
        let fixture = RunAudioFixture()
        fixture.microphoneScript = MicrophoneScript([
            .audio(4, at: 100), .requestPause(true, at: 150), .requestPause(false, at: 250),
            .audio(5, at: 200), .audio(6, at: 300),
        ])
        let audio = fixture.makeAudio()
        fixture.requestPause = { paused, hostTime in _ = audio.requestSelfPause(paused, at: hostTime) }
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values

        #expect(recordedMine(events) == [4, 0, 6])
        #expect(heardMine(events) == [4, 6])
        #expect(!events.contains { if case .segmentHeard(.自分, _, 5) = $0 { return true }; return false })
    }

    @Test("U1: 音を挟まずに休止と再開が届いても、休止のたびに区間を閉じる")
    func pauseWithoutAudioInBetweenStillClosesSegment() async throws {
        let fixture = RunAudioFixture()
        fixture.microphoneScript = MicrophoneScript([
            .audio(4, at: 100), .requestPause(true, at: 150), .requestPause(false, at: 160), .audio(6, at: 300),
        ])
        let audio = fixture.makeAudio()
        fixture.requestPause = { paused, hostTime in _ = audio.requestSelfPause(paused, at: hostTime) }
        try await audio.prepare()
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values

        #expect(events.contains(.segmentHeard(.自分, 0, 4)))
        #expect(events.contains(.segmentHeard(.自分, 1, 6)))
        #expect(events.filter { $0 == .created(.自分) }.count == 2)
        #expect(forwardedMine(events).count == 2)
    }

    private func feedBeyondLimit(_ fixture: RunAudioFixture) {
        for _ in 0...2048 { fixture.heldMicrophone?.continuation.yield(runSample(7, hostTime: 100)) }
    }

    private func expectBacklogExceeded(_ running: Task<Void, Error>) async throws {
        do {
            try await within { try await running.value }
            Issue.record("上限を超えたのに、run が正常に終わった")
        } catch TranscriberError.backlogExceeded(let limit) {
            #expect(limit == 2048)
        }
    }

    @Test("U2: 録音側だけが遅れて未消費が上限（2048 個）を超えたら、音を捨てずに backlogExceeded で run が失敗し、後片付けが終わる")
    func recordingBacklogFailsRun() async throws {
        let fixture = RunAudioFixture()
        fixture.heldMicrophone = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let latch = Latch()
        fixture.stallMyRecording = latch
        let audio = fixture.makeAudio()
        try await audio.prepare()
        let running = Task { try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay) }
        feedBeyondLimit(fixture)
        try await expectBacklogExceeded(running)
        latch.release()
        audio.stop()
        _ = try? await within { try await audio.finish() }
        #expect(fixture.observations.values.contains(.finished(.自分)))
    }

    @Test("U2: 休止中に録音側だけが遅れて未消費が上限（2048 個）を超えたら、無音を黙って捨てず、backlogExceeded で run が失敗し、後片付けが終わる")
    func recordingBacklogDuringPauseFailsRun() async throws {
        let fixture = RunAudioFixture()
        fixture.initiallySelfPaused = true
        fixture.heldMicrophone = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let latch = Latch()
        fixture.stallMyRecording = latch
        let audio = fixture.makeAudio()
        try await audio.prepare()
        let running = Task { try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay) }
        feedBeyondLimit(fixture)
        try await expectBacklogExceeded(running)
        latch.release()
        audio.stop()
        _ = try? await within { try await audio.finish() }
        #expect(fixture.observations.values.contains(.finished(.自分)))
    }

    @Test("U2: 録音がなく STT が遅れて未消費が上限（2048 個）を超えたら、backlogExceeded で run が失敗する")
    func transcriberBacklogFailsRunWithoutRecording() async throws {
        let fixture = RunAudioFixture()
        fixture.recordingEnabled = false
        fixture.heldMicrophone = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let latch = Latch()
        fixture.stallMyTranscriber = latch
        let audio = fixture.makeAudio()
        try await audio.prepare()
        let running = Task { try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay) }
        feedBeyondLimit(fixture)
        try await expectBacklogExceeded(running)
        latch.release()
        audio.stop()
        try await audio.finish()
    }

    @Test("U2: ゲートを始める前に 相手 の transcribe が失敗しても、作った録音の入力を終わらせ、stop と finish が終わる")
    func failureBeforeGateFinishesMyRecording() async throws {
        let fixture = RunAudioFixture()
        fixture.theirTranscribeFailure = .recognition
        let audio = fixture.makeAudio()
        try await audio.prepare()
        await #expect(throws: AudioFailure.recognition) {
            try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        }
        audio.stop()
        do { try await within { try await audio.finish() } }
        catch is DeadlineExceeded { Issue.record("finish が終わらない（録音の入力が閉じていない）") }
        catch {}
        #expect(fixture.observations.values.contains(.finished(.自分)))
    }

    @Test("U2: 音を取っている途中で 自分 の録音の出力が失敗したら、マイクが終わるのを待たずに run がその失敗で終わる")
    func myRecordingFailureEndsRunWhileMicrophoneIsOpen() async throws {
        let fixture = RunAudioFixture()
        fixture.heldMicrophone = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        fixture.myRecordingOutputFails = true
        let audio = fixture.makeAudio()
        try await audio.prepare()
        let running = Task { try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay) }
        fixture.heldMicrophone?.continuation.yield(runSample(4, hostTime: 100))
        do {
            try await within { try await running.value }
            Issue.record("録音の失敗が run に伝わらなかった")
        } catch AudioFailure.myRecording {}
        catch let error as DeadlineExceeded {
            Issue.record("録音の失敗が run に伝わる前に期限切れ: \(fixture.observations.values)")
            throw error
        }
        audio.stop()
        do { try await within { try await audio.finish() } }
        catch let error as DeadlineExceeded {
            Issue.record("stop 後の録音の finish が期限切れ: \(fixture.observations.values)")
            throw error
        }
        #expect(fixture.observations.values.contains(.finished(.自分)))
    }

    @Test("C9: requestSelfPause は状態が変わったときだけ true を返す。同じ状態の指示は何も変えない")
    func requestSelfPauseReportsChangeOnly() async throws {
        let fixture = RunAudioFixture()
        let audio = fixture.makeAudio()
        try await audio.prepare()
        #expect(audio.requestSelfPause(false, at: 1) == false)
        #expect(audio.requestSelfPause(true, at: 2) == true)
        #expect(audio.requestSelfPause(true, at: 3) == false)
        #expect(audio.requestSelfPause(false, at: 4) == true)
    }

    @Test("C9: マイクの許可が無く 自分 を作らないときは、休止の指示を無視する（変わらず、音も流れない）")
    func requestSelfPauseIsIgnoredWithoutMicrophone() async throws {
        let fixture = RunAudioFixture()
        fixture.permissionFailure = MicrophoneError.permissionDenied
        let audio = fixture.makeAudio()
        try await audio.prepare()
        #expect(audio.requestSelfPause(true, at: 1) == false)
        #expect(audio.requestSelfPause(false, at: 2) == false)
        try await audio.run(origin: 123, marksDuplicates: false, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        #expect(fixture.observations.values.contains(.forwarded(.相手, runResult(.相手))))
        #expect(!fixture.observations.values.contains(.started(.自分)))
    }
}

private struct WaitTimeout: Error {}

private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<500 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    throw WaitTimeout()
}

private enum DiarizerFailureKind { case missing, loading }
