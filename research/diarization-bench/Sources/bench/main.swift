// 話者分離の候補を、合成会議の音声を実時間と同じ順に少しずつ流して測る使い捨ての道具（Issue #369）
// 使い方: bench <方式> <16kHz モノラル wav> <出力の接頭辞>
// 出力: <接頭辞>.segs.tsv（確定した区間: 話者\t開始\t終了）、<接頭辞>.frames.tsv（フレーム\t確定時の話者\t最初の仮の話者\t確定した時点の音声秒）、<接頭辞>.json（処理時間）
import FluidAudio
import Foundation

func cpuSeconds() -> Double {
    var u = rusage()
    getrusage(RUSAGE_SELF, &u)
    return Double(u.ru_utime.tv_sec) + Double(u.ru_utime.tv_usec) / 1e6 + Double(u.ru_stime.tv_sec)
        + Double(u.ru_stime.tv_usec) / 1e6
}

// フレームの確率から、0.5 を超える中で最も高い話者（いなければ -1）
func dominant(_ preds: [Float], frame: Int, numSpeakers: Int) -> Int {
    var best = -1
    var bestP: Float = 0.5
    for s in 0..<numSpeakers where preds[frame * numSpeakers + s] > bestP {
        best = s
        bestP = preds[frame * numSpeakers + s]
    }
    return best
}

let args = CommandLine.arguments
let method = args[1]
let wav = URL(fileURLWithPath: args[2])
let out = args[3]
let feedSeconds = 0.1  // 一度に渡す音声の長さ（実時間の取り込みに合わせる）

let audio = try AudioConverter().resampleAudioFile(wav)
let audioSeconds = Double(audio.count) / 16_000
var segs: [(String, Double, Double)] = []
var frameLines: [String] = []
var loadSeconds = 0.0
let wallStart: Date
let cpuStart: Double

if method.hasPrefix("pyannote") {
    // pyannote の逐次版: 塊ごとに渡し、SpeakerManager が塊をまたいで ID を保つ
    let chunk = Double(method.dropFirst("pyannote".count)) ?? 10
    let t0 = Date()
    let models = try await DiarizerModels.downloadIfNeeded()
    let diarizer = DiarizerManager(config: DiarizerConfig(chunkDuration: Float(chunk)))
    diarizer.initialize(models: models)
    loadSeconds = Date().timeIntervalSince(t0)
    wallStart = Date()
    cpuStart = cpuSeconds()
    let size = Int(chunk * 16_000)
    for start in stride(from: 0, to: audio.count, by: size) {
        let slice = Array(audio[start..<min(start + size, audio.count)])
        if slice.count < 16_000 * 3 { break }
        let result = try diarizer.performCompleteDiarization(slice, atTime: Double(start) / 16_000)
        let fed = Double(min(start + size, audio.count)) / 16_000
        for s in result.segments {
            segs.append((s.speakerId, Double(s.startTimeSeconds), Double(s.endTimeSeconds)))
            frameLines.append("\(s.speakerId)\t\(s.startTimeSeconds)\t\(s.endTimeSeconds)\t\(fed)")
        }
    }
} else {
    let t0 = Date()
    let diarizer: any Diarizer
    switch method {
    case "sortformer-fast", "sortformer-balanced", "sortformer-high":
        let config: SortformerConfig =
            method == "sortformer-fast" ? .fastV2_1 : method == "sortformer-balanced" ? .balancedV2_1 : .highContextV2_1
        let d = SortformerDiarizer(config: config)
        d.initialize(models: try await SortformerModels.loadFromHuggingFace(config: config))
        diarizer = d
    default:  // lseend-<型>-<刻み ms>
        let parts = method.split(separator: "-")
        let variant: LSEENDVariant =
            ["ami": .ami, "callhome": .callhome, "dihard2": .dihard2, "dihard3": .dihard3][String(parts[1])]!
        let step = LSEENDStepSize(rawValue: (Int(parts[2]) ?? 100) / 100)!
        let d = LSEENDDiarizer()
        try await d.initialize(variant: variant, stepSize: step)
        diarizer = d
    }
    loadSeconds = Date().timeIntervalSince(t0)
    let n = diarizer.numSpeakers!
    var firstTentative: [Int: Int] = [:]
    wallStart = Date()
    cpuStart = cpuSeconds()
    let step = Int(feedSeconds * 16_000)
    func record(_ update: DiarizerTimelineUpdate?, fed: Double) {
        guard let c = update?.chunkResult else { return }
        for i in 0..<c.tentativeFrameCount where firstTentative[c.tentativeStartFrame + i] == nil {
            firstTentative[c.tentativeStartFrame + i] = dominant(c.tentativePredictions, frame: i, numSpeakers: n)
        }
        for i in 0..<c.finalizedFrameCount {
            let f = c.startFrame + i
            let label = dominant(c.finalizedPredictions, frame: i, numSpeakers: n)
            frameLines.append("\(f)\t\(label)\t\(firstTentative[f].map(String.init) ?? "")\t\(fed)")
        }
    }
    if method.hasSuffix("-offline") {
        // 切り分け用: 音声ファイルを丸ごと渡す一括処理（遅れは測らない）
        _ = try diarizer.processComplete(
            audioFileURL: wav, keepingEnrolledSpeakers: nil, finalizeOnCompletion: true, progressCallback: nil)
    }
    for start in stride(from: 0, to: method.hasSuffix("-offline") ? 0 : audio.count, by: step) {
        let end = min(start + step, audio.count)
        try diarizer.addAudio(audio[start..<end], sourceSampleRate: 16_000)
        record(try diarizer.process(), fed: Double(end) / 16_000)
    }
    if !method.hasSuffix("-offline") { record(try diarizer.finalizeSession(), fed: audioSeconds) }
    for speaker in diarizer.timeline.speakers.values {
        for s in speaker.finalizedSegments {
            segs.append((String(s.speakerIndex), Double(s.startTime), Double(s.endTime)))
        }
    }
    frameLines.insert("# frameSeconds=\(1 / diarizer.modelFrameHz!)", at: 0)
}

let wall = Date().timeIntervalSince(wallStart)
let cpu = cpuSeconds() - cpuStart
try segs.sorted { $0.1 < $1.1 }.map { "\($0.0)\t\($0.1)\t\($0.2)" }.joined(separator: "\n")
    .write(toFile: "\(out).segs.tsv", atomically: true, encoding: .utf8)
try frameLines.joined(separator: "\n").write(toFile: "\(out).frames.tsv", atomically: true, encoding: .utf8)
let summary: [String: Any] = [
    "method": method, "audioSeconds": audioSeconds, "loadSeconds": loadSeconds, "wallSeconds": wall,
    "cpuSeconds": cpu, "rtfx": audioSeconds / wall, "cpuPerAudioSecond": cpu / audioSeconds,
]
try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
    .write(to: URL(fileURLWithPath: "\(out).json"))
print(summary)
