import Foundation
import Speech

public struct SpeechJaArgumentsError: Error {
    public let message: String
}

public func parseInstallSpeechJaArguments(_ arguments: [String]) -> Result<Void, SpeechJaArgumentsError> {
    guard arguments.isEmpty else {
        return .failure(SpeechJaArgumentsError(message: "install-speech-ja は引数を受け付けません"))
    }
    return .success(())
}

public func installSpeechJa(progress: @escaping (String) -> Void) async throws {
    let transcriber = SpeechTranscriber(
        locale: Locale(identifier: "ja-JP"),
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: [.audioTimeRange]
    )
    progress("日本語モデルの予約を確認中")
    try await installSpeechJa(
        speechStatus: { await AssetInventory.status(forModules: [transcriber]) },
        installationRequest: {
            guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
                return nil
            }
            return {
                progress("日本語モデルを取得中")
                try await request.downloadAndInstall()
            }
        }
    )
    progress("日本語モデルの導入完了")
}

func installSpeechJa(
    speechStatus: () async -> AssetInventory.Status,
    installationRequest: () async throws -> (() async throws -> Void)?
) async throws {
    guard await speechStatus() != .unsupported else {
        throw TranscriberError.unsupportedLocale("ja-JP")
    }
    if let download = try await installationRequest() {
        try await download()
    }
}
