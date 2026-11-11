import FluidAudio
import Foundation

public protocol SpeakerEmbedder: Sendable {
    func embed(_ samples16k: [Float]) throws -> [Float]
}

/// FluidAudio は埋め込みのマスクの長さを segmentation モデルの出力から決めるので、segmentation モデル（pyannote）も一緒に読む。
public final class WeSpeakerEmbedder: SpeakerEmbedder, @unchecked Sendable {
    private let modelDirectory: URL
    private var manager: DiarizerManager?

    public init(modelDirectory: URL = defaultSpeakerModelDirectory) {
        self.modelDirectory = modelDirectory
    }

    public func prepare() async throws {
        let segmentation = Self.segmentationURL(in: modelDirectory)
        let embedding = Self.embeddingURL(in: modelDirectory)
        for model in [segmentation, embedding] where !FileManager.default.fileExists(atPath: model.path) {
            throw SpeakerDiarizerError.modelMissing(model)
        }
        // 読み込みの途中で壊れたキャッシュを見つけても、FluidAudio が取り直さないようにする（会議中に取りに行かない）。
        ModelHub.offlineMode = true
        let models = try DiarizerModels.load(localSegmentationModel: segmentation, localEmbeddingModel: embedding)
        let manager = DiarizerManager()
        manager.initialize(models: models)
        self.manager = manager
    }

    public func embed(_ samples16k: [Float]) throws -> [Float] {
        guard let manager else { throw SpeakerDiarizerError.notPrepared }
        return try manager.extractSpeakerEmbedding(from: samples16k)
    }

    static func folder(in directory: URL) -> URL {
        directory.appendingPathComponent(Repo.diarizer.folderName, isDirectory: true)
    }

    static func segmentationURL(in directory: URL) -> URL {
        folder(in: directory).appendingPathComponent(ModelNames.Diarizer.segmentationFile)
    }

    static func embeddingURL(in directory: URL) -> URL {
        folder(in: directory).appendingPathComponent(ModelNames.Diarizer.embeddingFile)
    }
}
