import AVFoundation
import CoreAudio
import Foundation
import Testing
@testable import HelperCore

// トラックごとの録音（AAC・モノラル）。0 秒は発言の時刻の基準（origin）と同じ時点。

private func hostTime(after origin: UInt64, nanos: UInt64) -> UInt64 {
    origin + AudioConvertNanosToHostTime(nanos)
}

/// 440 Hz のサイン波を `seconds` 秒分入れたバッファ。
private func tone(sampleRate: Double, channels: AVAudioChannelCount, seconds: Double) throws -> AVAudioPCMBuffer {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channels))
    let frames = AVAudioFrameCount(sampleRate * seconds)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
    buffer.frameLength = frames
    for channel in 0..<Int(channels) {
        let samples = try #require(buffer.floatChannelData)[channel]
        for i in 0..<Int(frames) { samples[i] = 0.5 * Float(sin(2 * Double.pi * 440 * Double(i) / sampleRate)) }
    }
    return buffer
}

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("live-mindmap-recording-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// 録音ファイルの長さ（秒）。
private func duration(of url: URL) throws -> Double {
    let file = try AVAudioFile(forReading: url)
    return Double(file.length) / file.processingFormat.sampleRate
}

@Suite("録音")
struct RecordingITTests {

    @Test("存在しないフォルダへの録音は、初期化で throw する")
    func missingDirectoryThrows() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("live-mindmap-missing-\(UUID().uuidString)")
            .appendingPathComponent("相手.m4a")
        #expect(throws: (any Error).self) { try TrackRecorder(url: url, origin: AudioGetCurrentHostTime()) }
    }

    @Test("finish は何度呼んでもよく、閉じた後に読める")
    func finishIsIdempotent() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = AudioGetCurrentHostTime()
        let url = directory.appendingPathComponent("相手.m4a")
        let recorder = try TrackRecorder(url: url, origin: origin)
        try recorder.write(CapturedAudio(buffer: tone(sampleRate: 48_000, channels: 1, seconds: 0.2), hostTime: origin))

        try recorder.finish()
        try recorder.finish()

        #expect(try duration(of: url) > 0.1)
    }

    @Test("取得に 5 秒の空白があっても、録音の位置は同じ入力から作る発言の時刻と一致する")
    func recordingPositionMatchesTranscriptTimeAcrossCaptureGap() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = AudioGetCurrentHostTime()
        let url = directory.appendingPathComponent("相手.m4a")
        let recorder = try TrackRecorder(url: url, origin: origin)
        let timeline = TrackTimeline(origin: origin)

        // バッファ 1: 基準 + 0.5 秒、バッファ 2: 基準 + 5.5 秒（5 秒の取得の空白）。同じ入力を録音と発言の時刻の両方へ渡す
        let first = CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: hostTime(after: origin, nanos: 500_000_000))
        let second = CapturedAudio(buffer: try tone(sampleRate: 48_000, channels: 1, seconds: 0.1), hostTime: hostTime(after: origin, nanos: 5_500_000_000))
        for audio in [first, second] {
            try recorder.write(audio)
            timeline.record(audio)
        }
        try recorder.finish()

        // アナライザは空白なしでつないだ音声を受け取るので、バッファ 2 の中の発言は 0.1〜0.2 秒になる
        let aligned = timeline.align(TranscriptionResult(text: "はい", isFinal: true, start: 0.1, end: 0.2))

        // 録音の中のバッファ 2 の位置 = 先頭の無音 + バッファ 1 の長さ
        let silence = Double(leadingSilenceFrames(origin: origin, firstHostTime: first.hostTime, sampleRate: 48_000)) / 48_000
        #expect(abs(aligned.start - (silence + 0.1)) < 0.01)
        // 発言の終わりが、録音の終わり（空白は埋めない）と一致する
        #expect(abs(aligned.end - (try duration(of: url))) < 0.1)
    }
}
