import AVFoundation
import Foundation
import Testing
@testable import HelperCore

// マイクに触れずに確かめられる開始・停止の契約（ProcessTap と同じ）。
// 音声処理（エコーキャンセル）を使わないことは、Microphone.swift に setVoiceProcessingEnabled の呼び出しがないことで確かめる。

@Suite("マイク取得の開始と停止", .timeLimit(.minutes(1)))
struct MicrophoneCaptureTests {
    @Test("start より前に stop が呼ばれたら、start は何も作らず、要素のない終わった流れを返す")
    func stopBeforeStartYieldsFinishedStream() async throws {
        let microphone = MicrophoneCapture()
        microphone.stop()
        let stream = try microphone.start()
        var count = 0
        for try await _ in stream { count += 1 }
        #expect(count == 0)
    }

    @Test("stop は何度呼んでもよい")
    func stopIsIdempotent() {
        let microphone = MicrophoneCapture()
        microphone.stop()
        microphone.stop()
    }
}

// 入力の機器の切り替え（AVAudioEngineConfigurationChange）の扱い（Issue #232）。
// 通知の送り元をテストのオブジェクトにし、専用の NotificationCenter から送る。
@Suite("マイク取得中の構成の変化", .timeLimit(.minutes(1)))
struct MicrophoneConfigurationChangeTests {
    @Test("構成の変化を受けたら、流れが configurationChanged のエラーで終わる")
    func configurationChangeFinishesStreamWithError() async {
        let center = NotificationCenter()
        let source = NSObject()
        let microphone = MicrophoneCapture(notificationCenter: center)
        let stream = microphone.startWithoutMicrophone(configurationSource: source)
        center.post(name: .AVAudioEngineConfigurationChange, object: source)
        await #expect {
            for try await _ in stream {}
        } throws: { error in
            if case MicrophoneError.configurationChanged = error { return true }
            return false
        }
        microphone.stop()
    }

    @Test("別の送り元の構成の変化では、流れは終わらない")
    func configurationChangeOfOtherSourceIsIgnored() async throws {
        let center = NotificationCenter()
        let source = NSObject()
        let microphone = MicrophoneCapture(notificationCenter: center)
        let stream = microphone.startWithoutMicrophone(configurationSource: source)
        center.post(name: .AVAudioEngineConfigurationChange, object: NSObject())
        microphone.stop()
        // stop で正常に終わる（別の送り元の通知でエラーになっていない）。
        for try await _ in stream {}
    }

    @Test("stop で購読が外れ、その後に構成の変化を受けても流れは正常に終わる")
    func stopRemovesObservation() async throws {
        let center = NotificationCenter()
        let source = NSObject()
        let microphone = MicrophoneCapture(notificationCenter: center)
        let stream = microphone.startWithoutMicrophone(configurationSource: source)
        #expect(microphone.observesConfigurationChange)
        microphone.stop()
        #expect(!microphone.observesConfigurationChange)
        center.post(name: .AVAudioEngineConfigurationChange, object: source)
        for try await _ in stream {}
    }

    @Test("理由は標準エラーで機器の切り替えと分かる文で出る")
    func configurationChangedDescription() {
        #expect("\(MicrophoneError.configurationChanged)".contains("入力の機器の切り替え"))
    }
}
