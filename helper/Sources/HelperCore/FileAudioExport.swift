import AVFoundation
import Foundation

// 録画のファイル（`cli recorded`）から、セッションのフォルダへ置く音声と、記録された作成日時を取り出す。

public struct FileAudioExportError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// ファイルの音声だけを AAC の m4a として `output` に書く（動画からも映像を除いて書く）。元のファイルはコピーしない。
/// トラックの範囲の先頭を出力の 0 秒に置く（冒頭の空きも残る。`FileAudioInputs` の原点と同じ）。`output` が既にあるときは、上書きせず失敗する。
/// 失敗したときは、書きかけの `output` を残さない。
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
    // 入力はトラック自身の範囲（開始が 0 とは限らない）を取り、出力の 0 秒へ置く
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

/// `cli recorded` の音声を、ライブと同じ名前でセッションのフォルダ `directory` に書く。相手用は `相手.m4a`、自分用（あれば）は `自分.m4a`。
/// 自分用が読めないときは失敗し、`自分.m4a` は残らない。
public func exportFileAudioTracks(theirs: URL, mine: URL?, into directory: URL) async throws {
    try await exportFileAudio(from: theirs, to: directory.appendingPathComponent(recordingFileName(track: .相手, attempt: 1)))
    if let mine {
        try await exportFileAudio(from: mine, to: directory.appendingPathComponent(recordingFileName(track: .自分, attempt: 1)))
    }
}

/// ファイルに記録された作成日時。記録が無いとき、ファイルを読めないときは nil（ファイルシステムの日時では代用しない）。
public func fileCreationDate(of url: URL) async -> Date? {
    let asset = AVURLAsset(url: url)
    guard let item = try? await asset.load(.creationDate) else { return nil }
    if let date = try? await item.load(.dateValue) { return date }
    guard let text = try? await item.load(.stringValue) else { return nil }
    return try? Date(text, strategy: .iso8601)
}
