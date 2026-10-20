import AVFoundation
import Foundation
import HelperCore

// `stt-bench echo` の本体（Issue #118）。wav の入出力と、条件ごとの実行・JSONL の出力。数字の計算は Echo.swift。

private let echoRate = Double(echoSampleRate)
private let targetRmsDbfs = -20.0
private let tailSeconds = 0.2  // 最後の行の end のあとに残す無音

struct EchoOptions {
    var meeting: URL
    var selfVoice: URL
    var selfLines: URL
    var microphone: URL?
    var delaysMs: [Int] = [40, 200, 300]
    var atSeconds: [Double] = [5, 30, 60]
    var leakGainDb: Double = -10
    var candidates: [EchoCandidate] = [.baseline]
    var out: URL?
}

/// `baseline` は #118 の既定値、`production` は本番設定。追加の三候補は production の一項目だけを変える。
/// `bypass-<秒>` は baseline で動かし、開始から N 秒は AEC の出力を使わない。
enum EchoCandidate: Equatable {
    case baseline
    case bypass(seconds: Double)
    case production
    case suppressLf
    case delayHint
    case epGain

    init?(_ name: String) {
        if name == "baseline" { self = .baseline; return }
        if name == "production" { self = .production; return }
        if name == "suppress-lf-0.6" { self = .suppressLf; return }
        if name == "delay-hint-40" { self = .delayHint; return }
        if name == "ep-gain-0.1" { self = .epGain; return }
        if name.hasPrefix("bypass-"), let seconds = Double(name.dropFirst("bypass-".count)), seconds.isFinite, seconds >= 0 { self = .bypass(seconds: seconds); return }
        return nil
    }

    var name: String {
        switch self {
        case .baseline: return "baseline"
        case .bypass(let seconds): return "bypass-\(seconds)"
        case .production: return "production"
        case .suppressLf: return "suppress-lf-0.6"
        case .delayHint: return "delay-hint-40"
        case .epGain: return "ep-gain-0.1"
        }
    }

    var settings: EchoCancellerSettings {
        switch self {
        case .baseline, .bypass: return .baseline
        case .production: return .production
        case .suppressLf:
            var settings = EchoCancellerSettings.production
            settings.suppressorNormalMaskLfEnrSuppress = 0.6
            return settings
        case .delayHint:
            var settings = EchoCancellerSettings.production
            settings.streamDelayMs = 40
            return settings
        case .epGain:
            var settings = EchoCancellerSettings.production
            settings.epStrengthDefaultGain = 0.1
            return settings
        }
    }

    var bypassSamples: Int {
        switch self {
        case .baseline, .production, .suppressLf, .delayHint, .epGain: return 0
        case .bypass(let seconds): return Int(seconds * echoRate)
        }
    }
}

struct EchoResultLine: Encodable {
    var candidate: String
    var delayMs: Int
    var leakGainDb: Double?
    var atSeconds: Double
    var retentionDb: Double?
    var leakReductionDb: Double?
    var referenceRmsDbfs: Double
    var outputDelaySamples: Int
}

/// JSON に書けない値（nan・inf）は null にする。
private func finite(_ value: Double) -> Double? { value.isFinite ? value : nil }

/// wav を 48 kHz・モノラルの Float にする（オフラインの一括変換）。
func readMono48k(_ url: URL) throws -> [Float] {
    let file = try AVAudioFile(forReading: url)
    guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: echoRate, channels: 1, interleaved: false),
          let converter = AVAudioConverter(from: file.processingFormat, to: target),
          let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
    else { throw SynthError.badScenario("\(url.lastPathComponent) を 48 kHz に変換できない") }
    try file.read(into: input)
    let capacity = AVAudioFrameCount(Double(input.frameLength) * echoRate / file.processingFormat.sampleRate) + 16
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
        throw SynthError.badScenario("出力バッファを作れない")
    }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
        if supplied {
            inputStatus.pointee = .endOfStream
            return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return input
    }
    if status == .error { throw SynthError.badScenario(error?.localizedDescription ?? "変換に失敗") }
    return Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
}

private func rms(_ samples: ArraySlice<Float>) -> Double {
    guard !samples.isEmpty else { return 0 }
    return (samples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(samples.count)).squareRoot()
}

private func scaled(_ samples: [Float], by gain: Double) -> [Float] { samples.map { $0 * Float(gain) } }

func runEcho(_ options: EchoOptions) throws {
    let lines = try JSONDecoder().decode([SynthesizedLine].self, from: Data(contentsOf: options.selfLines))
    guard let first = lines.first, let last = lines.last else { throw SynthError.badScenario("\(options.selfLines.lastPathComponent) に行がない") }
    if let microphone = options.microphone {
        try runRecordedEcho(options, microphone: microphone, lines: lines)
        return
    }

    // 参照は全体の RMS を −20 dBFS、発話は発話区間（最初の行の start〜最後の行の end）の RMS を −20 dBFS にそろえる。
    let target = pow(10, targetRmsDbfs / 20)
    var reference = try readMono48k(options.meeting)
    reference = try scaleTo(target, reference, over: reference.indices)
    var voice = try readMono48k(options.selfVoice)
    let speech = Int(first.start * echoRate)..<min(Int(last.end * echoRate), voice.count)
    voice = try scaleTo(target, voice, over: speech)
    voice = Array(voice[0..<min(Int((last.end + tailSeconds) * echoRate), voice.count)])

    let insertAt = insertionSamples(atSeconds: options.atSeconds, firstLineStartSeconds: first.start, sampleRate: echoSampleRate)
    guard insertAt.allSatisfy({ $0 >= 0 }), let furthest = insertAt.max(), furthest + voice.count <= reference.count else {
        throw SynthError.badScenario("会議の音（\(reference.count / echoSampleRate) 秒）に、発話（\(voice.count / echoSampleRate) 秒）を指定の位置に置けない")
    }

    let leakGain = Float(pow(10, options.leakGainDb / 20))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    for candidate in options.candidates {
        let outputDelay = try measureOutputDelay(makeCanceller: { try WebRTCEchoCanceller(settings: candidate.settings) })
        for delayMs in options.delaysMs {
            let built = buildMicrophone(reference: reference, utterance: voice, delaySamples: delayMs * echoSampleRate / 1000, leakGain: leakGain, insertAt: insertAt)
            let output = runCanceller(try WebRTCEchoCanceller(settings: candidate.settings), reference: reference, microphone: built.microphone, bypassSamples: candidate.bypassSamples, bypassDelaySamples: outputDelay)
            let results = windowResults(built: built, output: output, outputDelay: outputDelay, reference: reference)
            for (result, seconds) in zip(results, options.atSeconds) {
                let line = EchoResultLine(
                    candidate: candidate.name, delayMs: delayMs, leakGainDb: finite(options.leakGainDb), atSeconds: seconds,
                    retentionDb: finite(result.retentionDb), leakReductionDb: finite(result.leakReductionDb),
                    referenceRmsDbfs: result.referenceRmsDbfs, outputDelaySamples: outputDelay)
                print(String(decoding: try encoder.encode(line), as: UTF8.self))
            }
            if let dir = options.out {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let compensated = (0..<output.count).map { $0 + outputDelay < output.count ? output[$0 + outputDelay] : 0 }
                try writeWav(compensated, to: dir.appendingPathComponent("echo-\(candidate.name)-d\(delayMs).wav"), sampleRate: echoRate)
            }
        }
    }
}

private func scaleTo(_ target: Double, _ samples: [Float], over range: Range<Int>) throws -> [Float] {
    let current = rms(samples[range])
    guard current > 0 else { throw SynthError.badScenario("音声が無音で、音量をそろえられない") }
    return scaled(samples, by: target / current)
}

private struct EchoLevel: Encodable {
    let value: Double

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        if value.isFinite { try container.encode(value) }
        else { try container.encodeNil() }
    }
}

private struct RecordedMinuteLine: Encodable {
    let type = "minute"
    var candidate: String
    var settings: EchoCancellerSettings
    var outputDelaySamples: Int
    var startSeconds: Double
    var endSeconds: Double
    var inputRmsDbfs: EchoLevel
    var outputRmsDbfs: EchoLevel
    var leakReductionDb: EchoLevel
}

private struct RecordedRetentionLine: Encodable {
    let type = "retention"
    var candidate: String
    var settings: EchoCancellerSettings
    var outputDelaySamples: Int
    var voiceRmsDbfs: Double
    var atSeconds: Double
    var startSeconds: Double
    var endSeconds: Double
    var retentionDb: EchoLevel
}

private func runRecordedEcho(_ options: EchoOptions, microphone microphoneURL: URL, lines: [SynthesizedLine]) throws {
    let reference = try readMono48k(options.meeting)
    let microphone = try readMono48k(microphoneURL)
    let sourceVoice = try readMono48k(options.selfVoice)
    guard lines.count == 2,
          lines.allSatisfy({ $0.start.isFinite && $0.end.isFinite && $0.start >= 0 && $0.end > $0.start && $0.end <= Double(sourceVoice.count) / echoRate }),
          lines[0].end <= lines[1].start else {
        throw SynthError.badScenario("既知の二文と、音声内で順番に並ぶ start・end が必要")
    }
    let first = lines[0]
    let last = lines[1]
    guard !options.atSeconds.isEmpty,
          options.atSeconds.allSatisfy({ $0.isFinite && $0 >= first.start && $0 <= Double(reference.count) / echoRate }) else {
        throw SynthError.badScenario("--at は録音内に二文を置ける秒数が必要")
    }
    let voice = Array(sourceVoice.prefix(min(Int((last.end + tailSeconds) * echoRate), sourceVoice.count)))
    let speech = Int(first.start * echoRate)..<Int(last.end * echoRate)
    let voices = try [-20.0, -30.0].map { db in
        (db: db, samples: try scaleTo(pow(10, db / 20), voice, over: speech))
    }
    let insertAt = insertionSamples(atSeconds: options.atSeconds, firstLineStartSeconds: first.start, sampleRate: echoSampleRate)
    // 配置の失敗は、処理・JSONL・保存音声を書き始める前に検出する。
    _ = try buildMicrophone(reference: reference, microphone: microphone, utterance: voice, insertAt: insertAt)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    for candidate in options.candidates {
        let settings = candidate.settings
        let delay = try measureOutputDelay(makeCanceller: { try WebRTCEchoCanceller(settings: settings) })
        let withoutVoice = runCanceller(try WebRTCEchoCanceller(settings: settings), reference: reference, microphone: microphone,
                                       bypassSamples: candidate.bypassSamples, bypassDelaySamples: delay)
        for minute in minuteResults(microphone: microphone, output: withoutVoice, outputDelay: delay) {
            let record = RecordedMinuteLine(
                candidate: candidate.name, settings: settings, outputDelaySamples: delay,
                startSeconds: minute.startSeconds, endSeconds: minute.endSeconds,
                inputRmsDbfs: EchoLevel(value: minute.inputRmsDbfs), outputRmsDbfs: EchoLevel(value: minute.outputRmsDbfs),
                leakReductionDb: EchoLevel(value: minute.leakReductionDb))
            print(String(decoding: try encoder.encode(record), as: UTF8.self))
        }
        if let dir = options.out {
            try saveRecordedEcho(withoutVoice, delay: delay, to: dir, name: "echo-\(candidate.name)-no-voice.wav")
        }
        for voice in voices {
            let built = try buildMicrophone(reference: reference, microphone: microphone, utterance: voice.samples, insertAt: insertAt)
            let output = runCanceller(try WebRTCEchoCanceller(settings: settings), reference: reference, microphone: built.microphone,
                                      bypassSamples: candidate.bypassSamples, bypassDelaySamples: delay)
            for (start, seconds) in zip(built.insertAt, options.atSeconds) {
                let end = min(start + built.utterance.count, output.count - delay)
                let retention = recordedRetentionDb(utterance: built.utterance, outputWithVoice: output, outputWithoutVoice: withoutVoice,
                                                     range: start..<(start + built.utterance.count), outputDelay: delay)
                let record = RecordedRetentionLine(
                    candidate: candidate.name, settings: settings, outputDelaySamples: delay, voiceRmsDbfs: voice.db, atSeconds: seconds,
                    startSeconds: Double(start) / echoRate, endSeconds: Double(max(start, end)) / echoRate,
                    retentionDb: EchoLevel(value: retention))
                print(String(decoding: try encoder.encode(record), as: UTF8.self))
            }
            if let dir = options.out {
                try saveRecordedEcho(output, delay: delay, to: dir, name: "echo-\(candidate.name)-voice\(Int(voice.db)).wav")
            }
        }
    }
}

private func saveRecordedEcho(_ output: [Float], delay: Int, to directory: URL, name: String) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let compensated = output.indices.map { $0 + delay < output.count ? output[$0 + delay] : 0 }
    try writeWav(compensated, to: directory.appendingPathComponent(name), sampleRate: echoRate)
}
