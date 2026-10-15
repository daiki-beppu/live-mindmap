import FluidAudio
import Foundation

public struct SpeakerModelsArgumentsError: Error {
    public let message: String
}

public func parseInstallSpeakerModelsArguments(_ arguments: [String]) -> Result<Void, SpeakerModelsArgumentsError> {
    guard arguments.isEmpty else {
        return .failure(SpeakerModelsArgumentsError(message: "install-speaker-models は引数を受け付けません"))
    }
    return .success(())
}

/// 入っていなければ `download` を 1 回呼ぶ。入っていれば何もしない（冪等）。`download` の失敗はそのまま投げる。
func installSpeakerModels(isInstalled: () -> Bool, download: () async throws -> Void) async throws {
    guard !isInstalled() else { return }
    try await download()
}

/// 取得が最後まで終わったことを示す印。FluidAudio は取得の前に保存先のフォルダを作るので、フォルダがあるだけでは取得の途中で止まった状態と区別できない。
/// モデルのフォルダごとに置く（Sortformer と WeSpeaker は別のフォルダ）。
func speakerModelsInstalledMarker(in directory: URL) -> URL {
    SortformerSpeakerDiarizer.modelURL(in: directory).deletingLastPathComponent().appendingPathComponent(".install-complete")
}

func speakerModelsInstalled(in directory: URL) -> Bool {
    FileManager.default.fileExists(atPath: speakerModelsInstalledMarker(in: directory).path)
}

/// WeSpeaker（混入の検出）の取得の印。
func weSpeakerInstalledMarker(in directory: URL) -> URL {
    WeSpeakerEmbedder.folder(in: directory).appendingPathComponent(".install-complete")
}

func weSpeakerInstalled(in directory: URL) -> Bool {
    FileManager.default.fileExists(atPath: weSpeakerInstalledMarker(in: directory).path)
}

/// 話者分離のモデル（Sortformer と、混入の検出に使う WeSpeaker）をセットアップの段で前もって取得する。会議の開始時やセッション中には呼ばない。
/// モデルごとに取得の印を持つので、片方だけ入っている環境でも、足りない方だけを取る。
public func installSpeakerModels(progress: @escaping (String) -> Void) async throws {
    let directory = defaultSpeakerModelDirectory
    let sortformer = SortformerSpeakerDiarizer.modelURL(in: directory)
    try await installSpeakerModels(
        isInstalled: { speakerModelsInstalled(in: directory) },
        download: {
            progress("Sortformer を取得中: \(sortformer.path)")
            try await ModelHub.download(.sortformer, to: directory, variant: sortformer.pathComponents.suffix(3).joined(separator: "/"))
            // 取得済みのファイルは FluidAudio が飛ばす。途中で止まった取得は、次の実行でここから再開する。
            try Data().write(to: speakerModelsInstalledMarker(in: directory))
        }
    )
    let weSpeakerFolder = WeSpeakerEmbedder.folder(in: directory)
    try await installSpeakerModels(
        isInstalled: { weSpeakerInstalled(in: directory) },
        download: {
            progress("WeSpeaker を取得中: \(weSpeakerFolder.path)")
            try await ModelHub.download(.diarizer, to: directory)
            try Data().write(to: weSpeakerInstalledMarker(in: directory))
        }
    )
    progress("話者分離のモデルの導入完了")
}
