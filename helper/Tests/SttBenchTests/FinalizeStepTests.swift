import Testing
@testable import stt_bench

// watchdog の 1 回分の処理。偽の finalize を渡すので SpeechAnalyzer は使わない。

private struct FakeFinalizeError: Error {}

@Suite("finalize の watchdog")
struct FinalizeStepTests {
    @Test("成功した位置は処理済みになり、次の周期では何もしない")
    func successMarksFinalized() async {
        let progress = ResultProgress()
        progress.record(volatileEnd: 3.0)
        let first = await finalizeStep(progress: progress, quiet: 0) { _ in }
        let second = await finalizeStep(progress: progress, quiet: 0) { _ in }
        #expect(first == .finalized(through: 3.0))
        #expect(second == .idle)
    }

    @Test("失敗した位置は処理済みにならず、次の周期でも同じ位置を試す")
    func failureKeepsPosition() async {
        let progress = ResultProgress()
        progress.record(volatileEnd: 3.0)
        let first = await finalizeStep(progress: progress, quiet: 0) { _ in throw FakeFinalizeError() }
        let second = await finalizeStep(progress: progress, quiet: 0) { _ in }
        guard case let .failed(through, message) = first else {
            Issue.record("失敗が結果に残らない: \(first)")
            return
        }
        #expect(through == 3.0)
        #expect(!message.isEmpty)
        #expect(second == .finalized(through: 3.0))
    }
}
