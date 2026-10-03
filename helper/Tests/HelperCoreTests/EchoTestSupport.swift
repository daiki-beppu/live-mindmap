import AVFoundation
import CoreAudio
import Foundation
@testable import HelperCore

// エコーキャンセルのテストが共有する差し替え物と音声の作り方。

/// AEC に 1 回で渡すサンプル数（48 kHz の 10 ms）。
let echoTestFrameSamples = 480

/// 記録するだけの差し替え。reverse と capture の呼び出し順と、そのとき渡されたサンプルを残す。
/// capture は受け取ったサンプルを半分にして返す（出力が AEC の処理結果であることを見分けるため）。
final class RecordingEchoCanceller: EchoCanceller, @unchecked Sendable {
    enum Event: Equatable {
        case reverse([Float])
        case capture([Float])
    }

    private let lock = NSLock()
    private var recorded: [Event] = []

    var events: [Event] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func processReverse(_ frame: UnsafePointer<Float>) {
        append(.reverse(Array(UnsafeBufferPointer(start: frame, count: echoTestFrameSamples))))
    }

    func processCapture(_ frame: UnsafeMutablePointer<Float>) {
        append(.capture(Array(UnsafeBufferPointer(start: frame, count: echoTestFrameSamples))))
        for i in 0..<echoTestFrameSamples { frame[i] *= 0.5 }
    }

    private func append(_ event: Event) {
        lock.lock()
        defer { lock.unlock() }
        recorded.append(event)
    }
}

/// `milliseconds` ミリ秒分のホスト時刻の長さ。
func hostTicks(milliseconds: Double) -> UInt64 {
    AudioConvertNanosToHostTime(UInt64(milliseconds * 1_000_000))
}

/// 10 ms の区切り `chunks` の参照サンプル。区切り j は、すべてのサンプルが `Float(j + 1)`（無音の 0 と見分けられる）。
func referenceSamples(chunks: Range<Int>) -> [Float] {
    chunks.flatMap { Array(repeating: Float($0 + 1), count: echoTestFrameSamples) }
}

/// 10 ms の区切り `chunks` のマイクのサンプル。区切り j は、すべてのサンプルが `Float(j + 1) / 1000`。
func captureSamples(chunks: Range<Int>) -> [Float] {
    chunks.flatMap { Array(repeating: Float($0 + 1) / 1000, count: echoTestFrameSamples) }
}

func captureValue(chunk: Int) -> Float { Float(chunk + 1) / 1000 }

/// 全サンプルが同じ値ならその値。そうでなければ nil。
func uniformValue(_ frame: [Float]) -> Float? {
    guard let first = frame.first, frame.allSatisfy({ $0 == first }) else { return nil }
    return first
}

/// 全サンプルが `value` の `frames` フレームのバッファ。`interleaved` のときは全チャンネルが同じ値で交互に並ぶ。
func constantAudio(
    value: Float, frames: Int, sampleRate: Double, channels: AVAudioChannelCount, interleaved: Bool, hostTime: UInt64
) -> CapturedAudio {
    let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: channels, interleaved: interleaved)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    let data = buffer.floatChannelData!
    if interleaved {
        for i in 0..<(frames * Int(channels)) { data[0][i] = value }
    } else {
        for channel in 0..<Int(channels) {
            for i in 0..<frames { data[channel][i] = value }
        }
    }
    return CapturedAudio(buffer: buffer, hostTime: hostTime)
}

func collect(_ stream: AsyncThrowingStream<CapturedAudio, Error>) async throws -> [CapturedAudio] {
    var all: [CapturedAudio] = []
    for try await audio in stream { all.append(audio) }
    return all
}

/// 流れの要素の長さの合計（秒）。各バッファ自身のサンプルレートで数える。
func totalSeconds(_ audio: [CapturedAudio]) -> Double {
    audio.reduce(0) { $0 + Double($1.buffer.frameLength) / $1.buffer.format.sampleRate }
}

/// 各 capture の前に reverse が何回呼ばれていたか（capture の順）。
func reverseCountsBeforeEachCapture(_ events: [RecordingEchoCanceller.Event]) -> [Int] {
    var reverses = 0
    var counts: [Int] = []
    for event in events {
        switch event {
        case .reverse: reverses += 1
        case .capture: counts.append(reverses)
        }
    }
    return counts
}

func reverseFrames(_ events: [RecordingEchoCanceller.Event]) -> [[Float]] {
    events.compactMap { if case .reverse(let frame) = $0 { frame } else { nil } }
}

func captureFrames(_ events: [RecordingEchoCanceller.Event]) -> [[Float]] {
    events.compactMap { if case .capture(let frame) = $0 { frame } else { nil } }
}
