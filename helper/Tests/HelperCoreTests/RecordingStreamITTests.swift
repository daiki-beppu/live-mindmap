import AVFoundation
import CoreAudio
import Foundation
import Testing
@testable import HelperCore

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

@Suite("録音のラッパー")
struct RecordingStreamITTests {
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
}
