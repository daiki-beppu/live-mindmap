import Testing
@testable import HelperCore

private func probabilities(_ activity: [Set<Int>]) -> [Float] {
    activity.flatMap { active in (0..<8).map { active.contains($0) ? Float(1) : Float(0) } }
}

private func streamed(_ updates: [SpeakerSegmentUpdate], shift: Double) async throws -> [SpeakerDiarization] {
    let stream = AsyncThrowingStream<SpeakerDiarization, Error> { continuation in
        for update in updates { Nemotron3SpeakerDiarizer.yield(update, shift: shift, to: continuation) }
        continuation.finish()
    }
    var received: [SpeakerDiarization] = []
    for try await element in stream { received.append(element) }
    return received
}

@Suite("確定済みの位置")
struct SettledPositionTests {
    @Test("8 枠の 10 ms の活動を、閾値 0.5 で余白・最短長の除去なしに返す")
    func shortActivityInAllEightSlots() {
        var timeline = SpeakerSegmentTimeline()
        let update = timeline.append(probabilities: Array(repeating: Float(0.49), count: 8)
            + Array(repeating: Float(0.51), count: 8) + Array(repeating: Float(0.5), count: 8), frameCount: 3)
        #expect(update.segments == (0..<8).map { SpeakerSegment(start: 0.01, end: 0.02, slot: $0, isFinal: true) })
        #expect(update.settled == 0.03)
    }

    @Test("塊をまたいで続く活動は仮の開始位置を保ち、閉じた時に一つの確定区間になる")
    func openSegmentHoldsPosition() {
        var timeline = SpeakerSegmentTimeline()
        let first = timeline.append(probabilities: probabilities([[], [7], [7]]), frameCount: 3)
        #expect(first.segments == [SpeakerSegment(start: 0.01, end: 0.03, slot: 7, isFinal: false)])
        #expect(first.settled == 0.01)
        let second = timeline.append(probabilities: probabilities([[7], [7]]), frameCount: 2)
        #expect(second.segments == [SpeakerSegment(start: 0.01, end: 0.05, slot: 7, isFinal: false)])
        #expect(second.settled == 0.01)
        let closed = timeline.append(probabilities: probabilities([[]]), frameCount: 1)
        #expect(closed.segments == [SpeakerSegment(start: 0.01, end: 0.05, slot: 7, isFinal: true)])
        #expect(closed.settled == 0.06)
    }

    @Test("複数の未閉鎖区間では最も早い開始まで待ち、その枠が閉じた後は残る開始まで進む")
    func earliestOpenSlotHoldsPosition() {
        var timeline = SpeakerSegmentTimeline()
        let first = timeline.append(probabilities: probabilities([[], [7], [0, 7]]), frameCount: 3)
        #expect(first.settled == 0.01)
        let next = timeline.append(probabilities: probabilities([[0]]), frameCount: 1)
        #expect(next.segments == [SpeakerSegment(start: 0.01, end: 0.03, slot: 7, isFinal: true),
            SpeakerSegment(start: 0.02, end: 0.04, slot: 0, isFinal: false)])
        #expect(next.settled == 0.02)
    }

    @Test("無音の塊でも処理した末尾まで位置が進む")
    func positionAdvancesDuringSilence() {
        var timeline = SpeakerSegmentTimeline()
        for count in 1...3 {
            let update = timeline.append(probabilities: probabilities(Array(repeating: [], count: 10)), frameCount: 10)
            #expect(update.segments.isEmpty)
            #expect(update.settled == Double(count) / 10)
        }
    }

    @Test("終了時の追加確率が空でも未閉鎖区間を確定し、処理済み末尾まで進める。再度終了しても重複しない")
    func trailingSegmentsAreFinalAtTheEnd() {
        var timeline = SpeakerSegmentTimeline()
        _ = timeline.append(probabilities: probabilities([[2], [2], [2]]), frameCount: 3)
        _ = timeline.append(probabilities: [], frameCount: 0)
        let ended = timeline.finish()
        #expect(ended.segments == [SpeakerSegment(start: 0, end: 0.03, slot: 2, isFinal: true)])
        #expect(ended.settled == 0.03)
        #expect(timeline.finish().segments.isEmpty)
    }

    @Test("入力なしで終了しても区間を作らない")
    func emptyStreamHasNoSegments() {
        var timeline = SpeakerSegmentTimeline()
        let ended = timeline.finish()
        #expect(ended.segments.isEmpty)
        #expect(ended.settled == 0)
    }

    @Test("同じ更新では確定・仮・位置の順に出し、すべての時刻に同じ補正を足す")
    func yieldEmitsFinalThenTentativeThenPosition() async throws {
        var timeline = SpeakerSegmentTimeline()
        let update = timeline.append(probabilities: probabilities([[0], [0, 7], [7]]), frameCount: 3)
        let received = try await streamed([update], shift: 1.5)
        #expect(received == [.segment(SpeakerSegment(start: 1.5, end: 1.52, slot: 0, isFinal: true)),
            .segment(SpeakerSegment(start: 1.51, end: 1.53, slot: 7, isFinal: false)), .settled(to: 1.51)])
    }

    @Test("連続した塊と終了のどの段でも、位置の後にその位置より前で始まる確定区間を出さず、活動を落とさない", arguments: [1, 2, 3, 5])
    func yieldNeverEmitsFinalSegmentBehindPosition(seed: Int) async throws {
        var random = UInt64(seed)
        var timeline = SpeakerSegmentTimeline()
        var updates: [SpeakerSegmentUpdate] = []
        var activeFrameCount = 0
        for _ in 0..<40 {
            var activity: [Set<Int>] = []
            for _ in 0..<7 {
                random = random &* 6_364_136_223_846_793_005 &+ 1
                let active = Set((0..<8).filter { (random >> $0) & 1 == 1 })
                activeFrameCount += active.count
                activity.append(active)
            }
            updates.append(timeline.append(probabilities: probabilities(activity), frameCount: 7))
        }
        updates.append(timeline.finish())
        let received = try await streamed(updates, shift: 1.5)
        var position = -Double.infinity
        var finalFrameCount = 0
        for element in received {
            switch element {
            case .settled(let to):
                #expect(to >= position)
                position = to
            case .segment(let segment) where segment.isFinal:
                #expect(segment.start >= position - 1e-9)
                finalFrameCount += Int(((segment.end - segment.start) * 100).rounded())
            case .segment, .mixed, .centroid: break
            }
        }
        #expect(finalFrameCount == activeFrameCount)
        #expect(position == 4.3)
    }
}
