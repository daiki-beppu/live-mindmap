import Foundation
import Testing
@testable import HelperCore

private final class ObservedAudio: @unchecked Sendable {
    private let lock = NSLock()
    private var times: [UInt64] = []
    var hostTimes: [UInt64] { lock.withLock { times } }
    func append(_ audio: CapturedAudio) { lock.withLock { times.append(audio.hostTime) } }
}

@Suite("音声の観測と転送", .timeLimit(.minutes(1)))
struct ObservingTests {
    @Test("観測してから順に転送し、すべての観測が終わってから finished が完了する")
    func observesBeforeForwardingAndFinishes() async throws {
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let observed = ObservedAudio()
        let (stream, finished) = observing(upstream, each: { observed.append($0) })
        for time in UInt64(1)...3 {
            input.yield(constantAudio(value: Float(time), frames: 1, sampleRate: 48_000,
                channels: 1, interleaved: false, hostTime: time))
        }
        input.finish()

        var times: [UInt64] = []
        for try await audio in stream {
            #expect(observed.hostTimes.contains(audio.hostTime))
            #expect(audio.buffer.floatChannelData?[0][0] == Float(audio.hostTime))
            times.append(audio.hostTime)
        }
        try await finished.value

        #expect(times == [1, 2, 3])
        #expect(observed.hostTimes == times)
    }

    @Test("未消費上限を超えると、下流と finished が backlogExceeded を運ぶ")
    func backlogFailureReachesStreamAndFinished() async throws {
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (stream, finished) = observing(upstream, each: { _ in })
        let audio = constantAudio(value: 0, frames: 1, sampleRate: 48_000,
            channels: 1, interleaved: false, hostTime: 1)
        for _ in 0...downstreamBacklogLimit { input.yield(audio) }
        input.finish()

        do {
            try await finished.value
            Issue.record("finished が上限超過の失敗を返さなかった")
        } catch let error as TranscriberError {
            guard case .backlogExceeded(let limit) = error else { throw error }
            #expect(limit == downstreamBacklogLimit)
        }
        var count = 0
        do {
            for try await _ in stream { count += 1 }
            Issue.record("下流が上限超過の失敗を返さなかった")
        } catch let error as TranscriberError {
            guard case .backlogExceeded(let limit) = error else { throw error }
            #expect(limit == downstreamBacklogLimit)
        }
        #expect(count == downstreamBacklogLimit)
    }

    @Test("下流を中断すると、測定用の上流も中断する")
    func downstreamCancellationStopsUpstreamObservation() async throws {
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (terminated, termination) = AsyncStream.makeStream(of: Void.self)
        input.onTermination = { _ in termination.finish() }
        let (stream, finished) = observing(upstream, each: { _ in })
        let reader = Task { for try await _ in stream {} }
        reader.cancel()

        for await _ in terminated {}
        _ = await reader.result
        _ = await finished.result
    }
}
