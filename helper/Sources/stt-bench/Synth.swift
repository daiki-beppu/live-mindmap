import AVFoundation
import Foundation

let synthSampleRate = 16_000.0

struct PlacedLine: Equatable {
    var start: Double
    var end: Double
}

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

enum ScriptSpeaker: String, Decodable {
    case A, B

    var voice: String {
        switch self {
        case .A: return "Kyoko"
        case .B: return "Reed"
        }
    }
}

enum TruthKind: String, Decodable {
    case 決定, TODO
}

struct ScriptTruth {
    let kind: TruthKind
    let text: String
}

struct ScriptLine: Decodable {
    let speaker: ScriptSpeaker
    let text: String
    let truth: ScriptTruth?

    init(from decoder: any Decoder) throws {
        var values = try decoder.unkeyedContainer()
        speaker = try values.decode(ScriptSpeaker.self)
        text = try values.decode(String.self)
        if values.isAtEnd {
            truth = nil
        } else {
            truth = ScriptTruth(kind: try values.decode(TruthKind.self), text: try values.decode(String.self))
            guard values.isAtEnd else {
                throw DecodingError.dataCorruptedError(in: values, debugDescription: "台本行は2要素か4要素が必要")
            }
        }
    }
}

struct Scenario: Decodable {
    var title: String
    var gap: Double
    var lines: [ScriptLine]
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

private let speechRate = "190"
private let leadingSilence = 1.0
private let trailingSilence = 3.0

enum SynthError: Error, CustomStringConvertible {
    case sayFailed(String)

    var description: String {
        switch self {
        case .sayFailed(let why): return "say が失敗した: \(why)"
        }
    }
}

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

func synthesize(name: String, scenario: Scenario, gapOverride: Double?, outDir: URL) throws {
    let gap = gapOverride ?? scenario.gap
    let work = FileManager.default.temporaryDirectory.appendingPathComponent("stt-bench-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: work) }

    var spoken: [[Float]] = []
    for (i, line) in scenario.lines.enumerated() {
        spoken.append(try speak(line.text, voice: line.speaker.voice, in: work, index: i))
    }
    let placed = placeLines(durations: spoken.map { Double($0.count) / synthSampleRate }, gaps: Array(repeating: gap, count: spoken.count), leadingSilence: leadingSilence)
    var mixed = mixPlacedSamples(zip(spoken, placed).map { PlacedSamples(startFrame: Int(($1.start * synthSampleRate).rounded()), samples: $0) })
    mixed += [Float](repeating: 0, count: Int(trailingSilence * synthSampleRate))

    try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    try writeWav(mixed, to: outDir.appendingPathComponent("\(name).wav"))

    let lines = zip(scenario.lines, placed).map { SynthesizedLine(speaker: $0.speaker.rawValue, text: $0.text, start: $1.start, end: $1.end) }
    var truth: [String: [TruthEntry]] = ["決定": [], "TODO": []]
    for (line, p) in zip(scenario.lines, placed) {
        if let annotation = line.truth {
            truth[annotation.kind.rawValue, default: []].append(TruthEntry(text: annotation.text, from: p.start, to: p.end))
        }
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try encoder.encode(lines).write(to: outDir.appendingPathComponent("\(name).lines.json"))
    try encoder.encode(truth).write(to: outDir.appendingPathComponent("\(name).truth.json"))
}
