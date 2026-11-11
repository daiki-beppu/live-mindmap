import AVFoundation
import CoreAudio

public struct CapturedAudio: @unchecked Sendable {
    public let buffer: AVAudioPCMBuffer
    public let hostTime: UInt64

    public init(buffer: AVAudioPCMBuffer, hostTime: UInt64) {
        self.buffer = buffer
        self.hostTime = hostTime
    }
}

public func offsetSeconds(from origin: UInt64, to hostTime: UInt64) -> Double {
    guard hostTime > origin else { return 0 }
    return Double(AudioConvertHostTimeToNanos(hostTime - origin)) / 1_000_000_000
}

final class TrackTimeline: @unchecked Sendable {
    private let origin: UInt64
    private let lock = NSLock()
    private var seconds: Double?

    init(origin: UInt64) {
        self.origin = origin
    }

    func record(_ audio: CapturedAudio) {
        lock.lock()
        defer { lock.unlock() }
        if seconds == nil { seconds = offsetSeconds(from: origin, to: audio.hostTime) }
    }

    func align(_ result: TranscriptionResult) -> TranscriptionResult {
        lock.lock()
        let shift = seconds ?? 0
        lock.unlock()
        return result.shifted(by: shift)
    }
}

extension TranscriptionResult {
    func shifted(by seconds: Double) -> TranscriptionResult {
        TranscriptionResult(
            text: text, isFinal: isFinal, start: start + seconds, end: end + seconds,
            wordTimes: wordTimes.map {
                WordTime(location: $0.location, length: $0.length, start: $0.start + seconds, end: $0.end + seconds)
            })
    }
}
