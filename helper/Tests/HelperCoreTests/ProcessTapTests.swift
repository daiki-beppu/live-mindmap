import Testing
import HelperCore

@Suite("プロセスタップの開始と停止", .timeLimit(.minutes(1)))
struct ProcessTapTests {
    @Test("start より前に stop が呼ばれたら、start は何も作らず、要素のない終わった流れを返す")
    func stopBeforeStartYieldsFinishedStream() async throws {
        let tap = ProcessTap(targets: [])
        tap.stop()
        let stream = try tap.start()
        var count = 0
        for try await _ in stream { count += 1 }
        #expect(count == 0)
    }

    @Test("stop は何度呼んでもよい")
    func stopIsIdempotent() {
        let tap = ProcessTap(targets: [])
        tap.stop()
        tap.stop()
    }
}
