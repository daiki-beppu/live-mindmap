import Testing
@testable import stt_bench

// 合成の時刻計算（純粋な関数）。`say` や音声認識は使わないので CI でも流す。
// 式は gen.py と同じ: 先頭の無音のあと、各行は start = t、end = t + 長さ、次の t = t + 長さ + gap。

@Suite("合成の時刻計算")
struct SynthTimelineTests {
    @Test("先頭の無音 1.0 秒、各行の後に無音 0.5 秒: start / end は gen.py と同じ式になる")
    func sequentialPlacement() {
        let placed = placeLines(durations: [2.0, 1.0, 3.0], gaps: [0.5, 0.5, 0.5], leadingSilence: 1.0)
        #expect(placed == [
            PlacedLine(start: 1.0, end: 3.0),
            PlacedLine(start: 3.5, end: 4.5),
            PlacedLine(start: 5.0, end: 8.0),
        ])
    }

    @Test("gap が 0 なら、次の行は前の行の end からそのまま始まる")
    func zeroGap() {
        let placed = placeLines(durations: [1.0, 1.0], gaps: [0, 0], leadingSilence: 0)
        #expect(placed == [PlacedLine(start: 0, end: 1.0), PlacedLine(start: 1.0, end: 2.0)])
    }

    @Test("gap を負にすると次の行が前の行と重なる（相づち）")
    func negativeGapOverlaps() {
        let placed = placeLines(durations: [2.0, 1.0], gaps: [-0.5, 0], leadingSilence: 1.0)
        #expect(placed[1] == PlacedLine(start: 2.5, end: 3.5))
    }

    @Test("重なりのために gap を負にしても、start は 0 未満にならない")
    func startNeverNegative() {
        let placed = placeLines(durations: [0.5, 1.0, 1.0], gaps: [-1.0, -5.0, 0], leadingSilence: 0.2)
        #expect(placed.allSatisfy { $0.start >= 0 })
        #expect(placed[1].start == 0)
    }
}

@Suite("音声の重ね合わせ")
struct MixTests {
    @Test("重ならない音声は、配置したまま（振幅が 1 以内なら変えない）")
    func nonOverlappingUnchanged() {
        let mixed = mixPlacedSamples([
            PlacedSamples(startFrame: 1, samples: [0.5, -0.5]),
            PlacedSamples(startFrame: 4, samples: [0.25]),
        ])
        #expect(mixed == [0, 0.5, -0.5, 0, 0.25])
    }

    @Test("重なった部分は足し合わせる（振幅が 1 以内のとき）")
    func overlapIsSummed() {
        let mixed = mixPlacedSamples([
            PlacedSamples(startFrame: 0, samples: [0.25, 0.25]),
            PlacedSamples(startFrame: 1, samples: [0.5, 0.5]),
        ])
        #expect(mixed == [0.25, 0.75, 0.5])
    }

    @Test("足し合わせて 1 を超えるときは、クリップせず全体を同じ比率で小さくして 1 以内に収める")
    func scaledDownWithoutClipping() {
        let mixed = mixPlacedSamples([
            PlacedSamples(startFrame: 0, samples: [0.8, 0.8]),
            PlacedSamples(startFrame: 1, samples: [0.8, 0.8]),
        ])
        let peak = mixed.map { abs($0) }.max() ?? 0
        #expect(peak <= 1.0)
        // 重ならない 0.8 と、重なった 1.6 の比（1:2）が保たれる = 切り詰めていない
        #expect(abs(mixed[1] / mixed[0] - 2.0) < 1e-5)
        #expect(abs(mixed[2] - mixed[0]) < 1e-5)
    }
}
