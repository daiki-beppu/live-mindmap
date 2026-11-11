import AVFoundation
import Foundation

// 音声認識が完全な無音から文字を作ることがある（Issue #144）。認識結果の区間（start〜end）に STT へ渡した音
// （AEC の後）の音量がしきい値未満なら、その結果（途中結果・確定とも）をヘルパーから送らない。判定は区間の音量だけで行い、
// 文の中身（テキストの長さ・語彙）では判定しない。

let silenceThresholdDBFS: Double = -70

private let silenceThresholdMeanSquare = pow(10, silenceThresholdDBFS / 10)

func isSilentMeanSquare(_ meanSquare: Double) -> Bool {
    meanSquare < silenceThresholdMeanSquare
}

/// interleaved な形式（`相手` の ProcessTap の 2ch 出力）はチャンネルが channelData[0] に交互に並ぶだけで、
/// channelData[1] 以降は存在しない（EchoCancellation.swift の EchoInputConverter と同じ前提）。
@discardableResult
func forEachFrameMeanSquare(of buffer: AVAudioPCMBuffer, _ body: (Int, Float) -> Void) -> Bool {
    let format = buffer.format
    guard format.commonFormat == .pcmFormatFloat32, let channelData = buffer.floatChannelData else { return false }
    let channels = Int(format.channelCount)
    guard channels > 0 else { return false }
    let interleaved = format.isInterleaved
    for frame in 0..<Int(buffer.frameLength) {
        var sumOfSquares = 0.0
        for channel in 0..<channels {
            let sample = interleaved
                ? Double(channelData[0][frame * channels + channel])
                : Double(channelData[channel][frame])
            sumOfSquares += sample * sample
        }
        body(frame, Float(sumOfSquares / Double(channels)))
    }
    return true
}

private let loudnessRetentionSeconds = 30.0


final class TrackLoudness: @unchecked Sendable {
    private let origin: UInt64
    private let lock = NSLock()
    private var basis: Double?
    private var sampleRate: Double = 0
    private var energies: [Float] = []
    private var recordedFrames = 0

    init(origin: UInt64) {
        self.origin = origin
    }

    func record(_ audio: CapturedAudio) {
        let buffer = audio.buffer
        let format = buffer.format
        let frames = Int(buffer.frameLength)
        let sampleRate = format.sampleRate
        guard frames > 0, sampleRate > 0 else { return }

        lock.lock()
        defer { lock.unlock() }
        if basis == nil {
            basis = offsetSeconds(from: origin, to: audio.hostTime)
            self.sampleRate = sampleRate
            energies = Array(repeating: .nan, count: Int((loudnessRetentionSeconds * sampleRate).rounded()))
        }

        let measured = forEachFrameMeanSquare(of: buffer) { frame, meanSquare in
            energies[(recordedFrames + frame) % energies.count] = meanSquare
        }
        guard measured else {
            writeUnmeasurable(frames: frames)
            return
        }
        recordedFrames += frames
    }

    private func writeUnmeasurable(frames: Int) {
        for frame in 0..<frames {
            energies[(recordedFrames + frame) % energies.count] = .nan
        }
        recordedFrames += frames
    }

    func isBelowSilenceThreshold(start: Double, end: Double) -> Bool? {
        guard end > start else { return nil }

        lock.lock()
        defer { lock.unlock() }
        guard let basis, sampleRate > 0 else { return nil }

        let firstPosition = max(0, (start - basis) * sampleRate)
        let endPosition = min(Double(recordedFrames), (end - basis) * sampleRate)
        guard firstPosition < endPosition else { return nil }

        let firstFrame = Int(firstPosition.rounded(.up))
        let endFrame = Int(endPosition.rounded(.up))
        guard firstFrame < endFrame else { return nil }

        if firstFrame < recordedFrames - energies.count {
            return nil
        }

        var sum = 0.0
        for frame in firstFrame..<endFrame {
            let value = energies[frame % energies.count]
            guard !value.isNaN else { return nil }
            sum += Double(value)
        }
        return isSilentMeanSquare(sum / Double(endFrame - firstFrame))
    }
}

public final class SilenceFilteringTranscriber: Transcriber {
    private let base: any Transcriber

    public init(wrapping base: any Transcriber) {
        self.base = base
    }

    public func prepare() async throws {
        try await base.prepare()
    }

    public func transcribe(
        _ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64
    ) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        let loudness = TrackLoudness(origin: origin)
        let measured = measuredStream(audio, loudness: loudness)
        let results = try await base.transcribe(measured, origin: origin)
        return filteredStream(results, loudness: loudness)
    }
}

private func measuredStream(
    _ upstream: AsyncThrowingStream<CapturedAudio, Error>,
    loudness: TrackLoudness
) -> AsyncThrowingStream<CapturedAudio, Error> {
    let (stream, continuation) = AsyncThrowingStream.makeStream(
        of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(downstreamBacklogLimit))
    let task = Task {
        do {
            for try await captured in upstream {
                loudness.record(captured)
                if case .dropped = continuation.yield(captured) {
                    throw TranscriberError.backlogExceeded(limit: downstreamBacklogLimit)
                }
            }
            continuation.finish()
        } catch {
            continuation.finish(throwing: error)
        }
    }
    continuation.onTermination = { _ in task.cancel() }
    return stream
}

private func filteredStream(
    _ results: AsyncThrowingStream<TranscriptionResult, Error>,
    loudness: TrackLoudness
) -> AsyncThrowingStream<TranscriptionResult, Error> {
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self, throwing: Error.self)
    let task = Task {
        do {
            for try await result in results {
                if isSilent(result, loudness: loudness) { continue }
                continuation.yield(result)
            }
            continuation.finish()
        } catch {
            continuation.finish(throwing: error)
        }
    }
    continuation.onTermination = { _ in task.cancel() }
    return stream
}

private func isSilent(_ result: TranscriptionResult, loudness: TrackLoudness) -> Bool {
    loudness.isBelowSilenceThreshold(start: result.start, end: result.end) ?? false
}
