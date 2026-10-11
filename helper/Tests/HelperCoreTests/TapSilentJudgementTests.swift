import Foundation
import Testing
import HelperCore

private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    var judgement: TapSilentJudgement?

    func record(_ event: String) {
        lock.lock()
        recorded.append(event)
        lock.unlock()
    }

    var events: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }
}

@Suite("タップの無音判定")
struct TapSilentJudgementTests {
    private func makeJudgement(
        _ recorder: Recorder, received: Bool, stopDuringSleep: Bool = false
    ) -> TapSilentJudgement {
        let judgement = TapSilentJudgement(
            sleep: { [recorder] duration in
                recorder.record("sleep:\(duration)")
                if stopDuringSleep { recorder.judgement?.stop() }
            },
            hasReceivedFrames: { received },
            currentLine: { [recorder] in
                recorder.record("read")
                return "line-1"
            },
            emit: { [recorder] line in recorder.record("emit:\(line)") }
        )
        recorder.judgement = judgement
        return judgement
    }

    @Test("フレームが未到着なら、待った後に読み直した値の行を 1 回だけ出す")
    func emitsOnceWhenSilent() async {
        let recorder = Recorder()
        let judgement = makeJudgement(recorder, received: false)
        await judgement.start()?.value
        #expect(recorder.events == ["sleep:\(tapSilentJudgementDelay)", "read", "emit:line-1"])
    }

    @Test("フレームが届いていれば、読み直しも出力もしない")
    func silentWhenFramesReceived() async {
        let recorder = Recorder()
        let judgement = makeJudgement(recorder, received: true)
        await judgement.start()?.value
        #expect(recorder.events == ["sleep:\(tapSilentJudgementDelay)"])
    }

    @Test("待機中に停止したら出さない")
    func stopDuringSleep() async {
        let recorder = Recorder()
        let judgement = makeJudgement(recorder, received: false, stopDuringSleep: true)
        await judgement.start()?.value
        #expect(!recorder.events.contains("emit:line-1"))
        #expect(!recorder.events.contains("read"))
    }

    @Test("停止の後に開始したら、タスクを作らず何も出さない")
    func startAfterStop() async {
        let recorder = Recorder()
        let judgement = makeJudgement(recorder, received: false)
        judgement.stop()
        judgement.stop()
        #expect(judgement.start() == nil)
        #expect(recorder.events.isEmpty)
    }
}
