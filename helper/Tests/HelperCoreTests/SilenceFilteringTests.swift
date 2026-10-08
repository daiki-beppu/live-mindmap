import AVFoundation
import CoreAudio
import Foundation
import Testing
@testable import HelperCore

// ほぼ無音の区間の認識結果を捨てる `SilenceFilteringTranscriber`（Issue #144）。
// 音声認識は使わず、偽の Transcriber で流すので CI でも流す。

private let testSampleRate = 48_000.0

/// -30 dBFS（RMS）の定数値。声の大きさの目安（Issue #144）。
private let loudValue: Float = 0.0316228
/// 完全な無音。
private let silentValue: Float = 0
/// -80 dBFS（RMS）の定数値。0 ではないが、しきい値（-70 dBFS）より小さい。
private let belowThresholdValue: Float = 0.0001

/// 一定の音量が続く区間をつなげた音声の流れ。最初のバッファだけ `firstHostTime` を使う。
/// `TrackLoudness` は最初のバッファの取得時刻だけを基準に使い、以後は受け取った音声のフレーム数を積むので、
/// 2 つ目以降のバッファの `hostTime` 自体は判定に関係しない（それでも実際の取得と同じく連続した値を入れる）。
private func audioStream(
    firstHostTime: UInt64, segments: [(value: Float, seconds: Double)]
) -> AsyncThrowingStream<CapturedAudio, Error> {
    AsyncThrowingStream { continuation in
        var hostTime = firstHostTime
        for segment in segments {
            let frames = Int((segment.seconds * testSampleRate).rounded())
            continuation.yield(constantAudio(
                value: segment.value, frames: frames, sampleRate: testSampleRate,
                channels: 1, interleaved: false, hostTime: hostTime))
            hostTime += hostTicks(milliseconds: segment.seconds * 1000)
        }
        continuation.finish()
    }
}

private func collectResults(_ stream: AsyncThrowingStream<TranscriptionResult, Error>) async throws -> [TranscriptionResult] {
    var all: [TranscriptionResult] = []
    for try await result in stream { all.append(result) }
    return all
}

/// 2ch interleaved で、左右チャンネルに別々の値を敷き詰めたバッファ（`constantAudio` の非対称版）。
/// 全チャンネルを読んでいるかを、左右対称の値では検出できない回帰（片方のチャンネルだけを読み落とす）向けに使う。
private func twoChannelInterleavedAudio(
    left: Float, right: Float, frames: Int, sampleRate: Double, hostTime: UInt64
) -> CapturedAudio {
    let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 2, interleaved: true)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    let data = buffer.floatChannelData!
    for frame in 0..<frames {
        data[0][frame * 2] = left
        data[0][frame * 2 + 1] = right
    }
    return CapturedAudio(buffer: buffer, hostTime: hostTime)
}

/// 音声を全部読み切ってから、仕込んだ結果を返す偽の Transcriber（`RecognizeITTests.FakeTranscriber` と同じ形）。
/// 読み切ってから返すので、判定する時点で音量の記録が揃い、競合しない。
private final class FakeTranscriber: Transcriber, @unchecked Sendable {
    private let results: [TranscriptionResult]

    init(results: [TranscriptionResult]) { self.results = results }

    func prepare() async throws {}

    func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        for try await _ in audio {}
        let results = self.results
        return AsyncThrowingStream { continuation in
            results.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }
}

/// 受け取った音声の `hostTime` と先頭サンプルの値、`origin` を記録する偽の Transcriber。
private final class RecordingTranscriber: Transcriber, @unchecked Sendable {
    private let lock = NSLock()
    private var _receivedHostTimes: [UInt64] = []
    private var _receivedValues: [Float] = []
    private var _receivedOrigin: UInt64?

    var receivedHostTimes: [UInt64] { lock.withLock { _receivedHostTimes } }
    var receivedValues: [Float] { lock.withLock { _receivedValues } }
    var receivedOrigin: UInt64? { lock.withLock { _receivedOrigin } }

    func prepare() async throws {}

    func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        lock.withLock { _receivedOrigin = origin }
        for try await captured in audio {
            let value = captured.buffer.floatChannelData?[0][0] ?? .nan
            lock.withLock {
                _receivedHostTimes.append(captured.hostTime)
                _receivedValues.append(value)
            }
        }
        return AsyncThrowingStream { continuation in continuation.finish() }
    }
}

/// 受け取った音声の流れがエラーで終わったときのそのエラーを記録し、別に仕込んだエラーで結果の流れを終わらせる偽の Transcriber。
/// 2 つの区間（渡された音声への伝播／base が返した結果への伝播）を別々のエラーで見分けるために使う。
private final class ErrorCapturingTranscriber: Transcriber, @unchecked Sendable {
    private let resultError: Error
    private let lock = NSLock()
    private var _capturedAudioError: Error?

    var capturedAudioError: Error? { lock.withLock { _capturedAudioError } }

    init(resultError: Error) { self.resultError = resultError }

    func prepare() async throws {}

    func transcribe(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        do {
            for try await _ in audio {}
        } catch {
            lock.withLock { _capturedAudioError = error }
        }
        let resultError = self.resultError
        return AsyncThrowingStream { continuation in continuation.finish(throwing: resultError) }
    }
}

@Suite("ほぼ無音の区間の認識結果を捨てる")
struct SilenceFilteringTests {
    @Test("区間の音が全部ほぼ無音なら、途中結果も確定結果も出ない(Issue #144 の再現条件)")
    func dropsResultsOverSilentSpan() async throws {
        let origin = AudioGetCurrentHostTime()
        let audio = audioStream(firstHostTime: origin, segments: [(silentValue, 12)])
        let base = FakeTranscriber(results: [
            TranscriptionResult(text: "あ", isFinal: false, start: 7.726, end: 11.026),
            TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026),
        ])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results.isEmpty)
    }

    @Test("0 ではない、しきい値未満の音量でも、途中結果も確定結果も出ない")
    func dropsResultsOverNonZeroButBelowThresholdSpan() async throws {
        let origin = AudioGetCurrentHostTime()
        let audio = audioStream(firstHostTime: origin, segments: [(belowThresholdValue, 12)])
        let base = FakeTranscriber(results: [
            TranscriptionResult(text: "あ", isFinal: false, start: 7.726, end: 11.026),
            TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026),
        ])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results.isEmpty)
    }

    @Test("結果の区間の外（直前・直後の境界窓内）にだけ声の大きさの音があっても、途中結果も確定結果も出ない(境界窓を丸ごと集計しない)")
    func dropsResultsWhenLoudSoundIsOnlyOutsideResultSpan() async throws {
        let origin = AudioGetCurrentHostTime()
        let audio = audioStream(firstHostTime: origin, segments: [
            (silentValue, 7.721), (loudValue, 0.005), (silentValue, 3.300), (loudValue, 0.005), (silentValue, 1.0),
        ])
        let base = FakeTranscriber(results: [
            TranscriptionResult(text: "あ", isFinal: false, start: 7.726, end: 11.026),
            TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026),
        ])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results.isEmpty)
    }

    @Test("同じ声の大きさの音を結果の区間の内側に置くと、途中結果も確定結果も変えずに出る(直前の境界窓テストとの対比)")
    func passesResultsWhenLoudSoundIsInsideResultSpan() async throws {
        let origin = AudioGetCurrentHostTime()
        let audio = audioStream(firstHostTime: origin, segments: [
            (silentValue, 9.0), (loudValue, 0.005), (silentValue, 2.1),
        ])
        let partial = TranscriptionResult(text: "あ", isFinal: false, start: 7.726, end: 11.026)
        let final = TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026)
        let base = FakeTranscriber(results: [partial, final])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [partial, final])
    }

    @Test("結果の区間の先頭 20ms 以内（窓単位で集計する旧実装なら除外されていた範囲）に声の大きさの音があっても、途中結果も確定結果も変えずに出る")
    func passesResultsWhenLoudSoundIsAtSpanStart() async throws {
        let origin = AudioGetCurrentHostTime()
        let audio = audioStream(firstHostTime: origin, segments: [
            (silentValue, 7.726), (loudValue, 0.005), (silentValue, 4.269),
        ])
        let partial = TranscriptionResult(text: "あ", isFinal: false, start: 7.726, end: 11.026)
        let final = TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026)
        let base = FakeTranscriber(results: [partial, final])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [partial, final])
    }

    @Test("結果の区間の末尾 20ms 以内（窓単位で集計する旧実装なら除外されていた範囲）に声の大きさの音があっても、途中結果も確定結果も変えずに出る")
    func passesResultsWhenLoudSoundIsAtSpanEnd() async throws {
        let origin = AudioGetCurrentHostTime()
        let audio = audioStream(firstHostTime: origin, segments: [
            (silentValue, 11.021), (loudValue, 0.005), (silentValue, 0.979),
        ])
        let partial = TranscriptionResult(text: "あ", isFinal: false, start: 7.726, end: 11.026)
        let final = TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026)
        let base = FakeTranscriber(results: [partial, final])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [partial, final])
    }

    @Test("区間長が短い無音区間でも、途中結果も確定結果も出ない")
    func dropsResultsOverShortSilentSpan() async throws {
        let origin = AudioGetCurrentHostTime()
        let audio = audioStream(firstHostTime: origin, segments: [(silentValue, 12)])
        let base = FakeTranscriber(results: [
            TranscriptionResult(text: "あ", isFinal: false, start: 7.726, end: 7.740),
            TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 7.740),
        ])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results.isEmpty)
    }

    @Test("2ch interleaved の音声（相手の ProcessTap と同じ形式）でも、区間の音量を正しく測る")
    func handlesInterleavedStereoAudio() async throws {
        let origin = AudioGetCurrentHostTime()
        let frames = Int(12 * testSampleRate)
        let audio = AsyncThrowingStream<CapturedAudio, Error> { continuation in
            continuation.yield(constantAudio(
                value: loudValue, frames: frames, sampleRate: testSampleRate,
                channels: 2, interleaved: true, hostTime: origin))
            continuation.finish()
        }
        let result = TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026)
        let base = FakeTranscriber(results: [result])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [result])
    }

    @Test("2ch interleaved の音声で、片方のチャンネルだけに声の大きさの音があっても、その結果は捨てられない(チャンネルの読み落とし回帰)")
    func passesResultsWhenOnlyOneInterleavedChannelIsLoud() async throws {
        let origin = AudioGetCurrentHostTime()
        let frames = Int(12 * testSampleRate)
        let audio = AsyncThrowingStream<CapturedAudio, Error> { continuation in
            // 左は無音、右だけ声の大きさ。`channelData[0][frame*channels+channel]` の channel オフセットを
            // 誤って固定する退行（例: 常に左だけを読む）があれば、この入力は無音と誤判定される。
            continuation.yield(twoChannelInterleavedAudio(
                left: silentValue, right: loudValue, frames: frames, sampleRate: testSampleRate, hostTime: origin))
            continuation.finish()
        }
        let result = TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026)
        let base = FakeTranscriber(results: [result])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [result])
    }

    @Test("2ch interleaved の音声が全区間ほぼ無音なら、途中結果も確定結果も出ない(`相手` が無音のときの回帰)")
    func dropsResultsOverSilentInterleavedStereoAudio() async throws {
        let origin = AudioGetCurrentHostTime()
        let frames = Int(12 * testSampleRate)
        let audio = AsyncThrowingStream<CapturedAudio, Error> { continuation in
            continuation.yield(constantAudio(
                value: silentValue, frames: frames, sampleRate: testSampleRate,
                channels: 2, interleaved: true, hostTime: origin))
            continuation.finish()
        }
        let base = FakeTranscriber(results: [
            TranscriptionResult(text: "あ", isFinal: false, start: 7.726, end: 11.026),
            TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026),
        ])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results.isEmpty)
    }

    @Test("区間に声の大きさの音があるときは、途中結果も確定結果も変えずに出る")
    func passesResultsOverLoudSpan() async throws {
        let origin = AudioGetCurrentHostTime()
        let audio = audioStream(firstHostTime: origin, segments: [(loudValue, 12)])
        let partial = TranscriptionResult(text: "あ", isFinal: false, start: 7.726, end: 11.026)
        let final = TranscriptionResult(text: "あ", isFinal: true, start: 7.726, end: 11.026)
        let base = FakeTranscriber(results: [partial, final])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [partial, final])
    }

    @Test("音量が区間ごとに違うときは、無音の区間の結果だけを捨て、声がある区間の結果は残す")
    func filtersPerResultIntervalNotWholeStream() async throws {
        let origin = AudioGetCurrentHostTime()
        // 前半 0-6 秒は無音、後半 6-12 秒は声の大きさ
        let audio = audioStream(firstHostTime: origin, segments: [(silentValue, 6), (loudValue, 6)])
        let silentResult = TranscriptionResult(text: "え", isFinal: true, start: 1, end: 3)
        let loudResult = TranscriptionResult(text: "あ", isFinal: true, start: 7, end: 9)
        let base = FakeTranscriber(results: [silentResult, loudResult])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [loudResult])
    }

    @Test("最初のバッファの取得時刻が基準からずれているときも、そのずれを踏まえた区間で判定する")
    func measuresFromFirstBufferOffset() async throws {
        let origin = AudioGetCurrentHostTime()
        let firstHostTime = origin + hostTicks(milliseconds: 2_000)
        // 基準から 2-5 秒は無音、5-8 秒は声の大きさ
        let audio = audioStream(firstHostTime: firstHostTime, segments: [(silentValue, 3), (loudValue, 3)])
        let silentResult = TranscriptionResult(text: "え", isFinal: true, start: 2.5, end: 4.5)
        let loudResult = TranscriptionResult(text: "あ", isFinal: true, start: 5.5, end: 7.5)
        let base = FakeTranscriber(results: [silentResult, loudResult])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [loudResult])
    }

    @Test("結果の区間が記録した音の範囲外なら、測れないとして捨てない")
    func keepsResultsOutsideRecordedRange() async throws {
        let origin = AudioGetCurrentHostTime()
        // 記録した音は 0-2 秒だけ。結果は 5-6 秒で、記録と重ならない
        let audio = audioStream(firstHostTime: origin, segments: [(silentValue, 2)])
        let result = TranscriptionResult(text: "あ", isFinal: true, start: 5, end: 6)
        let base = FakeTranscriber(results: [result])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [result])
    }

    @Test("結果の区間の長さが 0 なら、測れないとして捨てない")
    func keepsZeroLengthResults() async throws {
        let origin = AudioGetCurrentHostTime()
        let audio = audioStream(firstHostTime: origin, segments: [(silentValue, 12)])
        let result = TranscriptionResult(text: "あ", isFinal: true, start: 5, end: 5)
        let base = FakeTranscriber(results: [result])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [result])
    }

    @Test("渡した音声は同じ順・同じ内容・同じ hostTime で base に届き、origin もそのまま渡る")
    func forwardsAudioUnchanged() async throws {
        let origin = AudioGetCurrentHostTime()
        let firstHostTime = origin + hostTicks(milliseconds: 500)
        let segments: [(value: Float, seconds: Double)] = [(0.1, 0.2), (0.4, 0.3)]
        let audio = audioStream(firstHostTime: firstHostTime, segments: segments)
        let base = RecordingTranscriber()
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        _ = try await filtering.transcribe(audio, origin: origin)

        #expect(base.receivedOrigin == origin)
        #expect(base.receivedHostTimes == [firstHostTime, firstHostTime + hostTicks(milliseconds: 200)])
        #expect(base.receivedValues == segments.map(\.value))
    }

    @Test("音声の流れがエラーで終わると、そのエラーが base に渡す流れへ伝わり、base が返したエラーがそのまま結果の流れに出る")
    func propagatesUpstreamErrorToBaseAndBaseErrorToOutput() async throws {
        struct UpstreamFailure: Error, Equatable {}
        struct BaseFailure: Error, Equatable {}
        let origin = AudioGetCurrentHostTime()
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        input.yield(constantAudio(value: silentValue, frames: 480, sampleRate: testSampleRate, channels: 1, interleaved: false, hostTime: origin))
        input.finish(throwing: UpstreamFailure())
        let base = ErrorCapturingTranscriber(resultError: BaseFailure())
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let output = try await filtering.transcribe(upstream, origin: origin)

        await #expect(throws: BaseFailure.self) { _ = try await collectResults(output) }
        #expect(base.capturedAudioError as? UpstreamFailure == UpstreamFailure())
    }

    @Test("保持範囲（30 秒）より古い音量の記録は解放され、保持範囲内の記録は値を保ったまま残る")
    func releasesLoudnessRecordsOutsideRetentionRange() throws {
        let origin = AudioGetCurrentHostTime()
        let loudness = TrackLoudness(origin: origin)
        let bufferSeconds = 0.1
        let bufferFrames = Int(bufferSeconds * testSampleRate)
        let bufferCount = 700 // 700 * 0.1 秒 = 70 秒分（保持範囲 30 秒を超えて記録する）
        for i in 0..<bufferCount {
            let hostTime = origin + hostTicks(milliseconds: Double(i) * bufferSeconds * 1000)
            loudness.record(constantAudio(
                value: loudValue, frames: bufferFrames, sampleRate: testSampleRate,
                channels: 1, interleaved: false, hostTime: hostTime))
        }

        // 70 秒のうち先頭の 0.0-0.5 秒は保持範囲（直近 30 秒）より古く、記録が解放済みで読めないため nil（測れない）。
        #expect(loudness.isBelowSilenceThreshold(start: 0.0, end: 0.5) == nil)
        // 末尾の 69.0-69.5 秒は保持範囲内で、記録した音量（しきい値以上）のまま読め、無音ではない（false）。
        #expect(loudness.isBelowSilenceThreshold(start: 69.0, end: 69.5) == false)
    }

    @Test("区間の一部が保持範囲外へ押し出されていれば測れないとして残り、区間全体が保持範囲内で無音なら捨てられる")
    func keepsResultsWhenPartOfSpanIsReleasedFromRetention() async throws {
        let origin = AudioGetCurrentHostTime()
        // 0-40 秒が声の大きさ、40-70 秒が無音（保持範囲は 30 秒なので、70 秒時点で 0-40 秒は保持範囲外）。
        let audio = audioStream(firstHostTime: origin, segments: [(loudValue, 40), (silentValue, 30)])
        let partiallyReleased = TranscriptionResult(text: "あ", isFinal: true, start: 39.5, end: 41.0)
        let fullyRetained = TranscriptionResult(text: "え", isFinal: true, start: 41.0, end: 43.0)
        let base = FakeTranscriber(results: [partiallyReleased, fullyRetained])
        let filtering = SilenceFilteringTranscriber(wrapping: base)
        try await filtering.prepare()

        let results = try await collectResults(try await filtering.transcribe(audio, origin: origin))

        #expect(results == [partiallyReleased])
    }

}
