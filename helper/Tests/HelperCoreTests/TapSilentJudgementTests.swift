import AVFoundation
import Foundation
import Testing
@testable import HelperCore

private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    private var recordedEvents: [HelperEvent] = []
    var judgement: TapSilentJudgement?

    func record(_ event: String) {
        lock.lock()
        recorded.append(event)
        lock.unlock()
    }

    func recordEvent(_ event: HelperEvent) {
        lock.lock()
        recordedEvents.append(event)
        lock.unlock()
    }

    var helperEvents: [HelperEvent] {
        lock.lock()
        defer { lock.unlock() }
        return recordedEvents
    }

    var events: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }
}

private let origin: UInt64 = 1_000
private let judgedAt: UInt64 = 1_000 + 10_000_000_000

private func buffer(frames: AVAudioFrameCount, allZero: Bool) -> AVAudioPCMBuffer {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480)!
    buffer.frameLength = frames
    let data = buffer.floatChannelData![0]
    for i in 0..<480 { data[i] = allZero ? 0 : 0.5 }
    return buffer
}

@Suite("タップの無音判定")
struct TapSilentJudgementTests {
    private func makeJudgement(
        _ recorder: Recorder, received: Bool, stopDuringSleep: Bool = false
    ) -> TapSilentJudgement {
        makeJudgement(recorder, hasReceivedFrames: { received }, stopDuringSleep: stopDuringSleep)
    }

    private func makeJudgement(
        _ recorder: Recorder, hasReceivedFrames: @escaping @Sendable () -> Bool, stopDuringSleep: Bool = false
    ) -> TapSilentJudgement {
        let judgement = TapSilentJudgement(
            sleep: { [recorder] duration in
                recorder.record("sleep:\(duration)")
                if stopDuringSleep { recorder.judgement?.stop() }
            },
            hasReceivedFrames: hasReceivedFrames,
            currentLine: { [recorder] in
                recorder.record("read")
                return "line-1"
            },
            emit: { [recorder] line in recorder.record("emit:\(line)") },
            now: { judgedAt },
            emitEvent: { [recorder] event in recorder.recordEvent(event) }
        )
        recorder.judgement = judgement
        return judgement
    }

    @Test("フレームが未到着なら、待った後に読み直した値の行を 1 回だけ出す")
    func emitsOnceWhenSilent() async {
        let recorder = Recorder()
        let judgement = makeJudgement(recorder, received: false)
        await judgement.start(origin: origin)?.value
        #expect(recorder.events == ["sleep:\(tapSilentJudgementDelay)", "read", "emit:line-1"])
        #expect(recorder.helperEvents == [.tapSilent(start: offsetSeconds(from: origin, to: judgedAt))])
    }

    @Test("フレームが 0 のバッファしか届かない流れでも、10 秒後に tap-silent が 1 回出る")
    func emitsWhenOnlyEmptyBuffers() async {
        let recorder = Recorder()
        let empty = buffer(frames: 0, allZero: false)
        let judgement = makeJudgement(recorder, hasReceivedFrames: { bufferHasFrames(empty) })
        await judgement.start(origin: origin)?.value
        #expect(recorder.helperEvents == [.tapSilent(start: offsetSeconds(from: origin, to: judgedAt))])
    }

    @Test("フレーム数が 1 以上のバッファが届いていれば tap-silent を出さない")
    func noEventWhenBufferHasFrames() async {
        let recorder = Recorder()
        let received = buffer(frames: 480, allZero: false)
        let judgement = makeJudgement(recorder, hasReceivedFrames: { bufferHasFrames(received) })
        await judgement.start(origin: origin)?.value
        #expect(recorder.helperEvents.isEmpty)
        #expect(recorder.events == ["sleep:\(tapSilentJudgementDelay)"])
    }

    @Test("値がすべてゼロでもフレームがあれば無音とは判定せず、tap-silent を出さない")
    func noEventWhenAllZeroButHasFrames() async {
        let recorder = Recorder()
        let zeros = buffer(frames: 480, allZero: true)
        #expect(bufferHasFrames(zeros))
        let judgement = makeJudgement(recorder, hasReceivedFrames: { bufferHasFrames(zeros) })
        await judgement.start(origin: origin)?.value
        #expect(recorder.helperEvents.isEmpty)
    }

    @Test("フレームが届いていれば、読み直しも出力もしない")
    func silentWhenFramesReceived() async {
        let recorder = Recorder()
        let judgement = makeJudgement(recorder, received: true)
        await judgement.start(origin: origin)?.value
        #expect(recorder.events == ["sleep:\(tapSilentJudgementDelay)"])
    }

    @Test("待機中に停止したら出さない")
    func stopDuringSleep() async {
        let recorder = Recorder()
        let judgement = makeJudgement(recorder, received: false, stopDuringSleep: true)
        await judgement.start(origin: origin)?.value
        #expect(!recorder.events.contains("emit:line-1"))
        #expect(!recorder.events.contains("read"))
        #expect(recorder.helperEvents.isEmpty)
    }

    @Test("停止の後に開始したら、タスクを作らず何も出さない")
    func startAfterStop() async {
        let recorder = Recorder()
        let judgement = makeJudgement(recorder, received: false)
        judgement.stop()
        judgement.stop()
        #expect(judgement.start(origin: origin) == nil)
        #expect(recorder.events.isEmpty)
    }
}
