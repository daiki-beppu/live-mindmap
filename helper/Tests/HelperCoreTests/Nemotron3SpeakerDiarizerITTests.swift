import FluidAudio
import Foundation
import Testing
@testable import HelperCore

@Suite("Nemotron3SpeakerDiarizer のモデルの有無", .timeLimit(.minutes(1)))
struct Nemotron3SpeakerDiarizerITTests {
    @Test("古い重みの印はセッション中にキャッシュを消さずに拒否する")
    func staleWeightsAreRejectedWithoutDeletingCache() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("nemotron3-stale-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let bundle = Nemotron3SpeakerDiarizer.modelURL(in: directory)
        try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
        let repository = directory.appendingPathComponent(Repo.nemotron3Diarization.folderName)
        try Data().write(to: bundle.appendingPathComponent("coremldata.bin"))
        try Data().write(to: repository.appendingPathComponent(ModelNames.Nemotron3.silenceEmbeddingFile))
        let version = repository.appendingPathComponent(ModelNames.Nemotron3.weightsVersionFile)
        try Data("old-weights".utf8).write(to: version)

        do {
            try await Nemotron3SpeakerDiarizer(modelDirectory: directory).prepare()
            Issue.record("古い重みが受理された")
        } catch let error as SpeakerDiarizerError {
            guard case .modelMissing = error else { Issue.record("想定外の分類: \(error)"); return }
        }
        #expect(FileManager.default.fileExists(atPath: bundle.path))
        #expect(try String(contentsOf: version, encoding: .utf8) == "old-weights")
    }

    @Test("モデルのフォルダが無ければ、ネットワークへ行かずに modelMissing で prepare が失敗する")
    func missingModelFailsWithModelMissing() async {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("nemotron3-missing-\(UUID().uuidString)", isDirectory: true)
        let diarizer = Nemotron3SpeakerDiarizer(modelDirectory: directory)
        do {
            try await diarizer.prepare()
            Issue.record("モデルが無いのに prepare が成功しました")
        } catch let error as SpeakerDiarizerError {
            guard case .modelMissing = error else {
                Issue.record("modelMissing ではありません: \(error)")
                return
            }
        } catch {
            Issue.record("modelMissing ではないエラーです: \(error)")
        }
        #expect(!FileManager.default.fileExists(atPath: directory.path))
    }

    @Test("空のフォルダ（モデルのファイルが無い）も modelMissing")
    func emptyDirectoryFailsWithModelMissing() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("nemotron3-empty-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let diarizer = Nemotron3SpeakerDiarizer(modelDirectory: directory)
        do {
            try await diarizer.prepare()
            Issue.record("モデルが無いのに prepare が成功しました")
        } catch let error as SpeakerDiarizerError {
            guard case .modelMissing = error else {
                Issue.record("modelMissing ではありません: \(error)")
                return
            }
        } catch {
            Issue.record("modelMissing ではないエラーです: \(error)")
        }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }

    @Test("取得の途中で止まった状態（モデルのフォルダはあるが完了の印が無い）は導入済みと判断せず、印があれば導入済み")
    func partialDownloadIsNotInstalled() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("nemotron3-partial-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let bundle = Nemotron3SpeakerDiarizer.modelURL(in: directory)
        try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
        #expect(!speakerModelsInstalled(in: directory))
        try Data().write(to: speakerModelsInstalledMarker(in: directory))
        #expect(speakerModelsInstalled(in: directory))
    }
}
