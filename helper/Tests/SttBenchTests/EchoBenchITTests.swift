import AVFoundation
import Foundation
import Testing
@testable import stt_bench

// `stt-bench echo` のうち、本物の filesystem に書いて読み戻す部分（軽い IT）。
// 偽の canceller だけで動く部分は EchoBenchTests.swift（unit）に置く。

private let rate = 48_000

/// 周期がサンプル数に対して整数になる正弦波。
private func sine(count: Int, hz: Double, amplitude: Float) -> [Float] {
    (0..<count).map { amplitude * Float(sin(2 * Double.pi * hz * Double($0) / Double(rate))) }
}

@Suite("エコー計測: wav の書き出し")
struct WriteWavITTests {
    @Test("writeWav は指定したサンプルレートで書き、読み戻すと同じレートと長さになる")
    func writeWavUsesGivenSampleRate() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("echo-bench-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        try writeWav(sine(count: rate, hz: 440, amplitude: 0.1), to: url, sampleRate: Double(rate))
        let file = try AVAudioFile(forReading: url)
        #expect(file.processingFormat.sampleRate == Double(rate))
        #expect(file.length == AVAudioFramePosition(rate))
    }
}
