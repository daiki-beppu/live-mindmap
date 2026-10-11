import Speech
import Testing
@testable import HelperCore

private struct InstallationFailure: Error, CustomStringConvertible {
    var description: String { "合成の取得失敗" }
}

@Suite("日本語モデルの予約と取得")
struct SpeechJaInstallationTests {
    @Test("710-3: install-speech-ja は引数なしを受理する")
    func noArguments() throws {
        _ = try parseInstallSpeechJaArguments([]).get()
    }

    @Test("710-3: install-speech-ja の不明な引数は拒否する")
    func unknownArguments() {
        #expect(throws: (any Error).self) {
            _ = try parseInstallSpeechJaArguments(["--unknown"]).get()
        }
    }

    @Test("710-3: request nil は予約を確認して正常終了する")
    func alreadyInstalled() async throws {
        var requests = 0
        try await installSpeechJa(
            speechStatus: { AssetInventory.Status.installed },
            installationRequest: { requests += 1; return nil }
        )
        #expect(requests == 1)
    }

    @Test("710-3: supported は予約・取得を行う")
    func reservationIsRequired() async throws {
        var downloads = 0
        try await installSpeechJa(
            speechStatus: { AssetInventory.Status.supported },
            installationRequest: { { downloads += 1 } }
        )
        #expect(downloads == 1)
    }

    @Test("710-3: 非対応は取得せず、理由を返して exit 1 になる")
    func unsupported() async {
        var requests = 0
        do {
            try await installSpeechJa(
                speechStatus: { AssetInventory.Status.unsupported },
                installationRequest: { requests += 1; return nil }
            )
            Issue.record("非対応の日本語モデルの導入が成功しました")
        } catch {
            #expect(!String(describing: error).isEmpty)
            #expect(exitCode(for: error) == 1)
        }
        #expect(requests == 0)
    }

    @Test("710-3: 予約取得失敗の理由を保持して exit 1 になる")
    func requestFailure() async {
        do {
            try await installSpeechJa(
                speechStatus: { AssetInventory.Status.supported },
                installationRequest: { throw InstallationFailure() }
            )
            Issue.record("予約取得の失敗が成功になりました")
        } catch {
            #expect(String(describing: error).contains("合成の取得失敗"))
            #expect(exitCode(for: error) == 1)
        }
    }

    @Test("710-3: 取得処理を呼び、その失敗を保持して exit 1 になる")
    func downloadFailure() async {
        var downloads = 0
        do {
            try await installSpeechJa(
                speechStatus: { AssetInventory.Status.supported },
                installationRequest: { { await Task.yield(); downloads += 1; throw InstallationFailure() } }
            )
            Issue.record("取得失敗が成功になりました")
        } catch {
            #expect(String(describing: error).contains("合成の取得失敗"))
            #expect(exitCode(for: error) == 1)
        }
        #expect(downloads == 1)
    }

    @Test("710-3: 取得処理が戻る前に導入処理を完了しない")
    func waitsForDownload() async throws {
        let events = AsyncStream<String>.makeStream()
        let release = AsyncStream<Void>.makeStream()
        let task = Task {
            defer {
                events.continuation.yield("returned")
                events.continuation.finish()
            }
            try await installSpeechJa(
                speechStatus: { AssetInventory.Status.supported },
                installationRequest: { {
                    events.continuation.yield("download")
                    for await _ in release.stream { break }
                    events.continuation.yield("download-complete")
                } }
            )
        }
        defer {
            release.continuation.finish()
            events.continuation.finish()
            task.cancel()
        }
        var iterator = events.stream.makeAsyncIterator()
        let started = await iterator.next()
        try #require(started == "download")
        release.continuation.yield(())
        let completed = await iterator.next()
        try #require(completed == "download-complete")
        #expect(await iterator.next() == "returned")
        try await task.value
    }
}
