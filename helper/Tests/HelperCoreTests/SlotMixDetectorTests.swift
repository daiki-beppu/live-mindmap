import Testing
@testable import HelperCore

// 枠への混入の検出（Issue #1024）。偽の埋め込み（8 次元の単位ベクトル）を `SlotMixDetector` に直接入れて、モデルなしで確かめる。
// 方向 e0..e7 は互いに直交（cos 0）。「cos c の声」は、e0 に c、別の直交方向に √(1-c²) を持つベクトルで作る。

private let dimension = 8

private func normalized(_ values: [Float]) -> [Float] {
    let norm = values.reduce(0) { $0 + $1 * $1 }.squareRoot()
    return values.map { $0 / norm }
}

private func cosine(_ a: [Float], _ b: [Float]) -> Float {
    zip(a, b).reduce(0) { $0 + $1.0 * $1.1 } / (a.reduce(0) { $0 + $1 * $1 }.squareRoot() * b.reduce(0) { $0 + $1 * $1 }.squareRoot())
}

/// 軸 `axis` の向きに、7・6 番目の軸へごく小さな決まったゆらぎを足した声。`index` でゆらぎが変わる（同じ声の別の区間）。
private func voice(axis: Int, index: Int = 0) -> [Float] {
    var v = [Float](repeating: 0, count: dimension)
    v[axis] = 1
    v[6] = 0.01 * Float(index % 3)
    v[7] = 0.01 * Float(index % 5)
    return normalized(v)
}

/// 軸 `base` の方向と cos が `similarity` になる声（残りは `other` の軸）。
private func voice(axis base: Int, similarity: Float, other: Int, index: Int = 0) -> [Float] {
    var v = [Float](repeating: 0, count: dimension)
    v[base] = similarity
    v[other] = (1 - similarity * similarity).squareRoot()
    v[6] += 0.005 * Float(index % 3)
    return normalized(v)
}

private func feed(_ detector: inout SlotMixDetector, slot: Int, _ embeddings: [[Float]]) -> [Bool] {
    embeddings.map { detector.add(slot: slot, embedding: $0) }
}

@Suite("枠への混入の検出")
struct SlotMixDetectorTests {
    @Test("基準値は名前の付いた定数。2 秒・10 秒・5 区間・10%・距離 0.6・新しい声の cos 0.6・既知の声の cos 0.9")
    func criteria() {
        #expect(SlotMixCriteria.minSegmentSeconds == 2)
        #expect(SlotMixCriteria.maxSegmentSeconds == 10)
        #expect(SlotMixCriteria.minSecondClusterSegments == 5)
        #expect(SlotMixCriteria.minSecondClusterShare == 0.10)
        #expect(SlotMixCriteria.clusterCosineDistance == 0.6)
        #expect(SlotMixCriteria.newVoiceMaxSimilarity == 0.6)
        #expect(SlotMixCriteria.knownVoiceSimilarity == 0.9)
    }

    @Test("枠が 1 人の声だけなら、いくつ入れても混入にならない")
    func singleVoiceNeverMixes() {
        var detector = SlotMixDetector()
        let results = feed(&detector, slot: 0, (0..<40).map { voice(axis: 0, index: $0) })
        #expect(!results.contains(true))
    }

    @Test("2 番目の塊が 5 区間そろった追加で、初めて混入になる（4 区間までは出ない）")
    func mixesAtFifthSegmentOfSecondCluster() {
        var detector = SlotMixDetector()
        let main = feed(&detector, slot: 1, (0..<10).map { voice(axis: 1, index: $0) })
        #expect(!main.contains(true))
        let second = feed(&detector, slot: 1, (0..<5).map { voice(axis: 3, index: $0) })
        #expect(second == [false, false, false, false, true])
    }

    @Test("同じ枠の混入は 1 回だけ。その後に同じ塊が増えても、もう出ない")
    func reportsOncePerSlot() {
        var detector = SlotMixDetector()
        _ = feed(&detector, slot: 1, (0..<10).map { voice(axis: 1, index: $0) })
        let second = feed(&detector, slot: 1, (0..<8).map { voice(axis: 3, index: $0) })
        #expect(second.filter { $0 }.count == 1)
        #expect(!feed(&detector, slot: 1, (0..<5).map { voice(axis: 3, index: $0) }).contains(true))
    }

    @Test("別の枠の混入は、それぞれ 1 回ずつ出る")
    func eachSlotReportsOnItsOwn() {
        var detector = SlotMixDetector()
        _ = feed(&detector, slot: 0, (0..<10).map { voice(axis: 0, index: $0) })
        _ = feed(&detector, slot: 1, (0..<10).map { voice(axis: 1, index: $0) })
        #expect(feed(&detector, slot: 0, (0..<5).map { voice(axis: 4, index: $0) }).last == true)
        #expect(feed(&detector, slot: 1, (0..<5).map { voice(axis: 5, index: $0) }).last == true)
    }

    @Test("2 番目の塊が 5 区間に足りなければ出ない（4 区間）")
    func fewerThanFiveSegmentsDoesNotMix() {
        var detector = SlotMixDetector()
        _ = feed(&detector, slot: 1, (0..<10).map { voice(axis: 1, index: $0) })
        #expect(!feed(&detector, slot: 1, (0..<4).map { voice(axis: 3, index: $0) }).contains(true))
    }

    @Test("2 番目の塊が枠の 10% に足りなければ出ない。10% に届いた追加（60 区間中の 7 区間目）で出る")
    func shareBelowTenPercentDoesNotMix() {
        var detector = SlotMixDetector()
        _ = feed(&detector, slot: 0, (0..<60).map { voice(axis: 0, index: $0) })
        // 5 区間（5/65）・6 区間（6/66 ≈ 9.1%）では出ない。7 区間（7/67 ≈ 10.4%）で出る
        let second = feed(&detector, slot: 0, (0..<7).map { voice(axis: 3, index: $0) })
        #expect(second == [false, false, false, false, false, false, true])
    }

    @Test("どれかの枠の主な塊と cos 0.6 以上の塊は出ない（cos 0.7）。0.6 未満（cos 0.5）なら出る")
    func similarToAnotherSlotMainClusterDoesNotMix() {
        var near = SlotMixDetector()
        _ = feed(&near, slot: 0, (0..<20).map { voice(axis: 0, index: $0) })
        _ = feed(&near, slot: 1, (0..<10).map { voice(axis: 2, index: $0) })
        // 枠 0 の主な塊（e0）と cos 0.7、枠 1 の主な塊（e2）とは直交
        #expect(!feed(&near, slot: 1, (0..<10).map { voice(axis: 0, similarity: 0.7, other: 3, index: $0) }).contains(true))

        var far = SlotMixDetector()
        _ = feed(&far, slot: 0, (0..<20).map { voice(axis: 0, index: $0) })
        _ = feed(&far, slot: 1, (0..<10).map { voice(axis: 2, index: $0) })
        #expect(feed(&far, slot: 1, (0..<5).map { voice(axis: 0, similarity: 0.5, other: 3, index: $0) }).last == true)
    }

    @Test("2 番目の塊が既知の声と cos 0.9 以上で一致するときは、割り当て違いとして無視する（cos 0.95）")
    func knownVoiceIsIgnored() {
        var detector = SlotMixDetector()
        _ = feed(&detector, slot: 0, (0..<20).map { voice(axis: 0, index: $0) })
        _ = feed(&detector, slot: 1, (0..<10).map { voice(axis: 2, index: $0) })
        let results = feed(&detector, slot: 1, (0..<10).map { voice(axis: 0, similarity: 0.95, other: 3, index: $0) })
        #expect(!results.contains(true))
    }

    @Test("主な塊が他の枠の声と一致していても、2 番目の塊が新しい声なら混入になる")
    func mainClusterMatchingAnotherSlotStillMixes() {
        var detector = SlotMixDetector()
        _ = feed(&detector, slot: 0, (0..<20).map { voice(axis: 0, index: $0) })
        _ = feed(&detector, slot: 1, (0..<10).map { voice(axis: 0, index: $0) })
        let results = feed(&detector, slot: 1, (0..<5).map { voice(axis: 3, index: $0) })
        #expect(results == [false, false, false, false, true])
    }

    @Test("主な塊が入れ替わり続けても、既知の声と一致しない塊は混入になる（A を 4、B を 5、A を 1 区間の順）")
    func alternatingMainClusterStillMixes() {
        var detector = SlotMixDetector()
        let results = feed(&detector, slot: 0, (0..<4).map { voice(axis: 0, index: $0) })
            + feed(&detector, slot: 0, (0..<5).map { voice(axis: 1, index: $0) })
            + feed(&detector, slot: 0, [voice(axis: 0, index: 4)])
        #expect(results.filter { $0 }.count == 1)
        #expect(results.last == true)
    }

    @Test("枠自身の主な塊とも cos 0.6 以上なら出ない。AHC の距離 0.6 より近い声は同じ塊になる")
    func closeToOwnMainClusterDoesNotSplit() {
        var detector = SlotMixDetector()
        _ = feed(&detector, slot: 0, (0..<20).map { voice(axis: 0, index: $0) })
        // 主な塊（e0）と cos 0.5（距離 0.5 < 0.6）。別の塊にならない
        #expect(!feed(&detector, slot: 0, (0..<10).map { voice(axis: 0, similarity: 0.5, other: 3, index: $0) }).contains(true))
    }

    @Test("AHC の距離 0.6 を超える声は別の塊になる（cos 0.3、距離 0.7）。他に枠が無ければ混入になる")
    func farFromOwnMainClusterSplits() {
        var detector = SlotMixDetector()
        _ = feed(&detector, slot: 0, (0..<20).map { voice(axis: 0, index: $0) })
        #expect(feed(&detector, slot: 0, (0..<5).map { voice(axis: 0, similarity: 0.3, other: 3, index: $0) }).last == true)
    }

    @Test("枠ごとの重心（主な塊）を外から取り出せる。最大の塊の向きで、混入を出した後も主な塊のまま")
    func exposesMainClusterCentroids() {
        var detector = SlotMixDetector()
        #expect(detector.centroids.isEmpty)
        _ = feed(&detector, slot: 0, (0..<20).map { voice(axis: 0, index: $0) })
        _ = feed(&detector, slot: 2, (0..<10).map { voice(axis: 2, index: $0) })
        _ = feed(&detector, slot: 2, (0..<5).map { voice(axis: 3, index: $0) }) // 混入が出る

        #expect(Set(detector.centroids.keys) == [0, 2])
        let first = detector.centroids[0] ?? []
        let third = detector.centroids[2] ?? []
        #expect(first.count == dimension)
        #expect(cosine(first, voice(axis: 0)) > 0.99)
        #expect(cosine(third, voice(axis: 2)) > 0.99)
        #expect(cosine(third, voice(axis: 3)) < 0.1)
        #expect(first.allSatisfy { $0.isFinite } && third.allSatisfy { $0.isFinite })
    }
}
