import AVFoundation
import CoreAudio
import Foundation
import Testing
@testable import HelperCore

// トラックごとの録音（AAC・モノラル）。0 秒は発言の時刻の基準（origin）と同じ時点。

private struct StubFailure: Error, Equatable {}

private func hostTime(after origin: UInt64, nanos: UInt64) -> UInt64 {
    origin + AudioConvertNanosToHostTime(nanos)
}

/// 440 Hz のサイン波を `seconds` 秒分入れたバッファ。
private func tone(sampleRate: Double, channels: AVAudioChannelCount, seconds: Double) throws -> AVAudioPCMBuffer {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channels))
    let frames = AVAudioFrameCount(sampleRate * seconds)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames
    for channel in 0..<Int(channels) {
        let samples = try #require(buffer.floatChannelData)[channel]
        for i in 0..<Int(frames) { samples[i] = 0.5 * Float(sin(2 * Double.pi * 440 * Double(i) / sampleRate)) }
    }
    return buffer
}

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("live-mindmap-recording-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// 録音ファイルの長さ（秒）。
private func duration(of url: URL) throws -> Double {
    let file = try AVAudioFile(forReading: url)
    return Double(file.length) / file.processingFormat.sampleRate
}

@Suite("録音")
struct RecordingTests {
    @Test("2 チャンネル・1 チャンネルのどちらの入力でも、AAC・モノラルのファイルになる")
    func writesMonoAAC() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = AudioGetCurrentHostTime()
        for (name, sampleRate, channels) in [("stereo.m4a", 44_100.0, AVAudioChannelCount(2)), ("mono.m4a", 16_000.0, AVAudioChannelCount(1))] {
            let url = directory.appendingPathComponent(name)
            let recorder = try TrackRecorder(url: url, origin: origin)
            // 実際の取得と同じく複数のバッファを続けて書く（サンプルレート変換は、1 つ目のバッファの一部を後続の書き込みで出す）
            for _ in 0..<4 {
                try recorder.write(CapturedAudio(buffer: tone(sampleRate: sampleRate, channels: channels, seconds: 0.5), hostTime: origin))
            }
            try recorder.finish()

            let file = try AVAudioFile(forReading: url)
            #expect(file.fileFormat.settings[AVFormatIDKey] as? UInt32 == kAudioFormatMPEG4AAC)
            #expect(file.fileFormat.channelCount == 1)
            // 話者分離にかけられる音質: サンプルレート 16 kHz 以上
            #expect(file.fileFormat.sampleRate == recordingSampleRate)
            #expect(file.fileFormat.sampleRate >= 16_000)
            // 入力は計 2 秒。サンプルレート変換の持ち越し分も `finish` で書くので、末尾まで残る（AAC の端数の分だけ許容）
            #expect(abs(try duration(of: url) - 2.0) < 0.1)
        }
    }

    @Test("録音の音質の設定は、話者分離にかけられる下限（AAC 64 kbps・16 kHz）以上")
    func qualityConstantsMeetFloor() {
        #expect(recordingBitRate >= 64_000)
        #expect(recordingSampleRate >= 16_000)
        #expect(recordingChannelCount == 1)
    }

    @Test("存在しないフォルダへの録音は、初期化で throw する")
    func missingDirectoryThrows() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("live-mindmap-missing-\(UUID().uuidString)")
            .appendingPathComponent("相手.m4a")
        #expect(throws: (any Error).self) { try TrackRecorder(url: url, origin: AudioGetCurrentHostTime()) }
    }

    @Test("finish は何度呼んでもよく、閉じた後に読める")
    func finishIsIdempotent() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = AudioGetCurrentHostTime()
        let url = directory.appendingPathComponent("相手.m4a")
        let recorder = try TrackRecorder(url: url, origin: origin)
        try recorder.write(CapturedAudio(buffer: tone(sampleRate: 48_000, channels: 1, seconds: 0.2), hostTime: origin))

        try recorder.finish()
        try recorder.finish()

        #expect(try duration(of: url) > 0.1)
    }

    @Test("最初のバッファが基準より 0.5 秒後なら、先頭に 0.5 秒分（24000 フレーム）の無音を入れる")
    func leadingSilenceAfterOrigin() {
        let origin = AudioGetCurrentHostTime()
        let frames = leadingSilenceFrames(origin: origin, firstHostTime: hostTime(after: origin, nanos: 500_000_000), sampleRate: 48_000)
        #expect(abs(Int(frames) - 24_000) <= 48)
    }

    @Test("最初のバッファが基準と同じか前なら、無音は入れない")
    func noLeadingSilenceAtOrBeforeOrigin() {
        let origin = AudioGetCurrentHostTime() + AudioConvertNanosToHostTime(5_000_000_000)
        #expect(leadingSilenceFrames(origin: origin, firstHostTime: origin, sampleRate: 48_000) == 0)
        let earlier = origin - AudioConvertNanosToHostTime(2_000_000_000)
        #expect(leadingSilenceFrames(origin: origin, firstHostTime: earlier, sampleRate: 48_000) == 0)
    }

    @Test("基準より 0.5 秒後に始まる 0.1 秒分の音声を書くと、ファイルの長さは約 0.6 秒になる")
    func fileDurationIncludesLeadingSilence() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = AudioGetCurrentHostTime()
        let url = directory.appendingPathComponent("自分.m4a")
        let recorder = try TrackRecorder(url: url, origin: origin)

        try recorder.write(CapturedAudio(buffer: tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: hostTime(after: origin, nanos: 500_000_000)))
        try recorder.finish()

        #expect(abs(try duration(of: url) - 0.6) < 0.1)
    }

    @Test("取得に 5 秒の空白があっても、録音の位置は同じ入力から作る発言の時刻と一致する")
    func recordingPositionMatchesTranscriptTimeAcrossCaptureGap() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = AudioGetCurrentHostTime()
        let url = directory.appendingPathComponent("相手.m4a")
        let recorder = try TrackRecorder(url: url, origin: origin)
        let timeline = TrackTimeline(origin: origin)

        // バッファ 1: 基準 + 0.5 秒、バッファ 2: 基準 + 5.5 秒（5 秒の取得の空白）。同じ入力を録音と発言の時刻の両方へ渡す
        let first = CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: hostTime(after: origin, nanos: 500_000_000))
        let second = CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: hostTime(after: origin, nanos: 5_500_000_000))
        for audio in [first, second] {
            try recorder.write(audio)
            timeline.record(audio)
        }
        try recorder.finish()

        // アナライザは空白なしでつないだ音声を受け取るので、バッファ 2 の中の発言は 0.1〜0.2 秒になる
        let aligned = timeline.align(TranscriptionResult(text: "はい", isFinal: true, start: 0.1, end: 0.2))

        // 録音の中のバッファ 2 の位置 = 先頭の無音 + バッファ 1 の長さ
        let silence = Double(leadingSilenceFrames(origin: origin, firstHostTime: first.hostTime, sampleRate: 48_000)) / 48_000
        #expect(abs(aligned.start - (silence + 0.1)) < 0.01)
        // 発言の終わりが、録音の終わり（空白は埋めない）と一致する
        #expect(abs(aligned.end - (try duration(of: url))) < 0.1)
    }
}

@Suite("録音のラッパー")
struct RecordingStreamTests {
    private func makeRecorder(in directory: URL, origin: UInt64) throws -> (TrackRecorder, URL) {
        let url = directory.appendingPathComponent("相手.m4a")
        return (try TrackRecorder(url: url, origin: origin), url)
    }

    @Test("上流の音声をそのまま下流へ流し、上流が終わると録音を閉じてから下流も終わる")
    func passesThroughAndFinishes() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = AudioGetCurrentHostTime()
        let (recorder, url) = try makeRecorder(in: directory, origin: origin)
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (stream, finished) = recording(upstream, to: recorder)

        for i in 0..<3 {
            input.yield(CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: hostTime(after: origin, nanos: UInt64(i) * 100_000_000)))
        }
        input.finish()

        var count = 0
        for try await _ in stream { count += 1 }
        try await finished.value

        #expect(count == 3)
        #expect(abs(try duration(of: url) - 0.3) < 0.1)
    }

    @Test("上流がエラーで終わると、録音を閉じ、下流も同じエラーで終わる")
    func upstreamErrorFinishesRecordingAndPropagates() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = AudioGetCurrentHostTime()
        let (recorder, url) = try makeRecorder(in: directory, origin: origin)
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (stream, finished) = recording(upstream, to: recorder)

        input.yield(CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.2), hostTime: origin))
        input.finish(throwing: StubFailure())

        var thrown: Error?
        do { for try await _ in stream {} } catch { thrown = error }
        let result = await finished.result

        #expect(thrown as? StubFailure == StubFailure())
        #expect(throws: StubFailure.self) { try result.get() }
        #expect(try duration(of: url) > 0.1)
    }

    @Test("下流が先に終わっても録音は続き、finished は上流が終わった時点で完了する")
    func downstreamCancellationDoesNotStopRecording() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = AudioGetCurrentHostTime()
        let (recorder, url) = try makeRecorder(in: directory, origin: origin)
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (stream, finished) = recording(upstream, to: recorder)

        input.yield(CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: origin))
        for try await _ in stream { break } // 下流（文字起こし）が 1 つ受け取って止まる
        // 下流が止まった後の音声も録音される
        input.yield(CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.4), hostTime: hostTime(after: origin, nanos: 100_000_000)))
        input.finish()
        try await finished.value

        #expect(abs(try duration(of: url) - 0.5) < 0.1)
    }

    private struct FinishFailure: Error, Equatable {}

    /// `finish` だけを失敗させる差し替え用の recorder。
    private struct FailingFinishRecorder: TrackRecording {
        func write(_ audio: CapturedAudio) throws {}
        func finish() throws { throw FinishFailure() }
    }

    @Test("上流が正常に終わり finish が失敗すると、下流と finished がその失敗で終わる")
    func finishFailureAfterNormalEndPropagates() async throws {
        let origin = AudioGetCurrentHostTime()
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (stream, finished) = recordingStream(upstream, to: FailingFinishRecorder())

        input.yield(CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: origin))
        input.finish()

        var thrown: Error?
        do { for try await _ in stream {} } catch { thrown = error }
        let result = await finished.result

        #expect(thrown as? FinishFailure == FinishFailure())
        #expect(throws: FinishFailure.self) { try result.get() }
    }

    @Test("下流が先に終わっても、上流が正常に終わって finish が失敗すれば、finished が失敗を運ぶ")
    func finishFailureReachesFinishedAfterDownstreamStopped() async throws {
        let origin = AudioGetCurrentHostTime()
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (stream, finished) = recordingStream(upstream, to: FailingFinishRecorder())

        input.yield(CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: origin))
        for try await _ in stream { break }
        input.finish()
        let result = await finished.result

        #expect(throws: FinishFailure.self) { try result.get() }
    }

    /// `write` を失敗させ、`finish` が呼ばれた回数を数える差し替え用の recorder。
    private final class FailingWriteRecorder: TrackRecording, @unchecked Sendable {
        private let lock = NSLock()
        private var finishCalls = 0
        var finishCount: Int { lock.lock(); defer { lock.unlock() }; return finishCalls }
        func write(_ audio: CapturedAudio) throws { throw StubFailure() }
        func finish() throws { lock.lock(); finishCalls += 1; lock.unlock() }
    }

    @Test("書き込みが失敗すると、録音を閉じ、下流と finished がその失敗で終わる")
    func writeFailureFinishesRecordingAndPropagates() async throws {
        let origin = AudioGetCurrentHostTime()
        let recorder = FailingWriteRecorder()
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (stream, finished) = recordingStream(upstream, to: recorder)

        input.yield(CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: origin))

        var thrown: Error?
        do { for try await _ in stream {} } catch { thrown = error }
        let result = await finished.result

        #expect(thrown as? StubFailure == StubFailure())
        #expect(throws: StubFailure.self) { try result.get() }
        #expect(recorder.finishCount == 1)
    }

    @Test("上流のエラーが先にあれば、finish も失敗してもそのエラーが基準のまま残る")
    func upstreamErrorRemainsPrimaryWhenFinishAlsoFails() async throws {
        let origin = AudioGetCurrentHostTime()
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (stream, finished) = recordingStream(upstream, to: FailingFinishRecorder())

        input.yield(CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: origin))
        input.finish(throwing: StubFailure())

        var thrown: Error?
        do { for try await _ in stream {} } catch { thrown = error }
        let result = await finished.result

        #expect(thrown as? StubFailure == StubFailure())
        #expect(throws: StubFailure.self) { try result.get() }
    }
}
