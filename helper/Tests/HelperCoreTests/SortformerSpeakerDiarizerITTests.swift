import Foundation
import Testing
@testable import HelperCore

// 本物の SortformerSpeakerDiarizer を使うが、モデルは読まない（ファイルの有無の判定だけ）。モデルを使う検査は SortformerSpeakerDiarizerHeavyTests。

@Suite("SortformerSpeakerDiarizer のモデルの有無", .timeLimit(.minutes(1)))
struct SortformerSpeakerDiarizerITTests {
    @Test("モデルのフォルダが無ければ、ネットワークへ行かずに modelMissing で prepare が失敗する")
    func missingModelFailsWithModelMissing() async {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("sortformer-missing-\(UUID().uuidString)", isDirectory: true)
        let diarizer = SortformerSpeakerDiarizer(modelDirectory: directory)
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
        // 会議中に取りに行かない: prepare がフォルダを作ったり、何かを置いたりしない
        #expect(!FileManager.default.fileExists(atPath: directory.path))
    }

    @Test("空のフォルダ（モデルのファイルが無い）も modelMissing")
    func emptyDirectoryFailsWithModelMissing() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("sortformer-empty-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let diarizer = SortformerSpeakerDiarizer(modelDirectory: directory)
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
            .appendingPathComponent("sortformer-partial-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let bundle = SortformerSpeakerDiarizer.modelURL(in: directory)
        try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
        #expect(!speakerModelsInstalled(in: directory))
        try Data().write(to: speakerModelsInstalledMarker(in: directory))
        #expect(speakerModelsInstalled(in: directory))
    }
}
