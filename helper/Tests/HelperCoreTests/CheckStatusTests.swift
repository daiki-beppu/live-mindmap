import AVFoundation
import Foundation
import HelperCore
import Speech
import Testing

private struct CheckOutput: Decodable {
    struct SpeechJa: Decodable {
        let status: String
        let installedLocales: [String]
    }

    let speechJa: SpeechJa
    let microphone: String
    let screenCapture: Bool
}

private func decodeCheck(
    speechStatus: AssetInventory.Status,
    installedLocales: [Locale],
    microphone: AVAuthorizationStatus,
    screenCapture: Bool
) throws -> CheckOutput {
    let status = try CheckStatus(
        speechStatus: speechStatus,
        installedLocales: installedLocales,
        microphone: microphone,
        screenCapture: screenCapture
    )
    let json = try status.jsonString()
    return try JSONDecoder().decode(CheckOutput.self, from: Data(json.utf8))
}

@Suite("確認結果の JSON")
struct CheckStatusTests {
    @Test("日本語モデルの状態を区別して JSON に写す", arguments: [
        (AssetInventory.Status.unsupported, "unsupported"),
        (.supported, "supported"),
        (.downloading, "downloading"),
        (.installed, "installed"),
    ])
    func speechStatusIsEncoded(status: AssetInventory.Status, expected: String) throws {
        let output = try decodeCheck(
            speechStatus: status, installedLocales: [],
            microphone: .notDetermined, screenCapture: false
        )

        #expect(output.speechJa.status == expected)
    }

    @Test("installed locales はモデルの状態から推測せず全 locale の識別子を写す", arguments: [
        (AssetInventory.Status.installed, [String]()),
        (.supported, ["ja-JP", "en-US"]),
        (.unsupported, ["en-US"]),
    ])
    func installedLocalesAreIndependent(status: AssetInventory.Status, identifiers: [String]) throws {
        let locales = identifiers.map { Locale(identifier: $0) }
        let output = try decodeCheck(
            speechStatus: status, installedLocales: locales,
            microphone: .notDetermined, screenCapture: false
        )

        #expect(output.speechJa.installedLocales.sorted() == identifiers.sorted())
    }

    @Test("マイクは未決定・拒否・許可を返し restricted も拒否に含める", arguments: [
        (AVAuthorizationStatus.notDetermined, "notDetermined"),
        (.denied, "denied"),
        (.restricted, "denied"),
        (.authorized, "authorized"),
    ])
    func microphoneAuthorizationIsEncoded(status: AVAuthorizationStatus, expected: String) throws {
        let output = try decodeCheck(
            speechStatus: .supported, installedLocales: [],
            microphone: status, screenCapture: false
        )

        #expect(output.microphone == expected)
    }

    @Test("画面収録の許可あり・なしを JSON の Bool に写す", arguments: [false, true])
    func screenCapturePermissionIsEncoded(allowed: Bool) throws {
        let output = try decodeCheck(
            speechStatus: .supported, installedLocales: [],
            microphone: .notDetermined, screenCapture: allowed
        )

        #expect(output.screenCapture == allowed)
    }
}
