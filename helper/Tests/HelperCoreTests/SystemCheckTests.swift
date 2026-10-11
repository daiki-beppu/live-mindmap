import AVFoundation
import Foundation
import Speech
import Testing
@testable import HelperCore

@Suite("開始前確認の状態取得")
struct SystemCheckTests {
    @Test("C4: no-screen は画面許可を取得せず、マイクとモデルは確認する")
    func noScreenSkipsPermissionLookup() async throws {
        var speechCalls = 0
        var localeCalls = 0
        var microphoneCalls = 0
        var screenCalls = 0
        let status = try await systemCheck(
            noScreen: true,
            speechStatus: { speechCalls += 1; return .installed },
            installedLocales: { localeCalls += 1; return [Locale(identifier: "ja_JP")] },
            microphone: { microphoneCalls += 1; return .denied },
            screenCapture: { screenCalls += 1; return false }
        )
        let output = try #require(JSONSerialization.jsonObject(with: Data(status.jsonString().utf8)) as? [String: Any])
        let speech = try #require(output["speechJa"] as? [String: Any])
        #expect(output["microphone"] as? String == "denied")
        #expect(speech["status"] as? String == "installed")
        #expect(speech["installedLocales"] as? [String] == ["ja_JP"])
        #expect(speechCalls == 1)
        #expect(localeCalls == 1)
        #expect(microphoneCalls == 1)
        #expect(screenCalls == 0)
        #expect(!output.keys.contains("screenCapture"))
    }

    @Test("C4: 通常の確認は画面許可を一度取得し、取得値をそのまま返す", arguments: [false, true])
    func screenPermissionIsCollected(allowed: Bool) async throws {
        var screenCalls = 0
        let status = try await systemCheck(
            noScreen: false,
            speechStatus: { .supported },
            installedLocales: { [] },
            microphone: { .authorized },
            screenCapture: { screenCalls += 1; return allowed }
        )
        let output = try #require(JSONSerialization.jsonObject(with: Data(status.jsonString().utf8)) as? [String: Any])
        #expect(output["microphone"] as? String == "authorized")
        #expect(output["screenCapture"] as? Bool == allowed)
        #expect(screenCalls == 1)
    }
}
