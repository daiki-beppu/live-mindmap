import AVFoundation
import Foundation
import Testing
@testable import HelperCore

// 本物の SpeechAnalyzer でファイルを文字にする。ja-JP のモデルがない環境・CI では流さない（SpeechAnalyzerTranscriberHeavyTests と同じ）。
// 短い合成音声（say -v Kyoko。前に 2 秒の無音を置く）を WAV にして transcribeFile へ通す。

private func synthesizedRecording(_ sentence: String, leadingSilence: Double, into dir: URL) throws -> URL {
    let aiff = dir.appendingPathComponent("speech.aiff")
    let say = Process()
    say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-v", "Kyoko", "-o", aiff.path, sentence]
    try say.run()
    say.waitUntilExit()
    try #require(say.terminationStatus == 0, "say -v Kyoko が失敗した（Kyoko の声が入っていない）")

    let spoken = try AVAudioFile(forReading: aiff)
    let format = spoken.processingFormat
    let silenceFrames = AVAudioFrameCount(format.sampleRate * leadingSilence)
    let silence = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: silenceFrames))
    silence.frameLength = silenceFrames
    let body = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(spoken.length)))
    try spoken.read(into: body)

    let url = dir.appendingPathComponent("meeting.wav")
    let out = try AVAudioFile(forWriting: url, settings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: format.sampleRate,
        AVNumberOfChannelsKey: format.channelCount,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
    ])
    try out.write(from: silence)
    try out.write(from: body)
    return url
}

@Suite("ファイルの文字起こし（本物の SpeechAnalyzer）", .timeLimit(.minutes(2)), .disabled(if: ProcessInfo.processInfo.environment["CI"] != nil, "CI のランナーには ja-JP の音声認識モデルが無い"))
struct FileTranscriptionHeavyTests {
    @Test("ファイルの音声の時刻つきの partial・final が、音声の長さより短い時間で出る")
    func transcribesFasterThanRealtime() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("file-transcription-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let leadingSilence = 2.0
        let url = try synthesizedRecording("明日の会議は十時から始めます。資料は事前に共有してください。", leadingSilence: leadingSilence, into: dir)
        let duration = try await fileDuration(of: url)
        let transcriber = SpeechAnalyzerTranscriber()
        try await transcriber.prepare()

        let clock = ContinuousClock()
        let started = clock.now
        var results: [TranscriptionResult] = []
        for try await item in try await transcribeFile(at: url, with: transcriber) { results.append(item) }
        let elapsed = started.duration(to: clock.now)

        let partials = results.filter { !$0.isFinal }
        let finals = results.filter(\.isFinal)
        #expect(!partials.isEmpty, "途中結果が 1 件も出なかった")
        #expect(!finals.isEmpty, "確定結果が 1 件も出なかった")
        for item in results {
            #expect(item.start >= 0 && item.end <= duration + 0.5, "時刻がファイルの範囲の外: \(item.start)〜\(item.end) / \(duration)")
        }
        let first = try #require(finals.first)
        #expect(first.start >= leadingSilence - 0.5, "最初の発言が、前に置いた無音の中から始まっている: \(first.start)")
        #expect(elapsed < .seconds(duration), "音声の長さ \(duration) 秒より時間がかかった: \(elapsed)")
    }
}
