import AVFoundation
import Foundation

// 音声認識が完全な無音から文字を作ることがある（Issue #144）。認識結果の区間（start〜end）に STT へ渡した音
// （AEC の後）の音量がしきい値未満なら、その結果（途中結果・確定とも）をヘルパーから送らない。判定は区間の音量だけで行い、
// 文の中身（テキストの長さ・語彙）では判定しない。

/// ほぼ無音と判定するしきい値（dBFS, RMS）。人の声は小声でもこれより大きくなる。
let silenceThresholdDBFS: Double = -70

/// `silenceThresholdDBFS` を二乗平均の値に変換したもの（dBFS = 10 * log10(二乗平均) の逆算）。比較はこの値 1 つで行う。
private let silenceThresholdMeanSquare = pow(10, silenceThresholdDBFS / 10)

/// 音量の記録を保持する長さ（秒）。`isBelowSilenceThreshold` は区間 `[start, end)` に入るフレームだけを集計し、
/// 窓への集約は行わない（区間境界を窓内で切れないために区間内外のサンプルが混入／脱落する問題を避けるため）。
/// この秒数は取得・保持するフレーム数というメモリ量の上限であり、判定の粒度には関係しない。STT の結果到着遅延の
/// 上限はコード上に存在しない（`Duplicates.swift` の `duplicateWindow` / `duplicateHoldLimit` の 8 秒は `相手`
/// との重複マッチング窓と `自分` 確定の保留上限であり、結果到着遅延を制限しない）ため、保持範囲外へ押し出された
/// 区間は要件どおり「測れない区間」として残す（捨てない）。
/// 保持量は `loudnessRetentionSeconds × サンプルレート × 4 バイト`（フレームごとの二乗平均を `Float` で保持する
/// ため）。48 kHz で 1 トラックあたり約 5.76 MB、2 トラックで約 11.52 MB。会議の継続時間に比例せず、最初の
/// バッファで 1 回確保して以後増やさない。
private let loudnessRetentionSeconds = 30.0

/// 下流（`base.transcribe`）へ渡す未消費のバッファの上限。ProcessTap と同じ。
private let measuredAudioBacklogLimit = 2048

/// 1 トラック分の、フレームごとの音量の記録。最初に記録したバッファの取得時刻とサンプルレートを基準に、
/// フレームの絶対位置ごとに二乗平均（全チャンネルの二乗の平均）を固定長の循環配列へ書く。保持するのは直近
/// `loudnessRetentionSeconds` 秒分のフレームだけで、それより古いフレームは新しい記録で上書きして解放する
/// （会議の継続時間に比例して保持量が増えないようにするため）。サンプルレートは 1 つの流れの途中で変わらない
/// 前提（`ProcessTap.swift` のタップ、`Microphone.swift` の入力ノードはいずれも形式を開始時に 1 回だけ決め、
/// AEC 出力は `EchoCancellation.swift` の 48 kHz モノラル固定）で、到達可能な入口がすべて同じレートを保証する
/// ため、レート変化の内部ガードは置かない。音声を記録する側（`record`）と、区間の音量を調べる側
/// （`isBelowSilenceThreshold`）が別の Task から呼ぶため、`TrackTimeline`（Timeline.swift）と同じくロックで守る。
final class TrackLoudness: @unchecked Sendable {
    private let origin: UInt64
    private let lock = NSLock()
    private var basis: Double?
    private var sampleRate: Double = 0
    /// フレームの絶対位置を `energies.count` で循環させた固定長配列。各要素はその位置のフレームの二乗平均
    /// （全チャンネルの二乗の平均）。`.nan` は「測れない」印（Float32 以外の形式・チャンネル数 0 だった、
    /// または保持範囲外へ押し出されてから一度も上書きされていない）。
    private var energies: [Float] = []
    /// 記録済みの絶対フレーム数（次に書き込む位置）。0 から単調に増える。
    private var recordedFrames = 0

    init(origin: UInt64) {
        self.origin = origin
    }

    /// `audio` を記録する。フレーム数が 0 のバッファやサンプルレートが 0 以下のバッファには何もしない。
    /// Float32 以外の形式（チャンネルデータを取れない）やチャンネル数 0 のバッファは、そのフレーム範囲に
    /// `Float.nan`（測れない印）を書き、記録済みフレーム数は進める（音声自体は存在したので、無音として
    /// 捨てない）。
    func record(_ audio: CapturedAudio) {
        let buffer = audio.buffer
        let format = buffer.format
        let frames = Int(buffer.frameLength)
        let sampleRate = format.sampleRate
        guard frames > 0, sampleRate > 0 else { return }

        lock.lock()
        defer { lock.unlock() }
        if basis == nil {
            basis = offsetSeconds(from: origin, to: audio.hostTime)
            self.sampleRate = sampleRate
            energies = Array(repeating: .nan, count: Int((loudnessRetentionSeconds * sampleRate).rounded()))
        }

        guard format.commonFormat == .pcmFormatFloat32, let channelData = buffer.floatChannelData else {
            writeUnmeasurable(frames: frames)
            return
        }
        let channels = Int(format.channelCount)
        guard channels > 0 else {
            writeUnmeasurable(frames: frames)
            return
        }
        // 左右を平均すると逆相の信号が 0 になり、音があるのに無音と判定し得るため、モノラル化せず全チャンネルの
        // 全サンプルの二乗平均で測る。interleaved な形式（`相手` の ProcessTap の 2ch 出力）はチャンネルが
        // channelData[0] に交互に並ぶだけで、channelData[1] 以降は存在しない（EchoCancellation.swift の
        // EchoInputConverter と同じ前提）。
        let interleaved = format.isInterleaved
        for frame in 0..<frames {
            var sumOfSquares = 0.0
            for channel in 0..<channels {
                let sample = interleaved
                    ? Double(channelData[0][frame * channels + channel])
                    : Double(channelData[channel][frame])
                sumOfSquares += sample * sample
            }
            let meanSquare = sumOfSquares / Double(channels)
            energies[(recordedFrames + frame) % energies.count] = Float(meanSquare)
        }
        recordedFrames += frames
    }

    /// 測れないフレーム範囲を記録する。呼び出し元でロック済みの前提。`.nan` は `isBelowSilenceThreshold` で
    /// 「測れない」として扱われ、捨てられない（測れない区間の結果は捨てない）。
    private func writeUnmeasurable(frames: Int) {
        for frame in 0..<frames {
            energies[(recordedFrames + frame) % energies.count] = .nan
        }
        recordedFrames += frames
    }

    /// `[start, end)` の区間がほぼ無音（二乗平均がしきい値未満）か。`nil` は「測れない」（無音と混同しない）。
    /// `end` がまだ記録されていない時刻に及ぶ場合は、記録済み部分だけで判定する（その先の音声はまだ STT にも
    /// 渡っていないため）。区間の先頭が保持範囲より古い場合は `nil`（測れない。要件: 測れない区間の結果は
    /// 捨てない）。保持範囲内に測れないフレーム（`.nan`）が 1 つでもある場合も `nil`。記録が 1 つもない、
    /// 区間が記録と重ならない、区間の長さが 0 のいずれでも `nil`。
    func isBelowSilenceThreshold(start: Double, end: Double) -> Bool? {
        guard end > start else { return nil }

        lock.lock()
        defer { lock.unlock() }
        guard let basis, sampleRate > 0 else { return nil }

        let firstPosition = max(0, (start - basis) * sampleRate)
        let endPosition = min(Double(recordedFrames), (end - basis) * sampleRate)
        guard firstPosition < endPosition else { return nil }

        let firstFrame = Int(firstPosition.rounded(.up))
        let endFrame = Int(endPosition.rounded(.up))
        guard firstFrame < endFrame else { return nil }

        // 区間の先頭が保持範囲より古いと、その位置の `energies` は新しいフレームで上書きされており読めない。
        // 保持範囲外は測れない区間として `nil` を返す（要件: 測れない＝捨てない）。
        if firstFrame < recordedFrames - energies.count {
            return nil
        }

        var sum = 0.0
        for frame in firstFrame..<endFrame {
            let value = energies[frame % energies.count]
            guard !value.isNaN else { return nil }
            sum += Double(value)
        }
        return sum / Double(endFrame - firstFrame) < silenceThresholdMeanSquare
    }
}

/// `base` が返す認識結果のうち、区間（start〜end）の音量がほぼ無音のものを捨てる `Transcriber` の装飾（Issue #144）。
/// 音量は、その区間に `base` へ渡した音（AEC の後）だけで測る。文の中身では判定しない。
public final class SilenceFilteringTranscriber: Transcriber {
    private let base: any Transcriber

    public init(wrapping base: any Transcriber) {
        self.base = base
    }

    public func prepare() async throws {
        try await base.prepare()
    }

    public func transcribe(
        _ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64
    ) async throws -> AsyncThrowingStream<TranscriptionResult, Error> {
        let loudness = TrackLoudness(origin: origin)
        let measured = measuredStream(audio, loudness: loudness)
        let results = try await base.transcribe(measured, origin: origin)
        return filteredStream(results, loudness: loudness)
    }
}

/// 上流の音声を 1 つずつ音量に記録してから、そのまま下流（`base.transcribe`）へ流す。
/// `recordingStream`（Recording.swift）と同じ骨格: バッファリング上限、`.dropped` 時に `backlogExceeded` で終わらせる、
/// 上流のエラーをそのまま下流へ渡す。下流が先に終わったら、この Task をキャンセルして上流の読み取りを止める。
private func measuredStream(
    _ upstream: AsyncThrowingStream<CapturedAudio, Error>,
    loudness: TrackLoudness
) -> AsyncThrowingStream<CapturedAudio, Error> {
    let (stream, continuation) = AsyncThrowingStream.makeStream(
        of: CapturedAudio.self, throwing: Error.self, bufferingPolicy: .bufferingOldest(measuredAudioBacklogLimit))
    let task = Task {
        do {
            for try await captured in upstream {
                loudness.record(captured)
                // 満杯で入らなかったバッファは捨てずに、エラーで終わらせる（時刻の意味を保つため）。
                if case .dropped = continuation.yield(captured) {
                    throw TranscriberError.backlogExceeded(limit: measuredAudioBacklogLimit)
                }
            }
            continuation.finish()
        } catch {
            continuation.finish(throwing: error)
        }
    }
    continuation.onTermination = { _ in task.cancel() }
    return stream
}

/// `base` が返した結果の流れから、区間の音量がほぼ無音の結果だけを除いて流す。`base` のエラーはそのまま伝える。
/// 下流が先に終わったら、この Task をキャンセルして `base` の結果の読み取りを止める。
private func filteredStream(
    _ results: AsyncThrowingStream<TranscriptionResult, Error>,
    loudness: TrackLoudness
) -> AsyncThrowingStream<TranscriptionResult, Error> {
    let (stream, continuation) = AsyncThrowingStream.makeStream(of: TranscriptionResult.self, throwing: Error.self)
    let task = Task {
        do {
            for try await result in results {
                if isSilent(result, loudness: loudness) { continue }
                continuation.yield(result)
            }
            continuation.finish()
        } catch {
            continuation.finish(throwing: error)
        }
    }
    continuation.onTermination = { _ in task.cancel() }
    return stream
}

/// `result` の区間（start〜end）の音量がしきい値未満か。測れない区間（`nil`）は、ほぼ無音とみなさない
/// （測れない区間の結果は捨てない）。
private func isSilent(_ result: TranscriptionResult, loudness: TrackLoudness) -> Bool {
    loudness.isBelowSilenceThreshold(start: result.start, end: result.end) ?? false
}
