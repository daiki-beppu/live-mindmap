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

func installSpeakerModels(isInstalled: () -> Bool, download: () async throws -> Void) async throws {
    guard !isInstalled() else { return }
    try await download()
}

/// 取得が最後まで終わったことを示す印。FluidAudio は取得の前に保存先のフォルダを作るので、フォルダがあるだけでは取得の途中で止まった状態と区別できない。
func speakerModelsInstalledMarker(in directory: URL) -> URL {
    directory.appendingPathComponent(Repo.nemotron3Diarization.folderName).appendingPathComponent(".install-complete")
}

func speakerModelsInstalled(in directory: URL) -> Bool {
    FileManager.default.fileExists(atPath: speakerModelsInstalledMarker(in: directory).path)
}

func weSpeakerInstalledMarker(in directory: URL) -> URL {
    WeSpeakerEmbedder.folder(in: directory).appendingPathComponent(".install-complete")
}

func weSpeakerInstalled(in directory: URL) -> Bool {
    FileManager.default.fileExists(atPath: weSpeakerInstalledMarker(in: directory).path)
}

public func installSpeakerModels(progress: @escaping (String) -> Void) async throws {
    let directory = defaultSpeakerModelDirectory
    let model = Nemotron3SpeakerDiarizer.modelURL(in: directory)
    try await installSpeakerModels(
        isInstalled: { speakerModelsInstalled(in: directory) },
        download: {
            progress("Nemotron 3 fast32 を取得中: \(model.path)")
            _ = try await Nemotron3Models.loadFromHuggingFace(config: .fast32, cacheDirectory: directory)
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
