import Foundation
import Testing
@testable import HelperCore

// 録画のファイルに記録された作成日時の読み取り（fileCreationDate）の IT。
// 確かめること: 作成日時のメタデータを持つファイルではその日時、持たないファイルと読めないファイルでは nil。

private typealias Support = FileAudioTestSupport

@Suite("ファイルの作成日時（fileCreationDate）", .timeLimit(.minutes(1)))
struct FileCreationDateITTests {
    @Test("作成日時のメタデータを持つ mov は、その日時を返す（+09:00 の 10:02:03 は UTC の 01:02:03）")
    func readsEmbeddedDate() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("source.wav")
        try Support.writeWAV(wav, loudSeconds: 1, silentSeconds: 1)
        let movie = dir.appendingPathComponent("meeting.mov")
        try await Support.writeMovie(movie, audio: wav, videoSeconds: 2, creationDate: "2026-10-01T10:02:03+0900")

        let date = await fileCreationDate(of: movie)

        #expect(date == Date(timeIntervalSince1970: 1_790_816_523)) // 2026-10-01T01:02:03Z
    }

    @Test("作成日時のメタデータを持たない WAV は nil（ファイルシステムの日時で代用しない）")
    func noMetadataIsNil() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let wav = dir.appendingPathComponent("meeting.wav")
        try Support.writeWAV(wav, loudSeconds: 1, silentSeconds: 1)

        #expect(await fileCreationDate(of: wav) == nil)
    }

    @Test("読めないファイルと存在しないファイルは nil")
    func unreadableIsNil() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let broken = dir.appendingPathComponent("broken.m4a")
        try Data("音声ではない".utf8).write(to: broken)

        #expect(await fileCreationDate(of: broken) == nil)
        #expect(await fileCreationDate(of: dir.appendingPathComponent("absent.m4a")) == nil)
    }
}
