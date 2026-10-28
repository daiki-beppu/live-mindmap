import AVFoundation
import Foundation
import Testing
@testable import HelperCore

// 本物の WeSpeaker（FluidAudio 同梱の CoreML の声の埋め込み。Issue #1024）を使う。
// モデルは helper/scripts/fetch-speaker-models.sh が Sortformer と同じ段で前もって取得する。会議中（prepare）には取りに行かない。
// モデルが無い環境では prepare() が modelMissing で失敗し、テストも失敗する（環境の問題として報告する）。
// 声は `say` の Kyoko（macOS 同梱の日本語の声）。処理する音声は短く保つ。

private let sampleRate = 16_000.0

private func synthesize(_ text: String, voice: String, in directory: URL) throws -> [Float] {
    let aiff = directory.appendingPathComponent("voice-\(UUID().uuidString).aiff")
    let say = Process()
    say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-v", voice, "-r", "190", "-o", aiff.path, text]
    try say.run()
    say.waitUntilExit()
    try #require(say.terminationStatus == 0, "say が失敗した: \(voice)")

    let file = try AVAudioFile(forReading: aiff)
    let target = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false))
    let converter = try #require(AVAudioConverter(from: file.processingFormat, to: target))
    let input = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
    try file.read(into: input)
    let capacity = AVAudioFrameCount(Double(input.frameLength) * sampleRate / file.processingFormat.sampleRate) + 16
    let output = try #require(AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity))
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
        if supplied {
            inputStatus.pointee = .noDataNow
            return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return input
    }
    try #require(status != .error, "変換に失敗: \(error?.localizedDescription ?? "")")
    try #require(Double(output.frameLength) / sampleRate > 2.0, "say の \(voice) が 2 秒未満の音声を書いた（\(output.frameLength) サンプル）: \(text)")
    return Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
}

@Suite("WeSpeakerEmbedder の声の埋め込み", .timeLimit(.minutes(2)))
struct WeSpeakerEmbedderHeavyTests {
    @Test("短い合成音声から、256 次元の有限で 0 でない埋め込みが作られる")
    func embedsSyntheticSpeech() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wespeaker-heavy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let samples = try synthesize("こんにちは、今日の会議を始めます。まず先週の進み具合から確認しましょう。", voice: "Kyoko", in: directory)

        let embedder = WeSpeakerEmbedder()
        try await embedder.prepare()
        let embedding = try embedder.embed(samples)

        #expect(embedding.count == 256)
        #expect(embedding.allSatisfy { $0.isFinite })
        #expect(embedding.contains { $0 != 0 })
    }

    @Test("同じ音声からは同じ向きの埋め込みになる（cos がほぼ 1）")
    func sameAudioGivesSameDirection() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wespeaker-heavy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let samples = try synthesize("来週はテストを書いて、レビューの依頼まで進める予定です。", voice: "Kyoko", in: directory)

        let embedder = WeSpeakerEmbedder()
        try await embedder.prepare()
        let a = try embedder.embed(samples)
        let b = try embedder.embed(samples)

        let dot = zip(a, b).reduce(Float(0)) { $0 + $1.0 * $1.1 }
        let norms = a.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot() * b.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
        #expect(dot / norms > 0.99)
    }

    @Test("モデルが無い場所では、prepare は取りに行かず modelMissing で失敗する")
    func missingModelFails() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("wespeaker-missing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let embedder = WeSpeakerEmbedder(modelDirectory: directory)
        do {
            try await embedder.prepare()
            Issue.record("モデルが無いのに prepare が成功した")
        } catch let error as SpeakerDiarizerError {
            guard case .modelMissing = error else {
                Issue.record("modelMissing ではない: \(error)")
                return
            }
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty, "prepare がモデルを取得してしまった")
    }
}
