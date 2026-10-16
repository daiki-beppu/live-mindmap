import FluidAudio
import Foundation
import Testing
@testable import HelperCore

// 確定済みの位置（Issue #1021）。FluidAudio の公開 API `DiarizerTimeline.addPredictions` に予測を入れて、モデルなしで確かめる。
// 位置 f を流した後に確定する区間は、start が f 以上でなければならない。

private let speakerCount = 4

/// 枠ごとの活動の有無から、[フレーム数 × 4] の平らな予測を作る。
private func predictions(_ activity: [Set<Int>]) -> [Float] {
    activity.flatMap { active in (0..<speakerCount).map { active.contains($0) ? Float(1) : Float(0) } }
}

private func frames(_ range: Range<Int>, slot: Int) -> [Int: Set<Int>] {
    Dictionary(uniqueKeysWithValues: range.map { ($0, [slot]) })
}

/// frame → 話している枠の集合。範囲 [from, to) のフレームを並べる。
private func slice(_ truth: [Int: Set<Int>], _ from: Int, _ to: Int) -> [Set<Int>] {
    (from..<to).map { truth[$0] ?? [] }
}

private func merged(_ parts: [Int: Set<Int>]...) -> [Int: Set<Int>] {
    parts.reduce(into: [:]) { result, part in
        for (frame, slots) in part { result[frame, default: []].formUnion(slots) }
    }
}

/// `yield` に更新を順に通し、1 本のストリームに届いた順の配列を返す。
private func streamed(_ updates: [(update: DiarizerTimelineUpdate, finished: Bool)], shift: Double) async throws -> [SpeakerDiarization] {
    let stream = AsyncThrowingStream<SpeakerDiarization, Error> { continuation in
        var settledTo = -Double.infinity
        for item in updates {
            SortformerSpeakerDiarizer.yield(item.update, shift: shift, settledTo: &settledTo, finished: item.finished, to: continuation)
        }
        continuation.finish()
    }
    var received: [SpeakerDiarization] = []
    for try await element in stream { received.append(element) }
    return received
}

/// 位置 `.settled(to: f)` より後に届いた確定区間のうち start が f より小さいもの（契約違反）。
private func orderViolations(_ received: [SpeakerDiarization]) -> [SpeakerSegment] {
    var position = -Double.infinity
    var violations: [SpeakerSegment] = []
    for element in received {
        switch element {
        case .settled(let to):
            position = max(position, to)
        case .mixed, .centroid:
            break
        case .segment(let segment):
            if segment.isFinal && segment.start < position - 1e-6 { violations.append(segment) }
        }
    }
    return violations
}

@Suite("確定済みの位置")
struct SettledPositionTests {
    private let plain = SortformerSpeakerDiarizer.timelineConfig

    private var padded: DiarizerTimelineConfig {
        var config = SortformerSpeakerDiarizer.timelineConfig
        config.onsetPadFrames = 2
        config.offsetPadFrames = 2
        config.minFramesOn = 3
        config.minFramesOff = 4
        return config
    }

    @Test("更新の中の確定区間は、時刻の順ではなく枠の番号順に並ぶ。位置は、そのすべての end 以上")
    func finalizedSegmentsComeInSlotOrder() throws {
        let timeline = DiarizerTimeline(config: plain)
        let truth = merged(frames(10..<15, slot: 0), frames(2..<10, slot: 1))
        let update = try timeline.addPredictions(finalizedPredictions: predictions(slice(truth, 0, 20)), tentativePredictions: [])
        #expect(update.finalizedSegments.map(\.speakerIndex) == [0, 1])
        #expect(update.finalizedSegments[0].startTime > update.finalizedSegments[1].startTime)
        let position = SortformerSpeakerDiarizer.settledPosition(of: update, config: plain)
        #expect(update.finalizedSegments.allSatisfy { Double($0.endTime) <= position })
    }

    @Test("閉じていない区間があれば、位置はその start 以下で止まる。後で確定した区間の start は位置以上")
    func openSegmentHoldsPosition() throws {
        let timeline = DiarizerTimeline(config: plain)
        let truth = frames(15..<25, slot: 0)
        let first = try timeline.addPredictions(
            finalizedPredictions: predictions(slice(truth, 0, 20)), tentativePredictions: predictions(slice(truth, 20, 25)))
        #expect(first.finalizedSegments.isEmpty)
        let held = SortformerSpeakerDiarizer.settledPosition(of: first, config: plain)
        #expect(abs(held - Double(Float(15) * plain.frameDurationSeconds)) < 1e-6)
        let second = try timeline.addPredictions(finalizedPredictions: predictions(slice(truth, 20, 30)), tentativePredictions: [])
        let segment = try #require(second.finalizedSegments.first)
        #expect(Double(segment.startTime) >= held - 1e-6)
    }

    @Test("黙っている間（区間が無い更新）も、位置は音声の進みとともに進む")
    func positionAdvancesDuringSilence() throws {
        let timeline = DiarizerTimeline(config: plain)
        var positions: [Double] = []
        for _ in 0..<3 {
            let update = try timeline.addPredictions(finalizedPredictions: predictions(Array(repeating: [], count: 6)), tentativePredictions: [])
            #expect(update.finalizedSegments.isEmpty)
            positions.append(SortformerSpeakerDiarizer.settledPosition(of: update, config: plain))
        }
        #expect(positions == positions.sorted())
        #expect(Set(positions).count == 3)
        #expect(abs(positions[2] - Double(Float(18) * plain.frameDurationSeconds)) < 1e-6)
    }

    @Test("確定した区間の後ろにある余白と最小の間隔の分だけ、位置は確定済みの末尾より前になる")
    func positionLagsByPadding() throws {
        let timeline = DiarizerTimeline(config: padded)
        let update = try timeline.addPredictions(finalizedPredictions: predictions(Array(repeating: [], count: 20)), tentativePredictions: [])
        let position = SortformerSpeakerDiarizer.settledPosition(of: update, config: padded)
        #expect(abs(position - Double(Float(20 - 4 - 2 - 2) * padded.frameDurationSeconds)) < 1e-6)
    }

    @Test("終わりでは、処理した音声の終わりを返す。確定した区間の end を下回らない")
    func processedEndCoversEverything() throws {
        let timeline = DiarizerTimeline(config: plain)
        let truth = frames(5..<20, slot: 2)
        let update = try timeline.addPredictions(finalizedPredictions: predictions(slice(truth, 0, 20)), tentativePredictions: [])
        let end = SortformerSpeakerDiarizer.processedEnd(of: update, config: plain)
        #expect(abs(end - Double(Float(20) * plain.frameDurationSeconds)) < 1e-6)
        #expect(update.finalizedSegments.allSatisfy { Double($0.endTime) <= end + 1e-6 })
    }

    @Test("終わりの更新に残った仮の区間（まだ話している枠）は、確定として流す。途中の更新では仮のまま")
    func trailingSegmentsAreFinalAtTheEnd() throws {
        let timeline = DiarizerTimeline(config: plain)
        let truth = frames(10..<20, slot: 1)
        let update = try timeline.addPredictions(finalizedPredictions: predictions(slice(truth, 0, 20)), tentativePredictions: [])
        #expect(update.finalizedSegments.isEmpty)
        #expect(update.tentativeSegments.count == 1)
        #expect(SortformerSpeakerDiarizer.segments(of: update, finished: false).map(\.isFinal) == [false])
        let ended = SortformerSpeakerDiarizer.segments(of: update, finished: true)
        #expect(ended.map(\.isFinal) == [true])
        #expect(SortformerSpeakerDiarizer.processedEnd(of: update, config: plain) >= ended[0].end - 1e-6)
    }

    @Test("位置 f を流した後に確定する区間は、どの更新の並びでも start が f 以上（余白あり・なし）", arguments: [false, true], [1, 2, 3, 5])
    func laterSegmentsStartAtOrAfterPosition(withPadding: Bool, seed: Int) throws {
        let config = withPadding ? padded : plain
        var state = UInt64(seed) &* 6_364_136_223_846_793_005 &+ 1
        func next(_ bound: Int) -> Int {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((state >> 33) % UInt64(bound))
        }
        // 長短さまざまな発話を、4 つの枠にばらまく（重なりもある）
        var truth: [Int: Set<Int>] = [:]
        for slot in 0..<speakerCount {
            var frame = next(20)
            while frame < 400 {
                let length = 1 + next(40)
                truth = merged(truth, frames(frame..<(frame + length), slot: slot))
                frame += length + 1 + next(30)
            }
        }
        let timeline = DiarizerTimeline(config: config)
        var cursor = 0
        var position = -Double.infinity
        while cursor < 380 {
            let finalizedCount = 1 + next(12)
            let tentativeCount = next(8)
            let update = try timeline.addPredictions(
                finalizedPredictions: predictions(slice(truth, cursor, cursor + finalizedCount)),
                tentativePredictions: predictions(slice(truth, cursor + finalizedCount, cursor + finalizedCount + tentativeCount)))
            for segment in update.finalizedSegments {
                #expect(Double(segment.startTime) >= position - 1e-5, "位置 \(position) を流した後に start \(segment.startTime) の区間が確定した（フレーム \(cursor)）")
            }
            let proposed = SortformerSpeakerDiarizer.settledPosition(of: update, config: config)
            position = max(position, proposed)
            cursor += finalizedCount
        }
    }

    @Test("本番の流し方は、更新ごとに区間を流した後で位置を流す（途中の更新と終わりの更新）")
    func yieldEmitsSegmentsBeforePosition() async throws {
        let shift = 2.0
        let timeline = DiarizerTimeline(config: plain)
        let first = try timeline.addPredictions(
            finalizedPredictions: predictions(slice(merged(frames(10..<15, slot: 0), frames(2..<10, slot: 1)), 0, 20)), tentativePredictions: [])
        let truth = frames(25..<35, slot: 2)
        let last = try timeline.addPredictions(
            finalizedPredictions: predictions(slice(truth, 20, 30)), tentativePredictions: predictions(slice(truth, 30, 35)))
        let firstPosition = SortformerSpeakerDiarizer.settledPosition(of: first, config: plain) + shift
        #expect(first.finalizedSegments.count == 2)
        #expect(first.finalizedSegments.allSatisfy { Double($0.startTime) + shift < firstPosition })
        #expect(last.tentativeSegments.count == 1)
        let lastPosition = SortformerSpeakerDiarizer.processedEnd(of: last, config: plain) + shift
        #expect(Double(try #require(last.tentativeSegments.first).startTime) + shift < lastPosition)

        let received = try await streamed([(first, false), (last, true)], shift: shift)
        let settledCount = received.filter { if case .settled = $0 { true } else { false } }.count
        #expect(settledCount == 2)
        if case .settled = received.last {} else { Issue.record("最後は位置でなければならない: \(received)") }
        let finals = received.compactMap { element -> SpeakerSegment? in
            if case .segment(let segment) = element, segment.isFinal { return segment }
            return nil
        }
        #expect(finals.count == 3)
        #expect(orderViolations(received).isEmpty, "位置の後に、start がその位置より前の確定区間が届いた: \(received)")
    }

    @Test("本番の流し方は、どの更新の並びでも位置の後に start がその位置より前の確定区間を流さない", arguments: [1, 2, 3, 5])
    func yieldNeverEmitsFinalSegmentBehindPosition(seed: Int) async throws {
        var state = UInt64(seed) &* 6_364_136_223_846_793_005 &+ 1
        func next(_ bound: Int) -> Int {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((state >> 33) % UInt64(bound))
        }
        var truth: [Int: Set<Int>] = [:]
        for slot in 0..<speakerCount {
            var frame = next(20)
            while frame < 400 {
                let length = 1 + next(40)
                truth = merged(truth, frames(frame..<(frame + length), slot: slot))
                frame += length + 1 + next(30)
            }
        }
        let timeline = DiarizerTimeline(config: plain)
        var updates: [(update: DiarizerTimelineUpdate, finished: Bool)] = []
        var cursor = 0
        while cursor < 380 {
            let finalizedCount = 1 + next(12)
            let tentativeCount = next(8)
            let update = try timeline.addPredictions(
                finalizedPredictions: predictions(slice(truth, cursor, cursor + finalizedCount)),
                tentativePredictions: predictions(slice(truth, cursor + finalizedCount, cursor + finalizedCount + tentativeCount)))
            updates.append((update, cursor + finalizedCount >= 380))
            cursor += finalizedCount
        }
        let received = try await streamed(updates, shift: 1.5)
        #expect(received.contains { if case .segment(let s) = $0 { s.isFinal } else { false } })
        #expect(orderViolations(received).isEmpty)
    }
}
