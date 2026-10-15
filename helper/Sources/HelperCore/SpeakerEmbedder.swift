import FluidAudio
import Foundation

/// 16 kHz モノラルの音声から、声の埋め込みを作る（Issue #1024）。配線側はこのプロトコルだけを知る
/// （本物は `WeSpeakerEmbedder`、unit テストは偽の実装を入れる）。
public protocol SpeakerEmbedder: Sendable {
    func embed(_ samples16k: [Float]) throws -> [Float]
}

/// FluidAudio 同梱の WeSpeaker（CoreML、256 次元、L2 正規化済み）による声の埋め込み。端末の中だけで動く。
/// モデルは `install-speaker-models`（`fetch-speaker-models.sh`）が Sortformer と同じ段で前もって取得する。`prepare` は取得しない。
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

    /// 取得先のフォルダ。FluidAudio の保存の規則（`<保存先>/<repo のフォルダ>/<モデル>`）と同じ。
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
