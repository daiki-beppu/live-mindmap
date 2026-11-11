import AVFoundation
import CoreAudio
import Foundation
@testable import HelperCore

let echoTestFrameSamples = 480

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

func hostTicks(milliseconds: Double) -> UInt64 {
    AudioConvertNanosToHostTime(UInt64(milliseconds * 1_000_000))
}

func referenceSamples(chunks: Range<Int>) -> [Float] {
    chunks.flatMap { Array(repeating: Float($0 + 1), count: echoTestFrameSamples) }
}

func captureSamples(chunks: Range<Int>) -> [Float] {
    chunks.flatMap { Array(repeating: Float($0 + 1) / 1000, count: echoTestFrameSamples) }
}

func captureValue(chunk: Int) -> Float { Float(chunk + 1) / 1000 }

func uniformValue(_ frame: [Float]) -> Float? {
    guard let first = frame.first, frame.allSatisfy({ $0 == first }) else { return nil }
    return first
}

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

func totalSeconds(_ audio: [CapturedAudio]) -> Double {
    audio.reduce(0) { $0 + Double($1.buffer.frameLength) / $1.buffer.format.sampleRate }
}

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
