import AVFoundation
import CoreAudio

/// 取得した時点のホスト時刻を付けた音声バッファ。2 トラックの時刻を同じ基準で揃えるために使う。
/// バッファは取得側がコピーして渡し、以後は受け取った側だけが読む。
public struct CapturedAudio: @unchecked Sendable {
    public let buffer: AVAudioPCMBuffer
    /// `AudioGetCurrentHostTime()` と同じ時計のホスト時刻（バッファの先頭の取得時刻）。
    public let hostTime: UInt64

    public init(buffer: AVAudioPCMBuffer, hostTime: UInt64) {
        self.buffer = buffer
        self.hostTime = hostTime
    }
}

/// 基準時刻 `origin` から `hostTime` までの秒数。`hostTime` が基準より前なら 0。
public func offsetSeconds(from origin: UInt64, to hostTime: UInt64) -> Double {
    guard hostTime > origin else { return 0 }
    return Double(AudioConvertHostTimeToNanos(hostTime - origin)) / 1_000_000_000
}

/// 1 トラック分の時刻補正。最初の音声の取得時刻から補正量を 1 回だけ決め、以後のすべての結果に同じ量を足す。
/// feeder が `record` を、collector が `align` を呼ぶ。最初の入力より前に結果は出ないので、`align` の時点では記録済み。
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
    /// `start` と `end` だけを `seconds` 秒ずらした結果。
    func shifted(by seconds: Double) -> TranscriptionResult {
        TranscriptionResult(text: text, isFinal: isFinal, start: start + seconds, end: end + seconds)
    }
}
