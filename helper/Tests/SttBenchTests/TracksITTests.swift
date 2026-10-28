import AVFoundation
import Foundation
import Testing
@testable import stt_bench

// Issue #1031: `stt-bench tracks` の本体 buildTracks をファイルで通す。会議のフォルダ（timeline.tsv・voices.json・lines/）を一時フォルダに作り、
// 出力の 自分.wav に進行役の行の音声だけ、相手.wav に残りの行の音声だけが、start の位置で入り、2 本の長さが同じことを読み戻して確かめる。

private func constant(_ value: Float, seconds: Double) -> [Float] {
    [Float](repeating: value, count: Int(seconds * synthSampleRate))
}

private func readBack(_ url: URL) throws -> [Float] {
    let file = try AVAudioFile(forReading: url)
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
    try file.read(into: buffer)
    return Array(UnsafeBufferPointer(start: try #require(buffer.floatChannelData)[0], count: Int(buffer.frameLength)))
}

@Suite("tracks: 会議のフォルダから 自分.wav と 相手.wav を書く", .timeLimit(.minutes(1)))
struct TracksITTests {
    @Test("進行役の行の音声だけが 自分、残りだけが 相手 に、start の位置で入り、2 本は同じ長さ（最後の end + 3 秒）")
    func splitsFilesBySpeaker() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("stt-bench-tracks-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let lines = root.appendingPathComponent("lines")
        try FileManager.default.createDirectory(at: lines, withIntermediateDirectories: true)
        try "#MARK\tslide:a\t0.00\n森川\t0.00\t0.50\tあ\n甲\t1.00\t1.50\tい\n".write(to: root.appendingPathComponent("timeline.tsv"), atomically: true, encoding: .utf8)
        try #"{"森川":"V1","甲":"V2"}"#.write(to: root.appendingPathComponent("voices.json"), atomically: true, encoding: .utf8)
        try writeWav(constant(0.25, seconds: 0.5), to: lines.appendingPathComponent(lineFileName(voice: "V1", text: "あ")))
        try writeWav(constant(0.125, seconds: 0.5), to: lines.appendingPathComponent(lineFileName(voice: "V2", text: "い")))

        let out = root.appendingPathComponent("out")
        try buildTracks(meeting: root, outDir: out, selfSpeaker: "森川")

        let mine = try readBack(out.appendingPathComponent("自分.wav"))
        let others = try readBack(out.appendingPathComponent("相手.wav"))
        let rate = Int(synthSampleRate)
        #expect(mine.count == others.count)
        #expect(mine.count == (1.5 + 3).intValue(rate))
        // 自分: 森川の行（0.25）が 0 秒の位置、甲の行は入らない
        #expect(abs(mine[100] - 0.25) < 1e-3)
        #expect(mine[rate + 100] == 0)
        // 相手: 甲の行（0.125）が 1 秒の位置、森川の行は入らない
        #expect(abs(others[rate + 100] - 0.125) < 1e-3)
        #expect(others[100] == 0)
    }
}

private extension Double {
    func intValue(_ rate: Int) -> Int { Int((self * Double(rate)).rounded()) }
}
