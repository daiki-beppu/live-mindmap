import AVFoundation
import FluidAudio
import Foundation

/// FluidAudio の Sortformer（CoreML、`SortformerConfig.default` = `fastV2_1`）による話者分離。端末の中だけで動き、音声は Mac の外に出ない。
/// モデルは `fetch-speaker-models.sh`（`install-speaker-models`）が前もって `modelDirectory` に取得する。`prepare` は取得しない。
public final class SortformerSpeakerDiarizer: SpeakerDiarizer, @unchecked Sendable {
    private static let config = SortformerConfig.default
    private let modelDirectory: URL
    private var models: SortformerModels?
    /// 枠への混入の検出（Issue #1024）に使う WeSpeaker。読めなければ nil で、検出だけを止める（話者分離は続ける）。
    private var embedder: WeSpeakerEmbedder?

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
        // 混入の検出は補助の機能。WeSpeaker を読めなくても、話者分離（speaker-off も含めて）は止めない。
        let embedder = WeSpeakerEmbedder(modelDirectory: modelDirectory)
        do {
            try await embedder.prepare()
            self.embedder = embedder
        } catch {
            self.embedder = nil
            FileHandle.standardError.write(Data("話者の混入の検出を使わない（WeSpeaker を読めない）: \(error)\n".utf8))
        }
    }

    public func diarize(_ audio: AsyncThrowingStream<CapturedAudio, Error>, origin: UInt64) async throws -> AsyncThrowingStream<SpeakerDiarization, Error> {
        guard let models else { throw SpeakerDiarizerError.notPrepared }
        let diarizer = SortformerDiarizer(config: Self.config, timelineConfig: Self.timelineConfig)
        diarizer.initialize(models: models)
        let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(Self.config.sampleRate), channels: 1, interleaved: false)
        guard let target else { throw SpeakerDiarizerError.conversionFailed("16 kHz モノラルの形式を作れない") }
        let mixing = embedder.map { SlotMixTracker(embedder: $0) }
        return AsyncThrowingStream { continuation in
            let worker = Task.detached {
                var converter: AVAudioConverter?
                var shift: Double?
                var settledTo = -Double.infinity
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
                        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
                        mixing?.append(samples16k: samples)
                        diarizer.addAudio(samples)
                        if let update = try diarizer.process() {
                            Self.yield(update, shift: shift ?? 0, settledTo: &settledTo, finished: false, mixing: mixing, to: continuation)
                        }
                    }
                    // 上流が終わった。残りの仮の区間を確定させてから終える。
                    if let update = try diarizer.finalizeSession() {
                        Self.yield(update, shift: shift ?? 0, settledTo: &settledTo, finished: true, mixing: mixing, to: continuation)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in worker.cancel() }
        }
    }

    /// 確定した区間を先に、続けて仮の区間を流し、重心（変わった枠だけ）、混入の順に流し、最後に確定済みの位置を流す。`finished` は `finalizeSession()` の更新で、残りがすべて確定している。
    /// 重心と混入を確定済みの位置より先に流すのは、サーバーが確定済みの位置で保留の発言を出す前に、枠のつなぎ直しと戻した枠を知らせるため。
    static func yield(
        _ update: DiarizerTimelineUpdate, shift: Double, settledTo: inout Double, finished: Bool,
        mixing: SlotMixTracker? = nil,
        to continuation: AsyncThrowingStream<SpeakerDiarization, Error>.Continuation
    ) {
        let updated = segments(of: update, finished: finished)
        for segment in updated {
            continuation.yield(.segment(SpeakerSegment(
                start: segment.start + shift, end: segment.end + shift, slot: segment.slot, isFinal: segment.isFinal
            )))
        }
        if let result = mixing?.update(finalized: updated) {
            for item in result.centroids {
                continuation.yield(.centroid(slot: item.slot, centroid: item.centroid))
            }
            for mix in result.mixed {
                continuation.yield(.mixed(slot: mix.slot, at: mix.at + shift))
            }
        }
        let position = finished
            ? processedEnd(of: update, config: timelineConfig)
            : settledPosition(of: update, config: timelineConfig)
        settledTo = max(settledTo, position + shift)
        continuation.yield(.settled(to: settledTo))
        // 今後確定する区間の start は、この位置以上になる。それより前の音声は埋め込みに使わない。
        if !finished { mixing?.discard(before: position) }
    }

    /// 流す区間（シフト前）。確定した区間を先に、続けて仮の区間。`finished`（`finalizeSession()` の更新）では、
    /// 残りの仮の区間（終わりで閉じた区間）は FluidAudio がこの後 `finalize()` で確定させ、再び返さないので、確定として流す。
    static func segments(of update: DiarizerTimelineUpdate, finished: Bool) -> [SpeakerSegment] {
        [(update.finalizedSegments, true), (update.tentativeSegments, finished)].flatMap { segments, isFinal in
            segments.map { SpeakerSegment(start: Double($0.startTime), end: Double($0.endTime), slot: $0.speakerIndex, isFinal: isFinal) }
        }
    }

    static var timelineConfig: DiarizerTimelineConfig {
        // 区間は流すだけで読み返さないので、タイムラインに予測と区間の履歴を溜めない（会議の長さに比例して増えるのを防ぐ）。
        var config = DiarizerTimelineConfig.sortformerDefault
        config.maxStoredFrames = 0
        config.storeSegments = false
        return config
    }

    /// この更新の後に確定する区間は、start がこの位置（`origin` ではなくタイムラインの 0 からの秒）以上になる。
    /// F は FluidAudio の `updateSegments` の `finalizedEndFrame`（確定済みの末尾から `minFramesOff` と前後の余白を引いた位置）と同じ式。
    /// これより前で始まる区間でも、閉じていないものと確定待ちのものは仮の区間として出るので、その start の最小値 T より先へは進めない。
    static func settledPosition(of update: DiarizerTimelineUpdate, config: DiarizerTimelineConfig) -> Double {
        let result = update.chunkResult
        let frame = result.startFrame + result.finalizedFrameCount - config.minFramesOff - config.onsetPadFrames - config.offsetPadFrames
        let finalized = Double(Float(frame) * config.frameDurationSeconds)
        let tentative = update.tentativeSegments.map { Double($0.startTime) }.min() ?? .infinity
        return min(finalized, tentative)
    }

    /// `finalizeSession()` の後。処理した音声の終わり。残りの区間がすべて確定しているので、これより後に区間は来ない。
    static func processedEnd(of update: DiarizerTimelineUpdate, config: DiarizerTimelineConfig) -> Double {
        let result = update.chunkResult
        let frames = Double(Float(result.startFrame + result.finalizedFrameCount + result.tentativeFrameCount) * config.frameDurationSeconds)
        return max(frames, (update.finalizedSegments + update.tentativeSegments).map { Double($0.endTime) }.max() ?? -.infinity)
    }

    /// モデルの本体（`.mlmodelc`）の場所。FluidAudio の保存の規則（`<保存先>/<repo のフォルダ>/<bundle>`）と同じ。
    static func modelURL(in directory: URL) -> URL {
        let bundle = ModelNames.Sortformer.bundle(for: config) ?? ModelNames.Sortformer.defaultBundle
        return directory.appendingPathComponent(Repo.sortformer.folderName).appendingPathComponent(bundle)
    }
}

/// 取得するスクリプトと `run` が共有する保存先。開発時は利用者のモデルから隔離できる。
public var defaultSpeakerModelDirectory: URL {
    resolveSpeakerModelDirectory(environment: ProcessInfo.processInfo.environment)
}

func resolveSpeakerModelDirectory(environment: [String: String]) -> URL {
    if let path = environment["LIVE_MINDMAP_HELPER_SPEAKER_MODEL_DIR"], !path.isEmpty {
        return URL(fileURLWithPath: path, isDirectory: true)
    }
    return FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("FluidAudio/Models", isDirectory: true)
}
