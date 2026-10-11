import AVFoundation
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
    case startedOrigin(Track, UInt64)
    case forwarded(Track, TranscriptionResult), duplicates(Bool), finished(Track)
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

private func runSample(_ value: Float) -> CapturedAudio {
    constantAudio(value: value, frames: 1, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: 123)
}

private func runResult(_ track: Track) -> TranscriptionResult {
    TranscriptionResult(text: track.rawValue, isFinal: true, start: 1, end: 2)
}

private struct RunTranscriber: Transcriber {
    let track: Track
    let observations: AudioObservations
    let prepareFailure: AudioFailure?
    let recognitionFailure: AudioFailure?

    func prepare() async throws {
        observations.append(.prepared(track))
        if let prepareFailure { throw prepareFailure }
    }

    func transcribe(_ audio: AudioStream, origin: UInt64) async throws -> ResultStream {
        observations.append(.origin(track, origin))
        for try await item in audio {
            let data = try #require(item.buffer.floatChannelData)
            observations.append(.heard(track, data[0][0]))
        }
        return ResultStream { continuation in
            if let recognitionFailure { continuation.finish(throwing: recognitionFailure) }
            else {
                continuation.yield(runResult(track))
                continuation.finish()
            }
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
    let started = AsyncStream<Track>.makeStream()

    func makeAudio() -> RunAudio {
        RunAudio(
            requestMicrophonePermission: {
                self.observations.append(.permission)
                if let error = self.permissionFailure { throw error }
            },
            makeTranscriber: { track in
                self.observations.append(.created(track))
                return RunTranscriber(
                    track: track, observations: self.observations,
                    prepareFailure: self.prepareFailure, recognitionFailure: self.recognitionFailure
                )
            },
            startAudio: { track, origin in
                self.observations.append(.started(track))
                self.observations.append(.startedOrigin(track, origin))
                self.started.continuation.yield(track)
                if let error = self.captureFailure, track == .自分 { throw error }
                if let held = self.heldAudio, track == .相手 { return held.stream }
                return audioStream([runSample(track == .相手 ? 1 : 4)])
            },
            stopAudio: { track in
                self.observations.append(.stopped(track))
                if track == .相手 { self.heldAudio?.continuation.finish() }
            },
            recording: recordingEnabled ? { track, stream, origin in
                self.observations.append(.recordingOrigin(track, origin))
                let (output, continuation) = AudioStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
                let finished = Task<Void, Error> {
                    defer { self.observations.append(.finished(track)) }
                    do {
                        for try await item in stream {
                            let data = try #require(item.buffer.floatChannelData)
                            self.observations.append(.recorded(track, data[0][0]))
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
                                continuation.yield(runSample(data[0][0] / 2))
                            }
                            continuation.finish()
                        } catch { continuation.finish(throwing: error) }
                    }
                }
            }
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
}
