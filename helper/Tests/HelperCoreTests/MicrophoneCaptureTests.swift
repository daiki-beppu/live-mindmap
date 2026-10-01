import Testing
import HelperCore

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
