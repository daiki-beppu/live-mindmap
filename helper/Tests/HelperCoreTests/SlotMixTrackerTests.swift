import FluidAudio
import Foundation
import Testing
@testable import HelperCore

// 確定区間から埋め込みを作る段（Issue #1024）。偽の埋め込み器 `FakeSpeakerEmbedder` を入れて、モデルなしで確かめる。
// 音声はサンプルの値で「誰の声か」を表す（値 0.1 → 軸 0、0.2 → 軸 1、…）。偽の埋め込み器は、渡されたサンプルの先頭の値で軸を決める。

private let rate = 16_000

private final class FakeSpeakerEmbedder: SpeakerEmbedder, @unchecked Sendable {
    private(set) var calls: [[Float]] = []
    /// 失敗させる呼び出しの回（1 始まり）。
    private let failingCalls: Set<Int>

    init(failingCalls: Set<Int> = []) { self.failingCalls = failingCalls }

    private struct EmbedFailure: Error {}

    func embed(_ samples16k: [Float]) throws -> [Float] {
        calls.append(samples16k)
        if failingCalls.contains(calls.count) { throw EmbedFailure() }
        var v = [Float](repeating: 0, count: 8)
        v[max(0, min(7, Int((samples16k[0] * 10).rounded()) - 1))] = 1
        return v
    }
}

/// 時刻 [from, to) 秒の間、値が `value` の音声。
private func audio(_ regions: [(from: Double, to: Double, value: Float)]) -> [Float] {
    let end = regions.map(\.to).max() ?? 0
    var samples = [Float](repeating: 0.5, count: Int(end * Double(rate)))
    for region in regions {
        for i in Int(region.from * Double(rate))..<Int(region.to * Double(rate)) { samples[i] = region.value }
    }
    return samples
}

private func final(_ slot: Int, _ start: Double, _ end: Double) -> SpeakerSegment {
    SpeakerSegment(start: start, end: end, slot: slot, isFinal: true)
}

/// 区間 [start, start + 2) を `count` 個、2 秒ずつ続けて並べる。
private func run(slot: Int, from start: Double, count: Int) -> [SpeakerSegment] {
    (0..<count).map { final(slot, start + Double($0) * 2, start + Double($0) * 2 + 2) }
}

@Suite("確定区間の埋め込みと混入の検出")
struct SlotMixTrackerTests {
    @Test("2 秒未満の確定区間は埋め込みにしない。ちょうど 2 秒は 1 回、2 秒分のサンプルで埋め込む")
    func shortSegmentsAreSkipped() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        tracker.append(samples16k: audio([(0, 10, 0.1)]))

        _ = tracker.update(finalized: [final(0, 0, 1.9)]).mixed
        #expect(embedder.calls.isEmpty)

        _ = tracker.update(finalized: [final(0, 3, 5)]).mixed
        #expect(embedder.calls.map(\.count) == [2 * rate])
    }

    @Test("仮の区間は埋め込みにしない（確定した区間だけ）")
    func tentativeSegmentsAreSkipped() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        tracker.append(samples16k: audio([(0, 10, 0.1)]))

        _ = tracker.update(finalized: [SpeakerSegment(start: 0, end: 5, slot: 0, isFinal: false)]).mixed

        #expect(embedder.calls.isEmpty)
    }

    @Test("10 秒を超える区間は、中央の 10 秒に切って埋め込む")
    func longSegmentUsesCenterTenSeconds() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        // 区間 [2, 27)（25 秒）。中央の 10 秒は [9.5, 19.5)
        tracker.append(samples16k: audio([(0, 9.5, 0.1), (9.5, 19.5, 0.2), (19.5, 30, 0.3)]))

        _ = tracker.update(finalized: [final(0, 2, 27)]).mixed

        #expect(embedder.calls.count == 1)
        #expect(embedder.calls[0].count == 10 * rate)
        #expect(Set(embedder.calls[0]) == [0.2])
    }

    @Test("ちょうど 10 秒の区間は切らない")
    func tenSecondSegmentIsKept() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        tracker.append(samples16k: audio([(0, 12, 0.1)]))

        _ = tracker.update(finalized: [final(0, 1, 11)]).mixed

        #expect(embedder.calls.map(\.count) == [10 * rate])
    }

    @Test("確定区間は時刻の順に処理する（FluidAudio は枠の番号順に返す）。5 区間目の終わりが混入の時刻になる")
    func processesInTimeOrderAndReportsAtTriggeringEnd() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        // 枠 0 の主な塊 0〜40 秒、枠 1 の主な塊 40〜60 秒（10 区間）、枠 1 の別の声 60〜70 秒（5 区間）
        tracker.append(samples16k: audio([(0, 40, 0.1), (40, 60, 0.2), (60, 70, 0.3)]))
        let segments = run(slot: 0, from: 0, count: 20) + run(slot: 1, from: 40, count: 10) + run(slot: 1, from: 60, count: 5)

        let mixed = tracker.update(finalized: segments.reversed()).mixed

        #expect(mixed.count == 1)
        #expect(mixed.first?.slot == 1)
        #expect(abs((mixed.first?.at ?? 0) - 70) < 1e-9)
    }

    @Test("埋め込みに失敗した区間は飛ばして続ける。失敗した区間は塊に数えず、報告もしない")
    func embeddingFailureSkipsSegmentAndContinues() {
        // 15 回目（区間 68〜70）の埋め込みを失敗させる
        let embedder = FakeSpeakerEmbedder(failingCalls: [15])
        let tracker = SlotMixTracker(embedder: embedder)
        tracker.append(samples16k: audio([(40, 60, 0.2), (60, 72, 0.3)]))

        let mixed = tracker.update(finalized: run(slot: 1, from: 40, count: 10) + run(slot: 1, from: 60, count: 6)).mixed

        #expect(embedder.calls.count == 16)
        #expect(mixed.count == 1)
        #expect(mixed.first?.slot == 1)
        #expect(abs((mixed.first?.at ?? 0) - 72) < 1e-9)
    }

    @Test("条件を満たさなければ空。音声を捨てた後でも、残っている区間は同じ時刻で埋め込める")
    func discardKeepsLaterAudioAddressable() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        tracker.append(samples16k: audio([(0, 20, 0.1), (20, 30, 0.2)]))

        tracker.discard(before: 18)
        let mixed = tracker.update(finalized: [final(1, 22, 26)]).mixed

        #expect(mixed.isEmpty)
        #expect(embedder.calls.count == 1)
        #expect(embedder.calls[0].count == 4 * rate)
        #expect(Set(embedder.calls[0]) == [0.2])
    }

    @Test("重心が変わった枠について、最後の重心を返す（長さ 1）。1 回の呼び出しで同じ枠は 1 件")
    func returnsCentroidOfChangedSlot() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        tracker.append(samples16k: audio([(0, 6, 0.1)]))

        let centroids = tracker.update(finalized: run(slot: 3, from: 0, count: 3)).centroids

        #expect(centroids.map(\.slot) == [3])
        let vector = centroids.first?.centroid ?? []
        #expect(vector.count == 8)
        #expect(vector[0] > 0.99)
        #expect(abs(vector.reduce(0) { $0 + $1 * $1 } - 1) < 1e-4)
    }

    @Test("複数の枠の重心は、枠の番号の順に返す")
    func centroidsAreOrderedBySlot() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        tracker.append(samples16k: audio([(0, 2, 0.1), (2, 4, 0.2)]))

        let centroids = tracker.update(finalized: [final(3, 0, 2), final(1, 2, 4)]).centroids

        #expect(centroids.map(\.slot) == [1, 3])
        #expect((centroids[0].centroid)[1] > 0.99)
        #expect((centroids[1].centroid)[0] > 0.99)
    }

    @Test("重心が変わらなかった枠は返さない（毎回すべての枠を流さない）")
    func unchangedCentroidIsNotReturnedAgain() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        tracker.append(samples16k: audio([(0, 12, 0.1)]))

        let first = tracker.update(finalized: run(slot: 3, from: 0, count: 3))
        let second = tracker.update(finalized: [final(3, 6, 8)])

        #expect(first.centroids.map(\.slot) == [3])
        #expect(second.centroids.isEmpty)
    }

    @Test("主な塊が替わって重心が動いた枠は、また返す")
    func movedCentroidIsReturnedAgain() {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        tracker.append(samples16k: audio([(0, 6, 0.1), (6, 14, 0.2)]))

        let first = tracker.update(finalized: run(slot: 1, from: 0, count: 3))
        let second = tracker.update(finalized: run(slot: 1, from: 6, count: 4))

        #expect((first.centroids.first?.centroid ?? [])[0] > 0.99)
        #expect(second.centroids.map(\.slot) == [1])
        #expect((second.centroids.first?.centroid ?? [])[1] > 0.99)
    }

    @Test("2 秒未満の区間・仮の区間・埋め込みに失敗した区間は、重心を返さない")
    func skippedSegmentsReturnNoCentroid() {
        let failing = SlotMixTracker(embedder: FakeSpeakerEmbedder(failingCalls: [1]))
        failing.append(samples16k: audio([(0, 10, 0.1)]))
        let tracker = SlotMixTracker(embedder: FakeSpeakerEmbedder())
        tracker.append(samples16k: audio([(0, 10, 0.1)]))

        #expect(tracker.update(finalized: [final(0, 0, 1.9)]).centroids.isEmpty)
        #expect(tracker.update(finalized: [SpeakerSegment(start: 0, end: 5, slot: 0, isFinal: false)]).centroids.isEmpty)
        #expect(failing.update(finalized: [final(0, 0, 3)]).centroids.isEmpty)
    }

    @Test("更新の流し方は、区間 → 混入 → 確定済みの位置の順。混入の時刻にはシフトを足す（重心は混入の前。下のテスト）")
    func yieldOrdersMixedBetweenSegmentsAndSettled() async throws {
        let shift = 2.0
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        // 枠 1 の主な塊 10 区間と別の声 4 区間を先に入れておく（50〜78 秒）。更新の確定区間（枠 1、約 0.8〜3.2 秒）が 5 区間目になる
        tracker.append(samples16k: audio([(0, 5, 0.3), (50, 70, 0.2), (70, 78, 0.3)]))
        _ = tracker.update(finalized: run(slot: 1, from: 50, count: 10) + run(slot: 1, from: 70, count: 4)).mixed

        let config = SortformerSpeakerDiarizer.timelineConfig
        let timeline = DiarizerTimeline(config: config)
        let predictions: [Float] = (0..<60).flatMap { frame in (0..<4).map { slot in slot == 1 && (10..<40).contains(frame) ? Float(1) : Float(0) } }
        let update = try timeline.addPredictions(finalizedPredictions: predictions, tentativePredictions: [])
        let segment = try #require(update.finalizedSegments.first)
        #expect(Double(segment.endTime) - Double(segment.startTime) >= 2)

        let stream = AsyncThrowingStream<SpeakerDiarization, Error> { continuation in
            var settledTo = -Double.infinity
            SortformerSpeakerDiarizer.yield(update, shift: shift, settledTo: &settledTo, finished: false, mixing: tracker, to: continuation)
            continuation.finish()
        }
        var received: [SpeakerDiarization] = []
        for try await element in stream { received.append(element) }

        let kinds = received.map { element -> String in
            switch element {
            case .segment: "segment"
            case .mixed: "mixed"
            case .centroid: "centroid"
            case .settled: "settled"
            }
        }
        #expect(kinds.filter { $0 != "centroid" } == ["segment", "mixed", "settled"])
        guard case .mixed(let slot, let at) = received[1] else { return }
        #expect(slot == 1)
        #expect(abs(at - (Double(segment.endTime) + shift)) < 1e-6)
    }

    @Test("更新の流し方は、区間 → 重心 → 混入 → 確定済みの位置の順。重心は混入より先、確定済みの位置より前。重心の値はそのまま、シフトを足さない")
    func yieldOrdersCentroidBeforeMixedAndSettled() async throws {
        let embedder = FakeSpeakerEmbedder()
        let tracker = SlotMixTracker(embedder: embedder)
        // 枠 1 の主な塊 10 区間と別の声 4 区間を先に入れておく（50〜78 秒）。更新の確定区間（枠 1、約 0〜2.2 秒）が 5 区間目になり、混入になる。
        // 同じ更新の枠 3（約 2.4〜4.6 秒）は初めての枠で、重心が新しくできる
        tracker.append(samples16k: audio([(0, 5, 0.3), (50, 70, 0.2), (70, 78, 0.3)]))
        _ = tracker.update(finalized: run(slot: 1, from: 50, count: 10) + run(slot: 1, from: 70, count: 4))

        let timeline = DiarizerTimeline(config: SortformerSpeakerDiarizer.timelineConfig)
        let predictions: [Float] = (0..<60).flatMap { frame in
            (0..<4).map { slot in (slot == 1 && (0..<28).contains(frame)) || (slot == 3 && (30..<58).contains(frame)) ? Float(1) : Float(0) }
        }
        let update = try timeline.addPredictions(finalizedPredictions: predictions, tentativePredictions: [])
        #expect(update.finalizedSegments.count == 2)

        let stream = AsyncThrowingStream<SpeakerDiarization, Error> { continuation in
            var settledTo = -Double.infinity
            SortformerSpeakerDiarizer.yield(update, shift: 2, settledTo: &settledTo, finished: false, mixing: tracker, to: continuation)
            continuation.finish()
        }
        var received: [SpeakerDiarization] = []
        for try await element in stream { received.append(element) }

        let kinds = received.map { element -> String in
            switch element {
            case .segment: "segment"
            case .centroid: "centroid"
            case .mixed: "mixed"
            case .settled: "settled"
            }
        }
        #expect(kinds == ["segment", "segment", "centroid", "mixed", "settled"])
        guard case .centroid(let slot, let centroid) = received[2] else { return }
        #expect(slot == 3)
        #expect(centroid.count == 8)
        #expect(centroid[2] > 0.99)
    }
}
