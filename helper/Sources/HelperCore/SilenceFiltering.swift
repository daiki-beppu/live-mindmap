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

enum SilenceVerdict {
    case silent
    case audible
    case unmeasurable(Unmeasurable)
}

enum Unmeasurable: Equatable {
    case emptySpan
    case beforeFirstAudio
    case olderThanRetention
    case unsupportedFormat
    case sampleRateChanged
}

private struct EnergyRing {
    private let sampleRate: Double
    private var energies: [Float]
    private var recordedPosition = 0.0
    private var unmeasurableSpans: [(frames: Range<Int>, reason: Unmeasurable)] = []

    private var recordedFrames: Int { Int(recordedPosition.rounded()) }

    init(sampleRate: Double) {
        self.sampleRate = sampleRate
        energies = Array(repeating: .nan, count: max(1, Int((30 * sampleRate).rounded())))
    }

    mutating func record(_ buffer: AVAudioPCMBuffer) {
        let firstFrame = recordedFrames
        recordedPosition += Double(buffer.frameLength) * sampleRate / buffer.format.sampleRate
        let frames = firstFrame..<recordedFrames
        if buffer.format.sampleRate != sampleRate {
            writeUnmeasurable(frames: frames, reason: .sampleRateChanged)
        } else {
            let measured = forEachFrameMeanSquare(of: buffer) { frame, meanSquare in
                energies[(firstFrame + frame) % energies.count] = meanSquare
            }
            if !measured { writeUnmeasurable(frames: frames, reason: .unsupportedFormat) }
        }
        let oldest = max(0, recordedFrames - energies.count)
        unmeasurableSpans = unmeasurableSpans.compactMap { span in
            guard span.frames.upperBound > oldest else { return nil }
            return (max(oldest, span.frames.lowerBound)..<span.frames.upperBound, span.reason)
        }
    }

    private mutating func writeUnmeasurable(frames: Range<Int>, reason: Unmeasurable) {
        guard !frames.isEmpty else { return }
        for frame in max(frames.lowerBound, frames.upperBound - energies.count)..<frames.upperBound {
            energies[frame % energies.count] = .nan
        }
        if let last = unmeasurableSpans.last, last.reason == reason, last.frames.upperBound == frames.lowerBound {
            unmeasurableSpans[unmeasurableSpans.count - 1].frames = last.frames.lowerBound..<frames.upperBound
        } else {
            unmeasurableSpans.append((frames, reason))
        }
    }

    func verdict(start: Double, end: Double) -> SilenceVerdict {
        guard end > 0 else { return .unmeasurable(.beforeFirstAudio) }
        let firstPosition = max(0, start * sampleRate)
        let endPosition = min(Double(recordedFrames), end * sampleRate)
        guard firstPosition < endPosition else { return .unmeasurable(.emptySpan) }
        let firstFrame = Int(firstPosition.rounded(.up))
        let endFrame = Int(endPosition.rounded(.up))
        guard firstFrame < endFrame else { return .unmeasurable(.emptySpan) }
        guard firstFrame >= recordedFrames - energies.count else { return .unmeasurable(.olderThanRetention) }
        if let span = unmeasurableSpans.first(where: { $0.frames.overlaps(firstFrame..<endFrame) }) {
            return .unmeasurable(span.reason)
        }
        var sum = 0.0
        for frame in firstFrame..<endFrame {
            let value = energies[frame % energies.count]
            guard !value.isNaN else { return .unmeasurable(.unsupportedFormat) }
            sum += Double(value)
        }
        return isSilentMeanSquare(sum / Double(endFrame - firstFrame)) ? .silent : .audible
    }
}


final class TrackLoudness: @unchecked Sendable {
    private let origin: UInt64
    private let lock = NSLock()
    private var basis: Double?
    private var ring: EnergyRing?

    init(origin: UInt64) {
        self.origin = origin
    }

    func record(_ audio: CapturedAudio) {
        let buffer = audio.buffer
        guard buffer.frameLength > 0, buffer.format.sampleRate > 0 else { return }

        lock.lock()
        defer { lock.unlock() }
        if basis == nil {
            basis = offsetSeconds(from: origin, to: audio.hostTime)
            ring = EnergyRing(sampleRate: buffer.format.sampleRate)
        }

        ring?.record(buffer)
    }

    func verdict(start: Double, end: Double) -> SilenceVerdict {
        guard start.isFinite, end.isFinite, end > start else { return .unmeasurable(.emptySpan) }

        lock.lock()
        defer { lock.unlock() }
        guard let basis, let ring else { return .unmeasurable(.beforeFirstAudio) }
        return ring.verdict(start: start - basis, end: end - basis)
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
        let measured = observing(audio, each: { loudness.record($0) })
        let results = try await base.transcribe(measured.stream, origin: origin)
        return filteredStream(results, loudness: loudness)
    }
}

private func filteredStream(
    _ results: AsyncThrowingStream<TranscriptionResult, Error>,
    loudness: TrackLoudness
) -> AsyncThrowingStream<TranscriptionResult, Error> {
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self, throwing: Error.self)
    let task = Task {
        do {
            for try await result in results {
                if case .silent = loudness.verdict(start: result.start, end: result.end) { continue }
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
