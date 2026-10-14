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
func speakerModelsInstalledMarker(in directory: URL) -> URL {
    SortformerSpeakerDiarizer.modelURL(in: directory).deletingLastPathComponent().appendingPathComponent(".install-complete")
}

func speakerModelsInstalled(in directory: URL) -> Bool {
    FileManager.default.fileExists(atPath: speakerModelsInstalledMarker(in: directory).path)
}

/// 話者分離のモデルをセットアップの段で前もって取得する。会議の開始時やセッション中には呼ばない。
/// 取得するのは Sortformer だけ。後で使う WeSpeaker（FluidAudio 同梱）は、同じ段でここに足す。
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
    progress("話者分離のモデルの導入完了")
}
