import AVFoundation
import Foundation
import Speech
import Testing
@testable import HelperCore

// ファイル 1 本を文字にする経路（transcribeFile）の IT。文字にする役（FileTranscriber）は偽物で、結果の区間を台本で返す。
// ファイルは、テストの中で作った 4 秒の WAV（0〜2 秒は 440 Hz のサイン波、2〜4 秒は完全な無音）。
// 確かめること: 役へ渡る音声の位置がファイルの位置と一致すること、無音の区間の結果だけが捨てられること、測れない区間の結果は残ること。

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("live-mindmap-file-transcription-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private let sampleRate = 16_000.0

/// 前半 `loudSeconds` 秒がサイン波、後半 `silentSeconds` 秒が無音の WAV。
private func writeRecording(_ url: URL, loudSeconds: Double, silentSeconds: Double) throws {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1))
    let frames = AVAudioFrameCount(sampleRate * (loudSeconds + silentSeconds))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames
    let samples = try #require(buffer.floatChannelData)[0]
    let loudFrames = Int(sampleRate * loudSeconds)
    for i in 0..<Int(frames) {
        samples[i] = i < loudFrames ? 0.5 * Float(sin(2 * Double.pi * 440 * Double(i) / sampleRate)) : 0
    }
    let file = try AVAudioFile(forWriting: url, settings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
    ])
    try file.write(from: buffer)
}

/// 渡された音声を全部受け取り、その長さと開始位置の記録を残してから、台本の結果を返す偽の役。
private final class ScriptedFileTranscriber: FileTranscriber, @unchecked Sendable {
    private let lock = NSLock()
    private var _receivedSeconds = 0.0
    private var _statedStarts: [Double] = []
    private let script: [TranscriptionResult]

    init(script: [TranscriptionResult]) { self.script = script }

    var receivedSeconds: Double { lock.withLock { _receivedSeconds } }
    var statedStarts: [Double] { lock.withLock { _statedStarts } }

    func prepare() async throws {}

    func transcribe(_ inputs: FileAudioInputs) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        var position = 0.0
        for try await input in inputs {
            if let start = input.bufferStartTime {
                lock.withLock { _statedStarts.append(start.seconds - position) }
            }
            position += Double(input.buffer.frameLength) / input.buffer.format.sampleRate
        }
        lock.withLock { _receivedSeconds = position }
        let script = self.script
        return AsyncThrowingStream { continuation in
            for result in script { continuation.yield(result) }
            continuation.finish()
        }
    }
}

private func result(_ text: String, isFinal: Bool, _ start: Double, _ end: Double) -> TranscriptionResult {
    TranscriptionResult(text: text, isFinal: isFinal, start: start, end: end)
}

@Suite("ファイルを文字にする経路（transcribeFile）", .timeLimit(.minutes(1)))
struct FileTranscriptionITTests {
    @Test("全体の長さは、ファイルの音声の長さ（秒）")
    func durationOfFile() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("meeting.wav")
        try writeRecording(url, loudSeconds: 2, silentSeconds: 2)

        let seconds = try await fileDuration(of: url)

        #expect(abs(seconds - 4.0) < 0.01)
    }

    @Test("役へ渡る音声は、ファイルの 0 秒から途切れず最後まで続く。位置を明示する入力は、ファイル上の位置と一致する")
    func audioHandedOverIsContiguousFromZero() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("meeting.wav")
        try writeRecording(url, loudSeconds: 2, silentSeconds: 2)
        let transcriber = ScriptedFileTranscriber(script: [])

        let stream = try await transcribeFile(at: url, with: transcriber)
        for try await _ in stream {}

        #expect(abs(transcriber.receivedSeconds - 4.0) < 0.01)
        for drift in transcriber.statedStarts { #expect(abs(drift) < 0.001, "入力の開始位置がファイルの位置からずれている: \(drift)") }
    }

    @Test("無音の区間の結果（partial・final とも）だけが捨てられる。大きい音の区間の結果と、測れない区間（ファイルの外）の結果は、時刻をそのままに残る")
    func silentIntervalResultsAreDropped() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("meeting.wav")
        try writeRecording(url, loudSeconds: 2, silentSeconds: 2)
        let transcriber = ScriptedFileTranscriber(script: [
            result("大きい音", isFinal: false, 0.5, 1.5),
            result("大きい音です", isFinal: true, 0.5, 1.5),
            result("無音の幻", isFinal: false, 2.5, 3.5),
            result("無音の幻です", isFinal: true, 2.5, 3.5),
            result("ファイルの外", isFinal: true, 10, 11),
        ])

        let stream = try await transcribeFile(at: url, with: transcriber)
        var kept: [TranscriptionResult] = []
        for try await item in stream { kept.append(item) }

        #expect(kept == [
            result("大きい音", isFinal: false, 0.5, 1.5),
            result("大きい音です", isFinal: true, 0.5, 1.5),
            result("ファイルの外", isFinal: true, 10, 11),
        ])
    }
}
