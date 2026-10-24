import Foundation
import Testing
@testable import HelperCore

private struct DownloadFailure: Error, CustomStringConvertible {
    var description: String { "合成の取得失敗" }
}

@Suite("話者分離モデルの取得")
struct SpeakerModelInstallationTests {
    @Test("保存先の環境変数があれば、そのディレクトリを使う")
    func modelDirectoryOverride() {
        let path = "/isolated speaker models/話者分離"

        let directory = resolveSpeakerModelDirectory(environment: [
            "LIVE_MINDMAP_HELPER_SPEAKER_MODEL_DIR": path,
        ])

        #expect(directory == URL(fileURLWithPath: path, isDirectory: true))
    }

    @Test("保存先の環境変数がなければ、Foundation の既定の保存先を使う")
    func modelDirectoryDefault() {
        let expected = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FluidAudio/Models", isDirectory: true)

        let directory = resolveSpeakerModelDirectory(environment: [:])

        #expect(directory == expected)
    }

    @Test("install-speaker-models は引数なしを受理する")
    func noArguments() throws {
        _ = try parseInstallSpeakerModelsArguments([]).get()
    }

    @Test("install-speaker-models の不明な引数は拒否する")
    func unknownArguments() {
        #expect(throws: (any Error).self) {
            _ = try parseInstallSpeakerModelsArguments(["--unknown"]).get()
        }
    }

    @Test("入っていなければ取得を 1 回呼ぶ")
    func downloadsWhenMissing() async throws {
        var downloads = 0
        try await installSpeakerModels(isInstalled: { false }, download: { downloads += 1 })
        #expect(downloads == 1)
    }

    @Test("入っていれば何もしない（2 回目は取得しない）")
    func doesNothingWhenInstalled() async throws {
        var downloads = 0
        try await installSpeakerModels(isInstalled: { true }, download: { downloads += 1 })
        #expect(downloads == 0)
    }

    @Test("1 回目の取得の後は入っている状態になり、続けて呼んだ 2 回目は取得しない")
    func secondRunIsNoOp() async throws {
        var installed = false
        var downloads = 0
        for _ in 0..<2 {
            try await installSpeakerModels(isInstalled: { installed }, download: { downloads += 1; installed = true })
        }
        #expect(downloads == 1)
    }

    @Test("取得の失敗は理由を保ち、exit 1 になる")
    func downloadFailure() async {
        do {
            try await installSpeakerModels(isInstalled: { false }, download: { throw DownloadFailure() })
            Issue.record("取得失敗が成功になりました")
        } catch {
            #expect(String(describing: error).contains("合成の取得失敗"))
            #expect(exitCode(for: error) == 1)
        }
    }
}
