import AVFoundation
import CoreAudio
import Testing
@testable import HelperCore

// 2 トラック共通の基準時刻（ホスト時刻）からの秒数と、結果の時刻のずらし方。

private func audio(at hostTime: UInt64) throws -> CapturedAudio {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160))
    return CapturedAudio(buffer: buffer, hostTime: hostTime)
}

private func hostTime(after origin: UInt64, nanos: UInt64) -> UInt64 {
    origin + AudioConvertNanosToHostTime(nanos)
}

@Suite("共通の基準時刻")
struct TimelineTests {
    @Test("基準時刻より 1.5 秒後のホスト時刻は 1.5 秒になる")
    func secondsAfterOrigin() {
        let origin = AudioGetCurrentHostTime()
        let seconds = offsetSeconds(from: origin, to: hostTime(after: origin, nanos: 1_500_000_000))
        #expect(abs(seconds - 1.5) < 0.001)
    }

    @Test("基準時刻と同じホスト時刻は 0 秒")
    func sameAsOriginIsZero() {
        let origin = AudioGetCurrentHostTime()
        #expect(offsetSeconds(from: origin, to: origin) == 0)
    }

    @Test("基準時刻より前のホスト時刻は、桁あふれせず 0 秒にする")
    func beforeOriginClampsToZero() {
        let origin = AudioGetCurrentHostTime() + AudioConvertNanosToHostTime(5_000_000_000)
        let earlier = origin - AudioConvertNanosToHostTime(2_000_000_000)
        #expect(offsetSeconds(from: origin, to: earlier) == 0)
    }

    @Test("最初の音声の取得時刻と基準時刻の差が、結果の start と end に足される")
    func alignAddsOffsetOfFirstAudio() throws {
        let origin = AudioGetCurrentHostTime()
        let timeline = TrackTimeline(origin: origin)
        timeline.record(try audio(at: hostTime(after: origin, nanos: 500_000_000)))

        let aligned = timeline.align(TranscriptionResult(text: "はい", isFinal: false, start: 2.5, end: 3.5))
        #expect(abs(aligned.start - 3.0) < 0.001 && abs(aligned.end - 4.0) < 0.001)
        #expect(aligned.text == "はい" && aligned.isFinal == false)
    }

    @Test("2 本目以降の音声では補正量を上書きしない")
    func laterAudioDoesNotOverwriteOffset() throws {
        let origin = AudioGetCurrentHostTime()
        let timeline = TrackTimeline(origin: origin)
        timeline.record(try audio(at: hostTime(after: origin, nanos: 500_000_000)))
        timeline.record(try audio(at: hostTime(after: origin, nanos: 900_000_000)))

        let aligned = timeline.align(TranscriptionResult(text: "はい", isFinal: true, start: 2.5, end: 3.5))
        #expect(abs(aligned.start - 3.0) < 0.001 && abs(aligned.end - 4.0) < 0.001)
    }

    @Test("最初の音声の取得時刻が違う 2 トラックでも、同じ瞬間の発言は補正後に同じ値になる")
    func sameInstantUtteranceGetsSameTimeOnBothTracks() throws {
        let origin = AudioGetCurrentHostTime()
        let tap = TrackTimeline(origin: origin)
        let mic = TrackTimeline(origin: origin)
        // 取得開始が 0.5 秒（相手）と 1.2 秒（自分）で違う。
        tap.record(try audio(at: hostTime(after: origin, nanos: 500_000_000)))
        mic.record(try audio(at: hostTime(after: origin, nanos: 1_200_000_000)))

        // 共通の基準から 3.0〜4.0 秒の発言。アナライザから見ると相手は 2.5〜3.5、自分は 1.8〜2.8 になる。
        let tapResult = tap.align(TranscriptionResult(text: "はい", isFinal: true, start: 2.5, end: 3.5))
        let micResult = mic.align(TranscriptionResult(text: "はい", isFinal: true, start: 1.8, end: 2.8))
        #expect(abs(tapResult.start - 3.0) < 0.001 && abs(tapResult.end - 4.0) < 0.001)
        #expect(abs(micResult.start - 3.0) < 0.001 && abs(micResult.end - 4.0) < 0.001)
    }

    @Test("時刻のずらしは start と end だけを変え、本文と確定の区別は変えない")
    func shiftChangesOnlyTimes() {
        let final = TranscriptionResult(text: "こんにちは", isFinal: true, start: 1.0, end: 2.5)
        #expect(final.shifted(by: 0.75) == TranscriptionResult(text: "こんにちは", isFinal: true, start: 1.75, end: 3.25))

        let partial = TranscriptionResult(text: "こんに", isFinal: false, start: 0, end: 1)
        #expect(partial.shifted(by: 2) == TranscriptionResult(text: "こんに", isFinal: false, start: 2, end: 3))
    }

    @Test("0 秒のずらしは結果を変えない")
    func zeroShiftIsIdentity() {
        let result = TranscriptionResult(text: "はい", isFinal: true, start: 4, end: 5)
        #expect(result.shifted(by: 0) == result)
    }

    @Test("時刻付きの音声は、バッファとホスト時刻をそのまま持つ")
    func capturedAudioCarriesBufferAndHostTime() throws {
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160))
        let audio = CapturedAudio(buffer: buffer, hostTime: 12_345)
        #expect(audio.buffer === buffer)
        #expect(audio.hostTime == 12_345)
    }
}
