import AVFoundation
import Foundation
import Testing
@testable import HelperCore

// マイクの流れとタップの流れから、エコーを除いたマイクの流れを作る処理（差し替えの canceller）。

private struct StubFailure: Error, Equatable {}

private let base: UInt64 = 2_000_000_000

private func makeStream() -> (AsyncThrowingStream<CapturedAudio, Error>, AsyncThrowingStream<CapturedAudio, Error>.Continuation) {
    AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
}

private func mean(_ frame: [Float]) -> Float { frame.reduce(0, +) / Float(frame.count) }

/// 左右で値が違う 48 kHz・2ch・interleaved のバッファ（平均は (left + right) / 2）。
private func stereoAudio(left: Float, right: Float, frames: Int, hostTime: UInt64) -> CapturedAudio {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: true)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    let data = buffer.floatChannelData![0]
    for i in 0..<frames { data[2 * i] = left; data[2 * i + 1] = right }
    return CapturedAudio(buffer: buffer, hostTime: hostTime)
}

/// 最初の reverse で止まり、`release()` されるまで処理を進めない差し替え（AEC が追いつかない状態を作る）。
private final class BlockingEchoCanceller: EchoCanceller, @unchecked Sendable {
    private let gate = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var entered = false

    var isBlocked: Bool {
        lock.lock()
        defer { lock.unlock() }
        return entered
    }

    func release() { gate.signal() }

    func processReverse(_ frame: UnsafePointer<Float>) {
        lock.lock()
        entered = true
        lock.unlock()
        gate.wait()
        gate.signal()
    }

    func processCapture(_ frame: UnsafeMutablePointer<Float>) {}
}

@Suite("エコーキャンセルの流れ", .timeLimit(.minutes(1)))
struct EchoCancellationStreamTests {
    @Test("48 kHz・2ch・interleaved のタップと 16 kHz・1ch のマイクを 48 kHz・モノラルの 480 サンプルに変換し、参照を 90 ms 先に渡し、出力は最初のマイクの hostTime で始まる")
    func convertsFormatsAndAlignsByHostTime() async throws {
        let canceller = RecordingEchoCanceller()
        let (microphone, micInput) = makeStream()
        let (reference, referenceInput) = makeStream()
        let micStart = base + hostTicks(milliseconds: 90)
        // タップは 0.6 秒、マイクは 0.5 秒。タップはマイクより 90 ms 早く始まる
        referenceInput.yield(stereoAudio(left: 0.2, right: 0.4, frames: 28_800, hostTime: base))
        micInput.yield(constantAudio(value: 0.4, frames: 8_000, sampleRate: 16_000, channels: 1, interleaved: false, hostTime: micStart))
        referenceInput.finish()
        micInput.finish()

        let output = try await collect(echoCancelledStream(microphone: microphone, reference: reference, canceller: canceller))

        let events = canceller.events
        // マイクは 0.5 秒 = 50 区切り（変換器の端の差を許す）
        let captures = captureFrames(events)
        #expect((48...52).contains(captures.count))
        for frame in captures.dropFirst(5).dropLast(5) { #expect(abs(mean(frame) - 0.4) < 0.02) }
        // タップは 0.6 秒 = 60 区切り。2ch をそのまま 1ch として読むと 2 倍になる
        let realReverses = reverseFrames(events).filter { $0.contains { $0 != 0 } }
        #expect((55...61).contains(realReverses.count))
        for frame in realReverses { #expect(abs(mean(frame) - 0.3) < 0.02) }
        // 最初の capture（90 ms の時点）の前に、その時刻までの参照が 9 区切り以上渡っている
        #expect(try #require(reverseCountsBeforeEachCapture(events).first) >= 9)
        #expect(try #require(output.first).hostTime == micStart)
        #expect(abs(totalSeconds(output) - 0.5) < 0.05)
    }

    @Test("参照が未着の間は capture を呼ばず、参照が届いたあとで、本物の参照を reverse に渡してから capture を呼ぶ")
    func holdsMicrophoneWhileReferenceIsStillMissing() async throws {
        let canceller = RecordingEchoCanceller()
        let (microphone, micInput) = makeStream()
        let (reference, referenceInput) = makeStream()
        let output = echoCancelledStream(microphone: microphone, reference: reference, canceller: canceller)
        let collected = Task { try await collect(output) }

        micInput.yield(constantAudio(value: 0.4, frames: 4_800, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: base))
        try await Task.sleep(for: .milliseconds(300))
        #expect(canceller.events.isEmpty)

        referenceInput.yield(constantAudio(value: 0.3, frames: 9_600, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: base))
        referenceInput.finish()
        micInput.finish()
        let result = try await collected.value

        let events = canceller.events
        #expect(captureFrames(events).count == 10)
        if case .reverse(let frame)? = events.first {
            #expect(abs(mean(frame) - 0.3) < 0.001)
        } else {
            Issue.record("最初の呼び出しが reverse ではない: \(String(describing: events.first))")
        }
        #expect(try #require(result.first).hostTime == base)
    }

    @Test("AEC の処理が追いつかず、2 つの流れの合流点が上限（4096 個）を超えたら、音声を捨てずに backlogExceeded で終わる")
    func finishesWithBacklogExceededWhenProcessingCannotKeepUp() async throws {
        let canceller = BlockingEchoCanceller()
        defer { canceller.release() }
        let (microphone, micInput) = makeStream()
        let (reference, referenceInput) = makeStream()
        let output = echoCancelledStream(microphone: microphone, reference: reference, canceller: canceller)
        let collected = Task { try await collect(output) }

        // 処理 Task を最初の reverse で止める
        referenceInput.yield(constantAudio(value: 0.3, frames: 480, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: base))
        micInput.yield(constantAudio(value: 0.4, frames: 480, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: base))
        for _ in 0..<500 where !canceller.isBlocked { try await Task.sleep(for: .milliseconds(10)) }
        try #require(canceller.isBlocked)

        for i in 0..<5_000 {
            micInput.yield(constantAudio(value: 0.4, frames: 1, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: base + UInt64(i + 1)))
        }
        // 上限が働かないと出力は終わらない。待ちに期限を付け、超えたら失敗として取り消す（ブロックは defer で解除される）。
        let watchdog = Task {
            try await Task.sleep(for: .seconds(10))
            collected.cancel()
        }
        defer { watchdog.cancel() }

        do {
            _ = try await collected.value
            Issue.record("上限を超えたのに、backlogExceeded ではなく正常に終わった（または取り消された）")
        } catch let error as TranscriberError {
            guard case .backlogExceeded(let limit) = error else {
                Issue.record("backlogExceeded ではないエラー: \(error)")
                return
            }
            #expect(limit == 4096)
        }
    }

    @Test("マイクの流れがエラーで終わったら、出力も同じエラーで終わる")
    func propagatesMicrophoneError() async throws {
        let (microphone, micInput) = makeStream()
        let (reference, referenceInput) = makeStream()
        referenceInput.finish()
        micInput.yield(constantAudio(value: 0.4, frames: 4_800, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: base))
        micInput.finish(throwing: StubFailure())

        let output = echoCancelledStream(microphone: microphone, reference: reference, canceller: RecordingEchoCanceller())

        await #expect(throws: StubFailure.self) { _ = try await collect(output) }
    }

    @Test("参照の流れがエラーで終わっても止まらず、残りのマイクを無音の参照で処理して正常に終わる")
    func continuesWithSilenceWhenReferenceFails() async throws {
        let canceller = RecordingEchoCanceller()
        let (microphone, micInput) = makeStream()
        let (reference, referenceInput) = makeStream()
        referenceInput.finish(throwing: StubFailure())
        micInput.yield(constantAudio(value: 0.4, frames: 4_800, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: base))
        micInput.finish()

        let output = try await collect(echoCancelledStream(microphone: microphone, reference: reference, canceller: canceller))

        #expect(captureFrames(canceller.events).count == 10)
        #expect(reverseFrames(canceller.events).allSatisfy { $0.allSatisfy { $0 == 0 } })
        #expect(abs(totalSeconds(output) - 0.1) < 0.005)
    }
}
