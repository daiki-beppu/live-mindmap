import AVFoundation
import FluidAudio
import Foundation

/// FluidAudio の Sortformer（CoreML、`SortformerConfig.default` = `fastV2_1`）による話者分離。端末の中だけで動き、音声は Mac の外に出ない。
/// モデルは `fetch-speaker-models.sh`（`install-speaker-models`）が前もって `modelDirectory` に取得する。`prepare` は取得しない。
public final class SortformerSpeakerDiarizer: SpeakerDiarizer, @unchecked Sendable {
    private static let config = SortformerConfig.default
    private let modelDirectory: URL
    private var models: SortformerModels?

    public init(modelDirectory: URL = defaultSpeakerModelDirectory) {
        self.modelDirectory = modelDirectory
    }

    public func prepare() async throws {
        let bundle = Self.modelURL(in: modelDirectory)
        guard FileManager.default.fileExists(atPath: bundle.path) else {
            throw SpeakerDiarizerError.modelMissing(bundle)
        }
        // 読み込みの途中で壊れたキャッシュを見つけても、FluidAudio がキャッシュを消して取り直さないようにする（会議中に取りに行かない）。
        ModelHub.offlineMode = true
        models = try await SortformerModels.loadFromHuggingFace(config: Self.config, cacheDirectory: modelDirectory)
    }

    public func diarize(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerSegment, Error> {
        guard let models else { throw SpeakerDiarizerError.notPrepared }
        // 区間は流すだけで読み返さないので、タイムラインに予測と区間の履歴を溜めない（会議の長さに比例して増えるのを防ぐ）。
        var timelineConfig = DiarizerTimelineConfig.sortformerDefault
        timelineConfig.maxStoredFrames = 0
        timelineConfig.storeSegments = false
        let diarizer = SortformerDiarizer(config: Self.config, timelineConfig: timelineConfig)
        diarizer.initialize(models: models)
        let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(Self.config.sampleRate), channels: 1, interleaved: false)
        guard let target else { throw SpeakerDiarizerError.conversionFailed("16 kHz モノラルの形式を作れない") }
        return AsyncThrowingStream { continuation in
            let worker = Task.detached {
                var converter: AVAudioConverter?
                var shift: Double?
                do {
                    for try await captured in audio {
                        let buffer = captured.buffer
                        // 区間の時刻は 0 が最初のバッファ。最初のバッファの取得時刻と origin の差を 1 回だけ足す（TrackTimeline と同じ）。
                        if shift == nil { shift = offsetSeconds(from: origin, to: captured.hostTime) }
                        if converter == nil { converter = AVAudioConverter(from: buffer.format, to: target) }
                        guard let converter else {
                            throw SpeakerDiarizerError.conversionFailed("\(buffer.format) → \(target)")
                        }
                        let converted = try SpeechAnalyzerTranscriber.convert(buffer, with: converter, to: target)
                        guard let channel = converted.floatChannelData?[0] else { continue }
                        diarizer.addAudio(Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength))))
                        if let update = try diarizer.process() {
                            Self.yield(update, shift: shift ?? 0, to: continuation)
                        }
                    }
                    // 上流が終わった。残りの仮の区間を確定させてから終える。
                    if let update = try diarizer.finalizeSession() {
                        Self.yield(update, shift: shift ?? 0, to: continuation)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in worker.cancel() }
        }
    }

    /// 確定した区間を先に、続けて仮の区間を流す。
    private static func yield(
        _ update: DiarizerTimelineUpdate, shift: Double, to continuation: AsyncThrowingStream<SpeakerSegment, Error>.Continuation
    ) {
        for (segments, isFinal) in [(update.finalizedSegments, true), (update.tentativeSegments, false)] {
            for segment in segments {
                continuation.yield(SpeakerSegment(
                    start: Double(segment.startTime) + shift, end: Double(segment.endTime) + shift,
                    slot: segment.speakerIndex, isFinal: isFinal
                ))
            }
        }
    }

    /// モデルの本体（`.mlmodelc`）の場所。FluidAudio の保存の規則（`<保存先>/<repo のフォルダ>/<bundle>`）と同じ。
    static func modelURL(in directory: URL) -> URL {
        let bundle = ModelNames.Sortformer.bundle(for: config) ?? ModelNames.Sortformer.defaultBundle
        return directory.appendingPathComponent(Repo.sortformer.folderName).appendingPathComponent(bundle)
    }
}

/// FluidAudio の既定の保存先（`~/Library/Application Support/FluidAudio/Models`）。取得するスクリプトと `run` が同じ場所を見る。
public let defaultSpeakerModelDirectory: URL = FileManager.default
    .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("FluidAudio/Models", isDirectory: true)
