import AVFoundation
import Foundation
import Testing
@testable import HelperCore

// タップの流れを、AEC の参照と `相手` の文字起こしの両方へ配る。

private struct StubFailure: Error, Equatable {}

private func audio(hostTime: UInt64) -> CapturedAudio {
    constantAudio(value: 0.1, frames: 480, sampleRate: 48_000, channels: 1, interleaved: false, hostTime: hostTime)
}

private func hostTimes(_ stream: AsyncThrowingStream<CapturedAudio, Error>) async throws -> [UInt64] {
    try await collect(stream).map(\.hostTime)
}

@Suite("流れの分配", .timeLimit(.minutes(1)))
struct StreamSplitTests {
    @Test("上流の要素は、2 つの流れの両方に同じ順で届き、上流が終わると両方が終わる")
    func deliversEveryElementToBothStreams() async throws {
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (first, second) = split(upstream)

        for time in 1...5 { input.yield(audio(hostTime: UInt64(time))) }
        input.finish()

        #expect(try await hostTimes(first) == [1, 2, 3, 4, 5])
        #expect(try await hostTimes(second) == [1, 2, 3, 4, 5])
    }

    @Test("2 つの流れは同じ中身の別々のバッファを受け取り、同じ AVAudioPCMBuffer を共有しない（Issue #160）")
    func deliversSeparateBuffersWithTheSameSamples() async throws {
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (first, second) = split(upstream)

        // 相手のタップと同じ 2ch interleaved。サンプルごとに値を変え、中身が丸ごと写ったかを確かめる
        let original = constantAudio(value: 0, frames: 480, sampleRate: 48_000, channels: 2, interleaved: true, hostTime: 7)
        let samples = original.buffer.floatChannelData![0]
        for i in 0..<(480 * 2) { samples[i] = Float(i) / 1000 }
        input.yield(original)
        input.finish()

        let firstItems = try await collect(first)
        let secondItems = try await collect(second)
        #expect(firstItems.count == 1 && secondItems.count == 1)
        let a = firstItems[0], b = secondItems[0]
        #expect(a.buffer !== b.buffer)
        #expect(a.hostTime == 7 && b.hostTime == 7)
        #expect(b.buffer.format == a.buffer.format)
        #expect(b.buffer.frameLength == a.buffer.frameLength)
        let aSamples = UnsafeBufferPointer(start: a.buffer.floatChannelData![0], count: 480 * 2)
        let bSamples = UnsafeBufferPointer(start: b.buffer.floatChannelData![0], count: 480 * 2)
        #expect(Array(aSamples) == Array(bSamples))
    }

    @Test("上流がエラーで終わると、2 つの流れの両方が、届いた要素のあとに同じエラーで終わる")
    func propagatesUpstreamErrorToBothStreams() async throws {
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (first, second) = split(upstream)

        input.yield(audio(hostTime: 1))
        input.finish(throwing: StubFailure())

        for stream in [first, second] {
            var received: [UInt64] = []
            await #expect(throws: StubFailure.self) {
                for try await item in stream { received.append(item.hostTime) }
            }
            #expect(received == [1])
        }
    }

    @Test("片方の流れが先に読むのをやめても、もう片方には上流の最後まで流れ続ける")
    func keepsFeedingTheOtherStreamAfterOneStops() async throws {
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (first, second) = split(upstream)

        let reader = Task<Void, Error> { for try await _ in first {} }
        input.yield(audio(hostTime: 1))
        // first の読み手を取り消す。取り消しで first の流れは終わった扱いになる
        reader.cancel()
        _ = try? await reader.value

        for time in 2...5 { input.yield(audio(hostTime: UInt64(time))) }
        input.finish()

        #expect(try await hostTimes(second) == [1, 2, 3, 4, 5])
    }

    @Test("片方の流れが読まれないまま未消費の上限（2048）を超えると、その流れは backlogExceeded で終わり、もう片方には上流の最後まで流れ続ける")
    func failsOnlyTheStreamThatExceedsBacklogLimit() async throws {
        let limit = 2048
        let total = limit + 52
        let (upstream, input) = AsyncThrowingStream.makeStream(of: CapturedAudio.self, throwing: Error.self)
        let (first, second) = split(upstream)

        // second は 1 件ずつ読み、未消費を常に 1 件以下に保つ。first は読まない
        var secondTimes: [UInt64] = []
        var secondIterator = second.makeAsyncIterator()
        for time in 1...total {
            input.yield(audio(hostTime: UInt64(time)))
            if let item = try await secondIterator.next() { secondTimes.append(item.hostTime) }
        }
        input.finish()
        #expect(try await secondIterator.next() == nil)
        #expect(secondTimes == (1...total).map { UInt64($0) })

        var firstTimes: [UInt64] = []
        do {
            for try await item in first { firstTimes.append(item.hostTime) }
            Issue.record("first が上限超過のエラーなしで終わった")
        } catch let error as TranscriberError {
            guard case .backlogExceeded(let reported) = error else {
                Issue.record("想定外の TranscriberError: \(error)")
                return
            }
            #expect(reported == limit)
        }
        #expect(firstTimes == (1...limit).map { UInt64($0) })
    }
}
