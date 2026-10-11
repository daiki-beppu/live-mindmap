import AVFoundation
import CoreGraphics
import Foundation
import Speech

public func systemCheck(noScreen: Bool = false) async throws -> CheckStatus {
    let transcriber = SpeechTranscriber(
        locale: Locale(identifier: "ja-JP"),
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: [.audioTimeRange]
    )
    return try await systemCheck(
        noScreen: noScreen,
        speechStatus: { await AssetInventory.status(forModules: [transcriber]) },
        installedLocales: { await SpeechTranscriber.installedLocales },
        microphone: { AVCaptureDevice.authorizationStatus(for: .audio) },
        screenCapture: { CGPreflightScreenCaptureAccess() }
    )
}

func systemCheck(
    noScreen: Bool,
    speechStatus: () async -> AssetInventory.Status,
    installedLocales: () async -> [Locale],
    microphone: () -> AVAuthorizationStatus,
    screenCapture: () -> Bool
) async throws -> CheckStatus {
    let status = await speechStatus()
    let locales = await installedLocales()
    return try CheckStatus(
        speechStatus: status, installedLocales: locales, microphone: microphone(),
        screenCapture: noScreen ? nil : screenCapture()
    )
}
