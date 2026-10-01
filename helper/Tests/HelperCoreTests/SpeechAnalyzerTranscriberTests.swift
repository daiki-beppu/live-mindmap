import Testing
import HelperCore

// 本物の SpeechAnalyzer を使う。ja-JP のモデルがない・使えない環境では prepare() が失敗するので、その場合はテストも失敗する（環境の問題として報告する）。

@Suite("SpeechAnalyzerTranscriber の停止", .timeLimit(.minutes(1)))
struct SpeechAnalyzerTranscriberTests {
    private static let finishDeadline: Duration = .seconds(10)

    @Test("音声が一度も届かないまま入力が終わっても、結果の流れが一定時間内に、結果なしで正常に終わる")
    func finishesWithoutAnyAudio() async throws {
        let transcriber = SpeechAnalyzerTranscriber()
        try await transcriber.prepare()
        let audio = AsyncThrowingStream<CapturedAudio, Error> { $0.finish() }

        let results = try await transcriber.transcribe(audio, origin: 0)

        let outcome = await withTaskGroup(of: Int?.self) { group in
            group.addTask {
                var count = 0
                do {
                    for try await _ in results { count += 1 }
                } catch {
                    return nil
                }
                return count
            }
            group.addTask {
                try? await Task.sleep(for: Self.finishDeadline)
                return -1
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        #expect(outcome != -1, "音声が 0 件のとき、結果の流れが \(Self.finishDeadline) 以内に終わらなかった")
        #expect(outcome != nil, "音声が 0 件のとき、結果の流れがエラーで終わった")
        #expect(outcome == 0)
    }
}
