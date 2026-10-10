import AVFoundation
import Foundation
import Speech

private enum CheckStatusError: Error {
    case unknownSpeechStatus
    case unknownMicrophoneAuthorization
}

public struct CheckStatus: Encodable {
    private struct SpeechJa: Encodable {
        let status: String
        let installedLocales: [String]
    }

    private let speechJa: SpeechJa
    private let microphone: String
    private let screenCapture: Bool

    public init(
        speechStatus: AssetInventory.Status,
        installedLocales: [Locale],
        microphone: AVAuthorizationStatus,
        screenCapture: Bool
    ) throws {
        let status: String
        switch speechStatus {
        case .unsupported: status = "unsupported"
        case .supported: status = "supported"
        case .downloading: status = "downloading"
        case .installed: status = "installed"
        @unknown default: throw CheckStatusError.unknownSpeechStatus
        }
        speechJa = SpeechJa(status: status, installedLocales: installedLocales.map { $0.identifier })
        switch microphone {
        case .notDetermined: self.microphone = "notDetermined"
        case .denied, .restricted: self.microphone = "denied"
        case .authorized: self.microphone = "authorized"
        @unknown default: throw CheckStatusError.unknownMicrophoneAuthorization
        }
        self.screenCapture = screenCapture
    }

    public func jsonString() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(self), as: UTF8.self)
    }
}
