import AVFoundation
import CoreAudio
import Testing
@testable import HelperCore

// トラックごとの録音（AAC・モノラル）。0 秒は発言の時刻の基準（origin）と同じ時点。


private func hostTime(after origin: UInt64, nanos: UInt64) -> UInt64 {
    origin + AudioConvertNanosToHostTime(nanos)
}

@Suite("録音")
struct RecordingTests {
    @Test("録音の音質の設定は、話者分離にかけられる下限（AAC 64 kbps・16 kHz）以上")
    func qualityConstantsMeetFloor() {
        #expect(recordingBitRate >= 64_000)
        #expect(recordingSampleRate >= 16_000)
        #expect(recordingChannelCount == 1)
    }

    @Test("最初のバッファが基準より 0.5 秒後なら、先頭に 0.5 秒分（24000 フレーム）の無音を入れる")
    func leadingSilenceAfterOrigin() {
        let origin = AudioGetCurrentHostTime()
        let frames = leadingSilenceFrames(origin: origin, firstHostTime: hostTime(after: origin, nanos: 500_000_000), sampleRate: 48_000)
        #expect(abs(Int(frames) - 24_000) <= 48)
    }

    @Test("最初のバッファが基準と同じか前なら、無音は入れない")
    func noLeadingSilenceAtOrBeforeOrigin() {
        let origin = AudioGetCurrentHostTime() + AudioConvertNanosToHostTime(5_000_000_000)
        #expect(leadingSilenceFrames(origin: origin, firstHostTime: origin, sampleRate: 48_000) == 0)
        let earlier = origin - AudioConvertNanosToHostTime(2_000_000_000)
        #expect(leadingSilenceFrames(origin: origin, firstHostTime: earlier, sampleRate: 48_000) == 0)
    }
}
