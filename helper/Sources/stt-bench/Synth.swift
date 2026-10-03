import AVFoundation
import Foundation

// 台本から、続けて話す会議の音声を合成する（`say` で行ごとに作り、時刻を決めて 1 本の wav に重ねる）。
// 時刻の式は bench の gen.py と同じ: 先頭に無音を置き、各行は start = t、end = t + 長さ、次の t = t + 長さ + gap。

let synthSampleRate = 16_000.0

struct PlacedLine: Equatable {
    var start: Double
    var end: Double
}

/// 各行の start / end。`gaps[i]` は i 行目のあとの無音（負なら次の行が重なる）。start が 0 未満になる場合は 0 に置く。
func placeLines(durations: [Double], gaps: [Double], leadingSilence: Double) -> [PlacedLine] {
    var t = leadingSilence
    var placed: [PlacedLine] = []
    for (i, d) in durations.enumerated() {
        let start = max(0, t)
        placed.append(PlacedLine(start: start, end: start + d))
        t = start + d + (i < gaps.count ? gaps[i] : 0)
    }
    return placed
}

struct PlacedSamples {
    var startFrame: Int
    var samples: [Float]
}

/// 配置したサンプルを足し合わせる。足し合わせた最大振幅が 1 を超えるときは、切り詰めず全体を同じ比率で小さくする。
func mixPlacedSamples(_ parts: [PlacedSamples]) -> [Float] {
    let length = parts.map { $0.startFrame + $0.samples.count }.max() ?? 0
    var mixed = [Float](repeating: 0, count: length)
    for part in parts {
        for (i, s) in part.samples.enumerated() { mixed[part.startFrame + i] += s }
    }
    let peak = mixed.map { abs($0) }.max() ?? 0
    if peak > 1 {
        let scale = 1 / peak
        for i in mixed.indices { mixed[i] *= scale }
    }
    return mixed
}

// MARK: 台本

struct Scenario: Decodable {
    var title: String
    var gap: Double
    var lines: [[String]]  // [話者, 本文] か [話者, 本文, 種別（決定 / TODO）, 正解の文]
}

struct SynthesizedLine: Codable {
    var speaker: String
    var text: String
    var start: Double
    var end: Double
}

struct TruthEntry: Codable {
    var text: String
    var from: Double
    var to: Double
}

private let voices = ["A": "Kyoko", "B": "Reed"]  // A = 相手、B = 自分
private let speechRate = "190"
private let leadingSilence = 1.0
private let trailingSilence = 3.0

enum SynthError: Error, CustomStringConvertible {
    case sayFailed(String)
    case unknownSpeaker(String)
    case badScenario(String)

    var description: String {
        switch self {
        case .sayFailed(let why): return "say が失敗した: \(why)"
        case .unknownSpeaker(let s): return "話者 \(s) は A か B"
        case .badScenario(let why): return "台本が不正: \(why)"
        }
    }
}

/// `say` で 1 行を作り、mono 16 kHz の Float に変える。
private func speak(_ text: String, voice: String, in dir: URL, index: Int) throws -> [Float] {
    let aiff = dir.appendingPathComponent("line\(index).aiff")
    let say = Process()
    say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-v", voice, "-r", speechRate, "-o", aiff.path, text]
    try say.run()
    say.waitUntilExit()
    guard say.terminationStatus == 0 else { throw SynthError.sayFailed("\(voice): \(text)") }

    let file = try AVAudioFile(forReading: aiff)
    guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: synthSampleRate, channels: 1, interleaved: false),
          let converter = AVAudioConverter(from: file.processingFormat, to: target),
          let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
    else { throw SynthError.sayFailed("音声形式を変換できない") }
    try file.read(into: input)
    let capacity = AVAudioFrameCount(Double(input.frameLength) * synthSampleRate / file.processingFormat.sampleRate) + 16
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
        throw SynthError.sayFailed("出力バッファを作れない")
    }
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
    if status == .error { throw SynthError.sayFailed(error?.localizedDescription ?? "変換に失敗") }
    return Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
}

func writeWav(_ samples: [Float], to url: URL, sampleRate: Double = synthSampleRate) throws {
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
    ]
    let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))
    else { throw SynthError.sayFailed("書き出しバッファを作れない") }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
    try file.write(from: buffer)
}

/// 1 つの台本を `<outDir>/<name>.wav` と、行の時刻 `<name>.lines.json`、正解 `<name>.truth.json` にする。
func synthesize(name: String, scenario: Scenario, gapOverride: Double?, outDir: URL) throws {
    let gap = gapOverride ?? scenario.gap
    let work = FileManager.default.temporaryDirectory.appendingPathComponent("stt-bench-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: work) }

    var spoken: [[Float]] = []
    for (i, line) in scenario.lines.enumerated() {
        guard line.count >= 2 else { throw SynthError.badScenario("\(name) の \(i + 1) 行目") }
        guard let voice = voices[line[0]] else { throw SynthError.unknownSpeaker(line[0]) }
        spoken.append(try speak(line[1], voice: voice, in: work, index: i))
    }
    let placed = placeLines(durations: spoken.map { Double($0.count) / synthSampleRate }, gaps: Array(repeating: gap, count: spoken.count), leadingSilence: leadingSilence)
    var mixed = mixPlacedSamples(zip(spoken, placed).map { PlacedSamples(startFrame: Int(($1.start * synthSampleRate).rounded()), samples: $0) })
    mixed += [Float](repeating: 0, count: Int(trailingSilence * synthSampleRate))

    try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    try writeWav(mixed, to: outDir.appendingPathComponent("\(name).wav"))

    let lines = zip(scenario.lines, placed).map { SynthesizedLine(speaker: $0[0], text: $0[1], start: $1.start, end: $1.end) }
    var truth: [String: [TruthEntry]] = ["決定": [], "TODO": []]
    for (line, p) in zip(scenario.lines, placed) where line.count >= 4 {
        truth[line[2], default: []].append(TruthEntry(text: line[3], from: p.start, to: p.end))
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try encoder.encode(lines).write(to: outDir.appendingPathComponent("\(name).lines.json"))
    try encoder.encode(truth).write(to: outDir.appendingPathComponent("\(name).truth.json"))
}
