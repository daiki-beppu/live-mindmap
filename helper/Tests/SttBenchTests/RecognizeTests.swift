import AVFoundation
import CoreAudio
import Foundation
import HelperCore
import Testing
@testable import stt_bench

// 認識結果が JSONL の 1 行（ResultLine）になるまでの受け渡し。音声認識は使わず、偽の Transcriber で流すので CI でも流す。

private final class FakeTranscriber: Transcriber, @unchecked Sendable {
    let results: [TranscriptionResult]
    private let lock = NSLock()
    private var _offsets: [Double] = []
    private var _origin: UInt64 = 0
    /// 渡された各バッファの hostTime − origin（秒）
    var offsets: [Double] { lock.withLock { _offsets } }
    var origin: UInt64 { lock.withLock { _origin } }

    init(results: [TranscriptionResult]) { self.results = results }

    func prepare() async throws {}

    func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        lock.withLock { _origin = origin }
        var offsets: [Double] = []
        for try await chunk in audio {
            offsets.append(Double(AudioConvertHostTimeToNanos(chunk.hostTime - origin)) / 1e9)
        }
        lock.withLock { _offsets = offsets }
        let results = self.results
        return AsyncThrowingStream { c in
            results.forEach { c.yield($0) }
            c.finish()
        }
    }
}

private func writeSilence(seconds: Double) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("stt-bench-\(UUID().uuidString).wav")
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(16000 * seconds))!
    buffer.frameLength = buffer.frameCapacity
    try file.write(from: buffer)
    return url
}

private final class Collector: @unchecked Sendable {
    private let lock = NSLock()
    private var _lines: [ResultLine] = []
    var lines: [ResultLine] { lock.withLock { _lines } }
    func add(_ l: ResultLine) { lock.withLock { _lines.append(l) } }
}

@Suite("認識結果から出力の 1 行まで")
struct RecognizeTests {
    @Test("結果の本文・区間・確定フラグはそのまま、到着時刻は流し始めからの秒で、届いた順に出る")
    func resultsBecomeLines() async throws {
        let url = try writeSilence(seconds: 0.35)
        defer { try? FileManager.default.removeItem(at: url) }
        let fake = FakeTranscriber(results: [
            TranscriptionResult(text: "明日の", isFinal: false, start: 0.1, end: 0.4),
            TranscriptionResult(text: "明日の会議。", isFinal: true, start: 0.2, end: 0.9),
        ])
        let collector = Collector()
        try await recognize(url, with: fake, start: ContinuousClock.now) { collector.add($0) }
        let lines = collector.lines
        #expect(lines.map(\.text) == ["明日の", "明日の会議。"])
        #expect(lines.map(\.isFinal) == [false, true])
        #expect(lines.map(\.start) == [0.1, 0.2])
        #expect(lines.map(\.end) == [0.4, 0.9])
        #expect(lines.allSatisfy { $0.track == "相手" })
        // 音声を実時間で流し切ったあとに結果が届くので、到着は音声の長さ以上で、順に増える
        #expect(lines[0].arrival >= 0.3)
        #expect(lines[1].arrival >= lines[0].arrival)
    }

    @Test("音声は 100 ms ずつ、バッファの hostTime が origin + ファイル内の位置で渡る")
    func bufferHostTimes() async throws {
        let url = try writeSilence(seconds: 0.35)
        defer { try? FileManager.default.removeItem(at: url) }
        let fake = FakeTranscriber(results: [])
        try await recognize(url, with: fake, start: ContinuousClock.now, emit: nil)
        let offsets = fake.offsets
        #expect(offsets.count == 4)
        for (got, want) in zip(offsets, [0.0, 0.1, 0.2, 0.3]) {
            #expect(abs(got - want) < 1e-3)
        }
    }
}
