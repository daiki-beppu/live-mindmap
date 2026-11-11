import AVFoundation
import Foundation

public struct FileAudioExportError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public func exportFileAudio(from input: URL, to output: URL) async throws {
    guard !FileManager.default.fileExists(atPath: output.path) else {
        throw FileAudioExportError("出力が既にある: \(output.path)")
    }
    let source = try await FileAudioSource.open(input)
    let range = try await source.track.load(.timeRange)
    guard range.duration.isNumeric, range.duration > .zero else {
        throw FileAudioExportError("音声の長さが決まらない: \(input.path)")
    }
    let composition = AVMutableComposition()
    guard let target = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw FileAudioExportError("トラックを足せない: \(input.path)")
    }
    try target.insertTimeRange(range, of: source.track, at: .zero)
    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else {
        throw FileAudioExportError("m4a の書き出しを始められない: \(input.path)")
    }
    do {
        try await session.export(to: output, as: .m4a)
    } catch {
        try? FileManager.default.removeItem(at: output)
        throw FileAudioExportError("音声を書き出せない: \(error.localizedDescription)")
    }
}

public func exportFileAudioTracks(theirs: URL, mine: URL?, into directory: URL) async throws {
    try await exportFileAudio(from: theirs, to: directory.appendingPathComponent(recordingFileName(track: .相手, attempt: 1)))
    if let mine {
        try await exportFileAudio(from: mine, to: directory.appendingPathComponent(recordingFileName(track: .自分, attempt: 1)))
    }
}

public func fileCreationDate(of url: URL) async -> Date? {
    let asset = AVURLAsset(url: url)
    guard let item = try? await asset.load(.creationDate) else { return nil }
    if let date = try? await item.load(.dateValue) { return date }
    guard let text = try? await item.load(.stringValue) else { return nil }
    return try? Date(text, strategy: .iso8601)
}
