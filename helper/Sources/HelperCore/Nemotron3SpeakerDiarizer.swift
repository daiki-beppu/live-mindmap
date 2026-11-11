import AVFoundation
import FluidAudio
import Foundation

public final class Nemotron3SpeakerDiarizer: SpeakerDiarizer, @unchecked Sendable {
    private static let config = Nemotron3Config.fast32
    private let modelDirectory: URL
    private var models: Nemotron3Models?
    private var embedder: WeSpeakerEmbedder?

    public init(modelDirectory: URL = defaultSpeakerModelDirectory) {
        self.modelDirectory = modelDirectory
    }

    public func prepare() async throws {
        let bundle = Self.modelURL(in: modelDirectory)
        guard FileManager.default.fileExists(atPath: bundle.path) else {
            throw SpeakerDiarizerError.modelMissing(bundle)
        }
        let repository = modelDirectory.appendingPathComponent(Repo.nemotron3Diarization.folderName)
        let version = repository.appendingPathComponent(ModelNames.Nemotron3.weightsVersionFile)
        for asset in [bundle.appendingPathComponent("coremldata.bin"), repository.appendingPathComponent(ModelNames.Nemotron3.silenceEmbeddingFile), version] {
            guard FileManager.default.fileExists(atPath: asset.path) else { throw SpeakerDiarizerError.modelMissing(asset) }
        }
        // SDK は古いキャッシュを offlineMode でも消すので、セッション中はローダーへ渡す前に拒否する。
        guard try String(contentsOf: version, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) == ModelNames.Nemotron3.weightsVersion else {
            throw SpeakerDiarizerError.modelMissing(version)
        }
        // 読み込みの途中で壊れたキャッシュを見つけても、FluidAudio がキャッシュを消して取り直さないようにする（会議中に取りに行かない）。
        ModelHub.offlineMode = true
        models = try await Nemotron3Models.loadFromHuggingFace(config: Self.config, cacheDirectory: modelDirectory)
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
        let diarizer = Nemotron3Diarizer(config: Self.config, models: models)
        let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(Self.config.sampleRate), channels: 1, interleaved: false)
        guard let target else { throw SpeakerDiarizerError.conversionFailed("16 kHz モノラルの形式を作れない") }
        let mixing = embedder.map { SlotMixTracker(embedder: $0) }
        return AsyncThrowingStream { continuation in
            let worker = Task.detached {
                var converter: AVAudioConverter?
                var shift: Double?
                var timeline = SpeakerSegmentTimeline()
                do {
                    for try await captured in audio {
                        let buffer = captured.buffer
                        if shift == nil { shift = offsetSeconds(from: origin, to: captured.hostTime) }
                        if converter == nil { converter = AVAudioConverter(from: buffer.format, to: target) }
                        guard let converter else {
                            throw SpeakerDiarizerError.conversionFailed("\(buffer.format) → \(target)")
                        }
                        let converted = try SpeechAnalyzerTranscriber.convert(buffer, with: converter, to: target)
                        guard let channel = converted.floatChannelData?[0] else { continue }
                        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
                        mixing?.append(samples16k: samples)
                        diarizer.appendAudio(samples)
                        for chunk in try diarizer.processBufferedAudio() {
                            let update = timeline.append(probabilities: chunk.probabilities, frameCount: chunk.frameCount)
                            Self.yield(update, shift: shift ?? 0, mixing: mixing, to: continuation)
                        }
                    }
                    for chunk in try diarizer.finishStream() {
                        let update = timeline.append(probabilities: chunk.probabilities, frameCount: chunk.frameCount)
                        Self.yield(update, shift: shift ?? 0, mixing: mixing, to: continuation)
                    }
                    if let shift {
                        Self.yield(timeline.finish(), shift: shift, mixing: mixing, to: continuation)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in worker.cancel() }
        }
    }

    static func yield(
        _ update: SpeakerSegmentUpdate, shift: Double, mixing: SlotMixTracker? = nil,
        to continuation: AsyncThrowingStream<SpeakerDiarization, Error>.Continuation
    ) {
        let updated = update.segments
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
        continuation.yield(.settled(to: update.settled + shift))
        mixing?.discard(before: update.settled)
    }

    static func modelURL(in directory: URL) -> URL {
        directory.appendingPathComponent(Repo.nemotron3Diarization.folderName)
            .appendingPathComponent(config.hubSubdirectory)
            .appendingPathComponent(config.modelFileName)
    }

}

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
