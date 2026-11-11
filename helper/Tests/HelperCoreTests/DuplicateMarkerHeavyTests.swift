import Testing
import HelperCore

@Suite("確定結果の消費はマーカーごとに一度だけ", .timeLimit(.minutes(2)))
struct DuplicateMarkerHeavyTests {
    @Test("消費が終了した後でも、二度目の消費は拒否する")
    func rejectsSecondConsumerAfterCompletion() async {
        await #expect(processExitsWith: .failure) {
            let marker = DuplicateMarker()
            await marker.endMineFinals()
            await marker.resolveHeldFinals()

            await marker.resolveHeldFinals()
        }
    }

    @Test("最初の消費が確定結果の判定を待っている間も、二度目の消費は拒否する")
    func rejectsSecondConsumerWhileResolving() async {
        await #expect(processExitsWith: .failure) {
            let (entered, enteredContinuation) = AsyncStream.makeStream(of: Void.self)
            let (release, releaseContinuation) = AsyncStream.makeStream(of: Void.self)
            defer { releaseContinuation.finish(); enteredContinuation.finish() }
            let marker = DuplicateMarker(sleep: { _ in
                enteredContinuation.yield()
                for await _ in release {}
            })
            await marker.hold(mineFinal: TranscriptionResult(text: "明日の会議", isFinal: true, start: 0, end: 2))
            await marker.endMineFinals()
            let first = Task { await marker.resolveHeldFinals() }
            defer { first.cancel() }
            await DuplicateMarkerTestSupport.awaitSignal(entered)

            await marker.resolveHeldFinals()
        }
    }
}
