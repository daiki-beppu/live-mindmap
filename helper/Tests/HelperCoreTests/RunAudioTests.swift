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
    case startedOrigin(Track, UInt64)
    case forwarded(Track, TranscriptionResult), duplicates(Bool), finished(Track)
    case diarizerPrepared, diarizerHeard(Float), diarizerOrigin(UInt64), speakerEvent(HelperEvent)
    /// Issue #1069: 休止で区間ごとに作る Transcriber の何番目（0 始まり）が、どの音を聞いた・聞き終えたか
    case segmentHeard(Track, Int, Float), segmentEnded(Track, Int)
}

/// Issue #1069: マイクの音の流れの台本。1 つ取り出されるごとに次の段へ進む（取り出しは、前の音をゲートが処理し終えてから起きる）。
private enum MicrophoneStep {
    case audio(Float, at: UInt64)
    /// `at` は指示を受け付けた時刻
    case requestPause(Bool, at: UInt64)
    /// 観測がそろうまで待つ。5 秒そろわなければ失敗にする（そろわない実装を止まらない待ちにしない）
    case waitFor(AudioObservation)
}

/// 解放されるまで待たせる部品
private final class Latch: @unchecked Sendable {
    private let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    init() { (stream, continuation) = AsyncStream.makeStream(of: Void.self) }
    func wait() async { for await _ in stream { return } }
    func release() { continuation.yield(); continuation.finish() }
}

private struct DeadlineExceeded: Error {}

/// `operation` を `seconds` 秒以内に終わらせる。終わらなければ DeadlineExceeded を投げる。
/// 止まる実装でテストを止めないよう、`operation` の終了は待たない（止まったままの Task はそのまま残す）
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

private func runSample(_ value: Float, hostTime: UInt64 = 123) -> CapturedAudio {
    constantAudio(value: value, frames: 1, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: hostTime)
}

/// 0 番目の Transcriber の結果は従来どおりの本文。休止の区間で作る 2 つ目以降は、番号を付けて区別する
private func runResult(_ track: Track, instance: Int = 0) -> TranscriptionResult {
    TranscriptionResult(text: instance == 0 ? track.rawValue : "\(track.rawValue)\(instance)", isFinal: true, start: 1, end: 2)
}

private struct RunTranscriber: Transcriber {
    let track: Track
    let instance: Int
    let observations: AudioObservations
    let prepareFailure: AudioFailure?
    let recognitionFailure: AudioFailure?
    /// transcribe の冒頭で投げる失敗（入力を読む前）
    var transcribeFailure: AudioFailure?
    /// 解放されるまで入力を読まない（読み出しが遅れる Transcriber）
    var stall: Latch?

    func prepare() async throws {
        observations.append(.prepared(track))
        if let prepareFailure { throw prepareFailure }
    }

    func transcribe(_ audio: AudioStream, origin: UInt64) async throws -> ResultStream {
        observations.append(.origin(track, origin))
        if let transcribeFailure { throw transcribeFailure }
        await stall?.wait()
        for try await item in audio {
            let data = try #require(item.buffer.floatChannelData)
            observations.append(.heard(track, data[0][0]))
            observations.append(.segmentHeard(track, instance, data[0][0]))
        }
        observations.append(.segmentEnded(track, instance))
        return ResultStream { continuation in
            if let recognitionFailure { continuation.finish(throwing: recognitionFailure) }
            else {
                continuation.yield(runResult(track, instance: instance))
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
    let streamFailure: Error?
    /// true なら、最初の音声を受け取った時点で（入力が開いたまま）区間を返して失敗し、以後は音声を読まない。
    let failsOnFirstAudio: Bool

    func prepare() async throws {
        observations.append(.diarizerPrepared)
        if let prepareFailure { throw prepareFailure }
    }

    func diarize(_ audio: AudioStream, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerSegment, Error> {
        observations.append(.diarizerOrigin(origin))
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await item in audio {
                        let data = try #require(item.buffer.floatChannelData)
                        observations.append(.diarizerHeard(data[0][0]))
                        if failsOnFirstAudio {
                            segments.forEach { continuation.yield($0) }
                            continuation.finish(throwing: streamFailure ?? DiarizerStreamFailure())
                            return
                        }
                    }
                    segments.forEach { continuation.yield($0) }
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
    var diarizerStreamFailure: Error?
    var diarizerFailsOnFirstAudio = false
    let started = AsyncStream<Track>.makeStream()
    var initiallySelfPaused = false
    /// 台本ではなく、テストが yield して終わらせる 自分 の入力。stopAudio(.自分) で終わる
    var heldMicrophone: (stream: AudioStream, continuation: AudioStream.Continuation)?
    var stallMyRecording: Latch?
    var stallMyTranscriber: Latch?
    var theirTranscribeFailure: AudioFailure?
    /// 自分 の録音の出力を、1 件目で失敗させる（入力は読み続ける）
    var myRecordingOutputFails = false
    var microphoneScript: MicrophoneScript?
    /// 台本の requestPause の段で呼ぶ。テストが RunAudio.requestSelfPause に結びつけ、戻り値を記録する
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
                    stall: track == .自分 ? self.stallMyTranscriber : nil
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
                    segments: self.diarizerSegments, streamFailure: self.diarizerStreamFailure,
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

    // Issue #1020: 話者分離。相手のトラックだけに掛け、失敗しても認識とセッションは続く
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
        let audio = fixture.makeAudio()
        try await audio.prepare()
        try await audio.run(origin: AudioGetCurrentHostTime(), marksDuplicates: speaker, relay: fixture.relay)
        audio.stop()
        try await audio.finish()
        let events = fixture.observations.values
        let origin = try #require(events.compactMap { if case .startedOrigin(.相手, let origin) = $0 { return origin }; return nil }.first)
        #expect(events.contains(.diarizerOrigin(origin)))
        #expect(events.contains(.diarizerHeard(1)))
        // 自分のマイク（4。AEC 後は 2）は話者分離に渡さない
        #expect(!events.contains(.diarizerHeard(4)))
        #expect(!events.contains(.diarizerHeard(2)))
        #expect(speakerEvents(fixture) == [
            .speaker(track: .相手, start: 1.5, end: 2.5, slot: 1, isFinal: false),
            .speaker(track: .相手, start: 0, end: 1.5, slot: 0, isFinal: true),
        ])
        // 認識・録音は話者分離の有無で変わらない
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
        // start は origin からの秒。流した時刻は origin と run が戻った時刻の間にあるので、実行環境の速さによらず決まる。
        #expect(start >= 0 && start <= offsetSeconds(from: origin, to: returned))
        let events = fixture.observations.values
        #expect(events.contains(.heard(.相手, 1)))
        #expect(events.contains(.recorded(.相手, 1)))
        #expect(events.contains(.forwarded(.相手, runResult(.相手))))
        #expect(events.contains(.forwarded(.自分, runResult(.自分))))
        #expect(events.contains(.finished(.相手)))
        // 準備できなかった話者分離には音声を渡さない
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
        // speaker-off が流れるまで待つ（話者分離は失敗済みで、入力はまだ開いている）
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

    // MARK: Issue #1069 自分の休止

    private func forwardedMine(_ events: [AudioObservation]) -> [TranscriptionResult] {
        events.compactMap { if case .forwarded(.自分, let result) = $0 { return result }; return nil }
    }
    private func recordedMine(_ events: [AudioObservation]) -> [Float] {
        events.compactMap { if case .recorded(.自分, let value) = $0 { return value }; return nil }
    }
    private func heardMine(_ events: [AudioObservation]) -> [Float] {
        events.compactMap { if case .heard(.自分, let value) = $0 { return value }; return nil }
    }

    @Test("C9: 休止の間の音は STT にも録音にも届かず、休止に入るまでの音は発言に確定し、再開後の音は新しい Transcriber に届く。相手は止まらない")
    func pausedMicrophoneAudioIsDroppedAndEarlierAudioIsFinalized() async throws {
        let fixture = RunAudioFixture()
        // 取る a(=4) → 休止 → b(=5)を捨てる → 区間が確定するまで待つ → 再開 → c(=6)
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

        // 録音・STT には a と c だけ。休止中の b はどこにも届かない
        #expect(recordedMine(events) == [4, 6])
        #expect(heardMine(events) == [4, 6])
        #expect(events.contains(.segmentHeard(.自分, 0, 4)))
        #expect(events.contains(.segmentHeard(.自分, 1, 6)))
        #expect(!events.contains { if case .segmentHeard(.自分, _, 5) = $0 { return true }; return false })
        // 休止に入る前の区間は、マイクの流れが終わる前に確定して発言になり、再開後は別の Transcriber が結果を返す（1 本につなぐ）
        #expect(forwardedMine(events) == [runResult(.自分, instance: 0), runResult(.自分, instance: 1)])
        // 区間ごとに新しい Transcriber を作って準備する（1 つの Transcriber に transcribe は 1 回だけ）
        #expect(events.filter { $0 == .created(.自分) }.count == 2)
        #expect(events.filter { $0 == .prepared(.自分) }.count == 2)
        // 相手は休止の影響を受けない
        #expect(events.contains(.heard(.相手, 1)))
        #expect(events.contains(.recorded(.相手, 1)))
        #expect(events.contains(.forwarded(.相手, runResult(.相手))))
    }

    @Test("C9: 休止のまま始めると、最初の音を捨て、再開した後の音だけが STT と録音に届く（起動し直しで休止が続く）")
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

        #expect(recordedMine(events) == [6])
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

        #expect(recordedMine(events) == [4])
        #expect(events.contains(.segmentEnded(.自分, 0)))
        #expect(events.contains(.finished(.自分)))
        #expect(forwardedMine(events) == [runResult(.自分, instance: 0)])
    }


    // MARK: 取得時刻での振り分け（読んだ時刻ではない）

    @Test("U1: 休止の前に取った音は、休止の後に読んでも STT と録音に流れ、休止の後の区間は新しい Transcriber になる")
    func audioAcquiredBeforePauseIsKeptWhenReadAfter() async throws {
        let fixture = RunAudioFixture()
        // a@100 → 休止@150 → b@200（休止中）→ 区間 0 の確定を待つ → 再開@250 → 休止@350 → c@300（再開中に取った音を、休止の後に読む）→ d@400（休止中）
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

        #expect(recordedMine(events) == [4, 6])
        #expect(heardMine(events) == [4, 6])
        #expect(events.contains(.segmentHeard(.自分, 1, 6)))
        #expect(forwardedMine(events).count == 2)
    }

    @Test("U1: 休止中に取った音は、再開の後に読んでも STT にも録音にも流れない")
    func audioAcquiredDuringPauseIsDroppedWhenReadAfterResume() async throws {
        let fixture = RunAudioFixture()
        // a@100 → 休止@150 → 再開@250 → b@200（休止中に取った音を、再開の後に読む）→ c@300
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

        #expect(recordedMine(events) == [4, 6])
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

    // MARK: ゲートの後ろのキューと終了処理

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
        audio.stop()
        try await within { try await audio.finish() }
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
