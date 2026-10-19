import Foundation
import Testing
@testable import HelperCore

// 録画のファイルの音声だけを m4a に書く（exportFileAudio）の IT。ファイルはテストの中で作った合成のもの。
// 確かめること: WAV からも映像つきの mov からも音声だけの m4a ができる / 音声の先頭が 0 秒にそろう / 出力が既にあれば上書きせず失敗する。

private typealias Support = FileAudioTestSupport

@Suite("録画のファイルから音声を書く（exportFileAudio）", .timeLimit(.minutes(1)))
struct FileAudioExportITTests {

    @Test("出力が既にあると失敗し、既にあるファイルは変わらない")
    func existingOutputFails() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let input = dir.appendingPathComponent("meeting.wav")
        try Support.writeWAV(input, loudSeconds: 1, silentSeconds: 1)
        let output = dir.appendingPathComponent("相手.m4a")
        try Data("既にある".utf8).write(to: output)

        await #expect(throws: (any Error).self) {
            try await exportFileAudio(from: input, to: output)
        }
        #expect(try Data(contentsOf: output) == Data("既にある".utf8))
    }

    @Test("読めない入力は失敗し、出力は残らない")
    func unreadableInputFails() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let input = dir.appendingPathComponent("broken.m4a")
        try Data("音声ではない".utf8).write(to: input)
        let output = dir.appendingPathComponent("相手.m4a")

        await #expect(throws: (any Error).self) {
            try await exportFileAudio(from: input, to: output)
        }
        #expect(!FileManager.default.fileExists(atPath: output.path))
    }


    @Test("自分用が無いとき（--self なし）は、相手.m4a だけを書き、自分.m4a は作らない")
    func exportsOnlyTheirsWithoutSelfFile() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(theirs, loudSeconds: 1, silentSeconds: 1)
        let session = dir.appendingPathComponent("session", isDirectory: true)
        try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true)

        try await exportFileAudioTracks(theirs: theirs, mine: nil, into: session)

        #expect(try FileManager.default.contentsOfDirectory(atPath: session.path) == ["相手.m4a"])
    }

    @Test("自分用が読めないときは失敗する（相手.m4a だけが残ったまま成功扱いにならない）")
    func unreadableSelfFileFails() async throws {
        let dir = try Support.temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = dir.appendingPathComponent("them.wav")
        try Support.writeWAV(theirs, loudSeconds: 1, silentSeconds: 1)
        let broken = dir.appendingPathComponent("me.m4a")
        try Data("音声ではない".utf8).write(to: broken)
        let session = dir.appendingPathComponent("session", isDirectory: true)
        try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true)

        await #expect(throws: (any Error).self) {
            try await exportFileAudioTracks(theirs: theirs, mine: broken, into: session)
        }
        #expect(!FileManager.default.fileExists(atPath: session.appendingPathComponent("自分.m4a").path))
    }
}
