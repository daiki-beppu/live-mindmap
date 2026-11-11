import AVFoundation
import CryptoKit
import Foundation

struct TimelineRow: Equatable {
    var speaker: String
    var start: Double
    var end: Double
    var text: String
}

enum TracksError: Error, CustomStringConvertible {
    case badRow(line: Int, reason: String)
    case unknownSelf(String)
    case missingVoice(speaker: String)
    case missingLine(row: Int, file: String)
    case unreadableLine(row: Int, file: String)
    case sampleRateMismatch(row: Int)
    case noRows

    var description: String {
        switch self {
        case .badRow(let line, let reason): return "timeline.tsv の \(line) 行目が不正です（\(reason)）"
        case .unknownSelf(let speaker): return "--self の話者「\(speaker)」が timeline.tsv にありません"
        case .missingVoice(let speaker): return "voices.json に話者「\(speaker)」の声がありません"
        case .missingLine(let row, let file): return "\(row) 番目の発言の音声 lines/\(file) がありません（lines/ を Drive から戻したか確認）"
        case .unreadableLine(let row, let file): return "\(row) 番目の発言の音声 lines/\(file) を読めません"
        case .sampleRateMismatch(let row): return "\(row) 番目の発言の音声のサンプリング周波数が、先頭の発言と違います"
        case .noRows: return "timeline.tsv に発言の行がありません"
        }
    }
}

private let trailingSilenceSeconds = 3.0
private let junkPeak: Float = 12_000.0 / 32_768.0

func parseTimelineRows(_ text: String) throws -> [TimelineRow] {
    var rows: [TimelineRow] = []
    for (index, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
        let number = index + 1
        if line.trimmingCharacters(in: .whitespaces).isEmpty || line.hasPrefix("#") { continue }
        let columns = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        guard columns.count == 4 else { throw TracksError.badRow(line: number, reason: "列が \(columns.count) 個") }
        guard let start = Double(columns[1]), let end = Double(columns[2]), start.isFinite, end.isFinite else {
            throw TracksError.badRow(line: number, reason: "開始・終了が数値でない")
        }
        rows.append(TimelineRow(speaker: columns[0], start: start, end: end, text: columns[3]))
    }
    return rows
}

func splitRows(_ rows: [TimelineRow], selfSpeaker: String) throws -> (mine: [TimelineRow], others: [TimelineRow]) {
    guard rows.contains(where: { $0.speaker == selfSpeaker }) else { throw TracksError.unknownSelf(selfSpeaker) }
    return (rows.filter { $0.speaker == selfSpeaker }, rows.filter { $0.speaker != selfSpeaker })
}

func lineFileName(voice: String, text: String) -> String {
    let digest = Insecure.SHA1.hash(data: Data("\(voice)\n\(text)".utf8))
    return digest.map { String(format: "%02x", $0) }.joined().prefix(16) + ".wav"
}

func silenceJunkTail(_ samples: [Float], sampleRate: Double) -> [Float] {
    let window = Int(sampleRate / 1000)
    func peak(_ from: Int) -> Float {
        samples[from..<min(from + window, samples.count)].reduce(0) { max($0, abs($1)) }
    }
    var start = samples.count - window
    guard window > 0, start >= 0, peak(start) > junkPeak else { return samples }
    while start - window >= 0, peak(start - window) > junkPeak { start -= window }
    var out = samples
    for i in start..<out.count { out[i] = 0 }
    let fade = min(10 * window, start)
    for j in 0..<fade { out[start - fade + j] *= 1 - Float(j + 1) / Float(fade) }
    return out
}

func framePosition(seconds: Double, sampleRate: Double) -> Int {
    Int((seconds * sampleRate).rounded())
}

func trackDuration(of rows: [TimelineRow]) -> Double {
    (rows.map(\.end).max() ?? 0) + trailingSilenceSeconds
}

func renderTrack(_ parts: [PlacedSamples], frames: Int) -> [Float] {
    var track = [Float](repeating: 0, count: max(frames, parts.map { $0.startFrame + $0.samples.count }.max() ?? 0))
    for part in parts {
        for (i, s) in part.samples.enumerated() { track[part.startFrame + i] += s }
    }
    var peak: Float = 0
    for s in track { peak = max(peak, abs(s)) }
    if peak > 1 {
        let scale = 1 / peak
        for i in track.indices { track[i] *= scale }
    }
    return track
}

private func readSamples(_ url: URL) throws -> (samples: [Float], sampleRate: Double) {
    let file = try AVAudioFile(forReading: url)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else {
        throw CocoaError(.fileReadUnknown)
    }
    try file.read(into: buffer)
    guard let channel = buffer.floatChannelData?[0] else { throw CocoaError(.fileReadUnknown) }
    return (Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))), file.processingFormat.sampleRate)
}

func buildTracks(meeting: URL, outDir: URL, selfSpeaker: String) throws {
    let timeline = try String(contentsOf: meeting.appendingPathComponent("timeline.tsv"), encoding: .utf8)
    let rows = try parseTimelineRows(timeline)
    guard !rows.isEmpty else { throw TracksError.noRows }
    let voices = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: meeting.appendingPathComponent("voices.json")))
    let split = try splitRows(rows, selfSpeaker: selfSpeaker)
    let linesDir = meeting.appendingPathComponent("lines")

    var sampleRate: Double?
    func place(_ indices: [Int]) throws -> [PlacedSamples] {
        try indices.map { index in
            let row = rows[index]
            guard let voice = voices[row.speaker] else { throw TracksError.missingVoice(speaker: row.speaker) }
            let name = lineFileName(voice: voice, text: row.text)
            let number = index + 1
            let url = linesDir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { throw TracksError.missingLine(row: number, file: name) }
            guard let line = try? readSamples(url) else { throw TracksError.unreadableLine(row: number, file: name) }
            if let sampleRate, sampleRate != line.sampleRate { throw TracksError.sampleRateMismatch(row: number) }
            sampleRate = line.sampleRate
            return PlacedSamples(startFrame: framePosition(seconds: row.start, sampleRate: line.sampleRate), samples: silenceJunkTail(line.samples, sampleRate: line.sampleRate))
        }
    }

    let minePlaced = try place(rows.indices.filter { rows[$0].speaker == selfSpeaker })
    let othersPlaced = try place(rows.indices.filter { rows[$0].speaker != selfSpeaker })
    guard let rate = sampleRate else { throw TracksError.noRows }
    let frames = framePosition(seconds: trackDuration(of: rows), sampleRate: rate)
    let total = max(frames, (minePlaced + othersPlaced).map { $0.startFrame + $0.samples.count }.max() ?? 0)

    try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    try writeWav(renderTrack(minePlaced, frames: total), to: outDir.appendingPathComponent("自分.wav"), sampleRate: rate)
    try writeWav(renderTrack(othersPlaced, frames: total), to: outDir.appendingPathComponent("相手.wav"), sampleRate: rate)
    print("自分 \(split.mine.count) 行、相手 \(split.others.count) 行、\(String(format: "%.1f", Double(total) / rate)) 秒")
}
