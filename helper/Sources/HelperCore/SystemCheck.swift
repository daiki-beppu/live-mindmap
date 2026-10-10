import AVFoundation
import CoreGraphics
import Foundation
import Speech

public func systemCheck() async throws -> CheckStatus {
    let transcriber = SpeechTranscriber(
        locale: Locale(identifier: "ja-JP"),
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: [.audioTimeRange]
    )
    let speechStatus = await AssetInventory.status(forModules: [transcriber])
    let installedLocales = await SpeechTranscriber.installedLocales
    return try CheckStatus(
        speechStatus: speechStatus,
        installedLocales: installedLocales,
        microphone: AVCaptureDevice.authorizationStatus(for: .audio),
        screenCapture: CGPreflightScreenCaptureAccess()
    )
}
