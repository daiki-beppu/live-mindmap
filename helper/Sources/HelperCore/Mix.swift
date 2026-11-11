import AVFoundation
import Foundation

// 32 kbps の AAC を受け付けるサンプルレートとして 24 kHz を使う（mixRecordings のテストで実際の出力を確かめる）。
private let mixSampleRate = 24_000.0
private let mixBitRate = 32_000
private let mixChannelCount = 1

public struct MixError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public func mixInputs(inSession session: URL, track: Track?) throws -> [URL] {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: session.path, isDirectory: &isDirectory), isDirectory.boolValue else {
        throw MixError("セッションのフォルダが無い: \(session.path)")
    }
    let names = Set(try FileManager.default.contentsOfDirectory(atPath: session.path))
    let tracks = track.map { [$0] } ?? [.相手, .自分]
    var selected: [String] = []
    for track in tracks {
        for name in names {
            if isRecordingName(name, track: track) { selected.append(name) }
        }
    }
    guard !selected.isEmpty else {
        let scope = track.map { "\($0.rawValue) の" } ?? ""
        throw MixError("混ぜる\(scope)録音が無い: \(session.path)")
    }
    return selected.sorted().map { session.appendingPathComponent($0) }
}

private func isRecordingName(_ name: String, track: Track) -> Bool {
    if name == recordingFileName(track: track, attempt: 1) { return true }
    let prefix = "\(track.rawValue)-"
    let suffix = ".m4a"
    guard name.hasPrefix(prefix), name.hasSuffix(suffix), name.count > prefix.count + suffix.count else { return false }
    let number = name.dropFirst(prefix.count).dropLast(suffix.count)
    guard let attempt = Int(number), attempt >= 2 else { return false }
    return name == recordingFileName(track: track, attempt: attempt)
}

public func mixRecordings(
    _ inputs: [URL],
    to output: URL,
    reportSkipped: (String) -> Void = { message in
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
) async throws {
    guard !inputs.isEmpty else { throw MixError("混ぜる録音が無い") }
    guard !FileManager.default.fileExists(atPath: output.path) else {
        throw MixError("出力のファイルが既にある: \(output.path)")
    }
    var isDirectory: ObjCBool = false
    let parent = output.deletingLastPathComponent()
    guard FileManager.default.fileExists(atPath: parent.path, isDirectory: &isDirectory), isDirectory.boolValue else {
        throw MixError("出力先のフォルダが無い: \(parent.path)")
    }

    let composition = try await overlaidComposition(of: inputs, reportSkipped: reportSkipped)
    let audioTracks = try await composition.loadTracks(withMediaType: .audio)
    let duration = try await composition.load(.duration)

    let reader = try AVAssetReader(asset: composition)
    let mixOutput = AVAssetReaderAudioMixOutput(audioTracks: audioTracks, audioSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: mixSampleRate,
        AVNumberOfChannelsKey: mixChannelCount,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ])
    reader.timeRange = CMTimeRange(start: .zero, duration: duration)
    guard reader.canAdd(mixOutput) else { throw MixError("混ぜた音を読み出せない") }
    reader.add(mixOutput)

    let writer = try AVAssetWriter(outputURL: output, fileType: .m4a)
    let outputSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: mixSampleRate,
        AVNumberOfChannelsKey: mixChannelCount,
        AVEncoderBitRateKey: mixBitRate,
    ]
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: outputSettings)
    guard writer.canApply(outputSettings: outputSettings, forMediaType: .audio), writer.canAdd(input) else {
        throw MixError("32 kbps・24 kHz・モノラルの AAC で書けない")
    }
    writer.add(input)
    // moov を mdat の前（ファイルの先頭）に置く。
    writer.shouldOptimizeForNetworkUse = true

    guard reader.startReading() else { throw MixError("読み出しを始められない: \(describe(reader.error))") }
    guard writer.startWriting() else {
        reader.cancelReading()
        throw MixError("書き込みを始められない: \(describe(writer.error))")
    }
    writer.startSession(atSourceTime: .zero)

    let pump = SamplePump(reader: reader, output: mixOutput, input: input)
    let pumpFailed = await pump.run()

    if pumpFailed || reader.status == .failed {
        let failure = writer.status == .failed
            ? "書き込みに失敗: \(describe(writer.error))"
            : "録音を読み出せない: \(describe(reader.error))"
        reader.cancelReading()
        writer.cancelWriting()
        try? FileManager.default.removeItem(at: output)
        throw MixError(failure)
    }
    await writer.finishWriting()
    guard writer.status == .completed else {
        try? FileManager.default.removeItem(at: output)
        throw MixError("書き込みに失敗: \(describe(writer.error))")
    }
}

private func overlaidComposition(of inputs: [URL], reportSkipped: (String) -> Void) async throws -> AVMutableComposition {
    let composition = AVMutableComposition()
    var inserted = 0
    for url in inputs {
        let asset = AVURLAsset(url: url)
        let tracks: [AVAssetTrack]
        let duration: CMTime
        do {
            tracks = try await asset.loadTracks(withMediaType: .audio)
            duration = try await asset.load(.duration)
        } catch {
            throw MixError("録音を読めない: \(url.lastPathComponent) (\(error.localizedDescription))")
        }
        guard let source = tracks.first, duration.isNumeric, duration > .zero else {
            reportSkipped("空の録音を飛ばす: \(url.lastPathComponent)")
            continue
        }
        guard let target = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw MixError("トラックを足せない: \(url.lastPathComponent)")
        }
        do {
            try target.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: source, at: .zero)
        } catch {
            throw MixError("録音を重ねられない: \(url.lastPathComponent) (\(error.localizedDescription))")
        }
        inserted += 1
    }
    guard inserted > 0 else { throw MixError("混ぜる録音が無い") }
    return composition
}

private func describe(_ error: Error?) -> String {
    error.map { $0.localizedDescription } ?? "不明"
}

private final class SamplePump: @unchecked Sendable {
    private let reader: AVAssetReader
    private let output: AVAssetReaderAudioMixOutput
    private let input: AVAssetWriterInput
    private let queue = DispatchQueue(label: "live-mindmap.mix")

    init(reader: AVAssetReader, output: AVAssetReaderAudioMixOutput, input: AVAssetWriterInput) {
        self.reader = reader
        self.output = output
        self.input = input
    }

    func run() async -> Bool {
        await withCheckedContinuation { continuation in
            input.requestMediaDataWhenReady(on: queue) { [self] in
                while input.isReadyForMoreMediaData {
                    if let sample = output.copyNextSampleBuffer() {
                        if !input.append(sample) {
                            reader.cancelReading()
                            continuation.resume(returning: true)
                            return
                        }
                    } else {
                        input.markAsFinished()
                        continuation.resume(returning: reader.status == .failed)
                        return
                    }
                }
            }
        }
    }
}
