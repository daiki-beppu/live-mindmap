import AVFoundation
import CoreAudio
import Foundation
import Testing
@testable import HelperCore

private struct StubFailure: Error, Equatable {}

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

@Suite("録音のラッパー")
struct RecordingStreamTests {
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
