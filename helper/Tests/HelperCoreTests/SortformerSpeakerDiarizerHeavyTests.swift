import AVFoundation
import CoreAudio
import Foundation
import Testing
@testable import HelperCore

// 本物の Sortformer（CoreML、fastV2_1）を使う。モデルは helper/scripts/fetch-speaker-models.sh が前もって取得する。
// モデルが無い環境では prepare() が modelMissing で失敗し、テストも失敗する（環境の問題として報告する）。
// 2 人の声は `say` の Kyoko と Rocko（どちらも macOS 同梱の日本語の声。Reed は同じ人の 2 行目に別の枠が付いたので使わない）。
// Rocko は言語ごとに同じ名前の声があり、名前だけだとシステムの言語の声が選ばれる。英語の CI では英語の Rocko が日本語の文をほぼ無音で読むので、日本語の声を ID で指す。

private let sampleRate = 16_000.0

private struct SpokenLine {
    let speaker: String
    let voice: String
    let text: String
}

private struct PlacedLine {
    let speaker: String
    let start: Double
    let end: Double
}

private func synthesize(_ text: String, voice: String, in directory: URL, index: Int) throws -> [Float] {
    let aiff = directory.appendingPathComponent("line\(index).aiff")
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
    // 声がその言語を読めないと、say は失敗せずにほぼ無音を書く
    try #require(Double(output.frameLength) / sampleRate > 1.0, "say の \(voice) がほぼ無音を書いた（\(output.frameLength) サンプル）: \(text)")
    return Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
}

/// 2 人が交互に話す音声（先頭 1 秒の無音、行の間 0.7 秒の無音）と、各行の秒数（音声の先頭を 0 とする）。
private func conversation(in directory: URL) throws -> (samples: [Float], lines: [PlacedLine]) {
    let script = [
        SpokenLine(speaker: "A", voice: "Kyoko", text: "こんにちは、今日の会議を始めます。まず先週の進み具合から確認しましょう。"),
        SpokenLine(speaker: "B", voice: "com.apple.eloquence.ja-JP.Rocko", text: "はい、先週は設計の見直しを終えて、実装に入ったところです。"),
        SpokenLine(speaker: "A", voice: "Kyoko", text: "分かりました。それでは次に、来週の予定について話してください。"),
        SpokenLine(speaker: "B", voice: "com.apple.eloquence.ja-JP.Rocko", text: "来週はテストを書いて、レビューの依頼まで進める予定です。"),
    ]
    var samples = [Float](repeating: 0, count: Int(1.0 * sampleRate))
    var placed: [PlacedLine] = []
    for (index, line) in script.enumerated() {
        let spoken = try synthesize(line.text, voice: line.voice, in: directory, index: index)
        let start = Double(samples.count) / sampleRate
        samples += spoken
        placed.append(PlacedLine(speaker: line.speaker, start: start, end: Double(samples.count) / sampleRate))
        samples += [Float](repeating: 0, count: Int(0.7 * sampleRate))
    }
    samples += [Float](repeating: 0, count: Int(2.0 * sampleRate))
    return (samples, placed)
}

/// 100 ms ごとのバッファに切る。先頭のバッファの取得時刻は `origin` の `captureStart` 秒後で、以降は連続する。
private func chunks(_ samples: [Float], origin: UInt64, captureStart: Double) throws -> [CapturedAudio] {
    let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false))
    let frames = Int(sampleRate / 10)
    var result: [CapturedAudio] = []
    var position = 0
    while position < samples.count {
        let count = min(frames, samples.count - position)
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)))
        buffer.frameLength = AVAudioFrameCount(count)
        samples[position..<(position + count)].withUnsafeBufferPointer {
            buffer.floatChannelData![0].update(from: $0.baseAddress!, count: count)
        }
        let seconds = captureStart + Double(position) / sampleRate
        let ticks = AudioConvertNanosToHostTime(UInt64(seconds * 1_000_000_000))
        result.append(CapturedAudio(buffer: buffer, hostTime: origin + ticks))
        position += count
    }
    return result
}

/// 確定した区間のうち、`line` の秒数と重なる長さを枠ごとに足して、いちばん長い枠を返す。
private func dominantSlot(of line: PlacedLine, in segments: [SpeakerSegment], shift: Double) -> Int? {
    var overlap: [Int: Double] = [:]
    for segment in segments where segment.isFinal {
        let length = min(segment.end, line.end + shift) - max(segment.start, line.start + shift)
        if length > 0 { overlap[segment.slot, default: 0] += length }
    }
    return overlap.max { $0.value < $1.value }?.key
}

@Suite("SortformerSpeakerDiarizer の話者分離", .timeLimit(.minutes(5)))
struct SortformerSpeakerDiarizerHeavyTests {
    @Test("2 人が交互に話す音声で、確定の区間が届き、別の人には別の枠が付く。時刻は音声の取得開始に合わせて origin 基準になる")
    func distinguishesTwoSpeakers() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sortformer-heavy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (samples, lines) = try conversation(in: directory)

        let diarizer = SortformerSpeakerDiarizer()
        try await diarizer.prepare()

        let origin = AudioGetCurrentHostTime()
        let captureStart = 2.0  // origin より 2 秒後に取得が始まった（TrackTimeline と同じく、最初のバッファの時刻を 1 回だけ足す）
        let buffers = try chunks(samples, origin: origin, captureStart: captureStart)
        let audio = AsyncThrowingStream<CapturedAudio, Error> { continuation in
            buffers.forEach { continuation.yield($0) }
            continuation.finish()
        }

        let stream = try await diarizer.diarize(audio, origin: origin)
        var segments: [SpeakerSegment] = []
        var settled: [Double] = []
        for try await item in stream {
            switch item {
            case .segment(let segment): segments.append(segment)
            case .settled(let to): settled.append(to)
            case .mixed: break
            }
        }
        #expect(!settled.isEmpty, "確定済みの位置が 1 件も届かなかった")
        #expect(settled == settled.sorted(), "確定済みの位置が前の値より小さくなった")

        let confirmed = segments.filter(\.isFinal)
        #expect(!confirmed.isEmpty, "確定の区間が 1 件も届かなかった（全 \(segments.count) 件）")
        #expect(segments.contains { !$0.isFinal }, "仮の区間が 1 件も届かなかった（全 \(segments.count) 件）")
        for segment in segments {
            #expect(segment.start.isFinite && segment.end.isFinite && segment.end >= segment.start)
            #expect(segment.slot >= 0)
        }
        // 最初のバッファより前の時刻の区間は無い（時刻が origin 基準にそろっていれば、音声の取得開始 2 秒より前にはならない）
        let earliest = try #require(confirmed.map(\.start).min())
        #expect(earliest >= captureStart - 0.1, "区間の時刻が origin 基準になっていない: 最初の確定区間の開始 \(earliest)")

        let firstSpeaker = lines.filter { $0.speaker == "A" }.compactMap { dominantSlot(of: $0, in: confirmed, shift: captureStart) }
        let secondSpeaker = lines.filter { $0.speaker == "B" }.compactMap { dominantSlot(of: $0, in: confirmed, shift: captureStart) }
        let firstSlot = try #require(firstSpeaker.first, "1 人目の発話に重なる確定区間が無い")
        let secondSlot = try #require(secondSpeaker.first, "2 人目の発話に重なる確定区間が無い")
        #expect(firstSlot != secondSlot, "別の人に同じ枠 \(firstSlot) が付いた")
        // 同じ人は（多数決で）同じ枠のまま
        #expect(Set(firstSpeaker).count == 1, "1 人目の枠が行ごとに変わった: \(firstSpeaker)")
        #expect(Set(secondSpeaker).count == 1, "2 人目の枠が行ごとに変わった: \(secondSpeaker)")
    }

    @Test("音声が一度も届かないまま入力が終わると、区間の流れがエラーなしで終わる")
    func finishesWithoutAudio() async throws {
        let diarizer = SortformerSpeakerDiarizer()
        try await diarizer.prepare()
        let audio = AsyncThrowingStream<CapturedAudio, Error> { $0.finish() }
        let stream = try await diarizer.diarize(audio, origin: AudioGetCurrentHostTime())
        var count = 0
        for try await _ in stream { count += 1 }
        #expect(count == 0)
    }
}
