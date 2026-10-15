import Testing
@testable import HelperCore

// 録画の映像のフレームを、ライブと同じ 4 fps（`screenFramesPerSecond`）に間引く規則。フレームの時刻（PTS、秒）だけで決まる純粋な部分。

@Suite("録画の映像の間引き（4 fps）")
struct ScreenFrameThinningTests {
    private func admitted(_ times: [Double]) -> [Double] {
        var thinner = ScreenFrameThinner()
        return times.filter { thinner.admits($0) }
    }

    @Test("10 fps の映像は、どの 1 秒でも 4 枚だけ通り、最初のフレームは通る")
    func tenFramesPerSecondBecomesFour() {
        let times = (0..<50).map { Double($0) / 10 }

        let passed = admitted(times)

        #expect(passed.first == 0)
        for second in 0..<5 {
            let count = passed.filter { $0 >= Double(second) && $0 < Double(second + 1) }.count
            #expect(count == screenFramesPerSecond, "\(second) 秒台に通ったフレームの数: \(count)")
        }
    }

    @Test("30 fps の映像も、どの 1 秒でも 4 枚だけ通る。通ったフレームは 0.25 秒の格子で互いに別の枠にある")
    func thirtyFramesPerSecondBecomesFour() {
        let times = (0..<90).map { Double($0) / 30 }

        let passed = admitted(times)

        for second in 0..<3 {
            #expect(passed.filter { $0 >= Double(second) && $0 < Double(second + 1) }.count == screenFramesPerSecond)
        }
        let slots = passed.map { Int(($0 * Double(screenFramesPerSecond)).rounded(.down)) }
        #expect(Set(slots).count == slots.count)
    }

    @Test("4 fps 以下の映像は、間引かずに全部通る")
    func slowVideoIsKept() {
        #expect(admitted([0, 0.5, 1.0, 1.5, 2.0]) == [0, 0.5, 1.0, 1.5, 2.0])
        #expect(admitted([0, 0.25, 0.5, 0.75]) == [0, 0.25, 0.5, 0.75])
    }

    @Test("長い空きの後のフレームは通る。時刻が戻ったフレーム（前に通した枠以前）は通さない")
    func gapPassesAndBackwardsDoesNot() {
        #expect(admitted([0, 0.1, 5.0, 5.1]) == [0, 5.0])
        #expect(admitted([3.0, 1.0, 3.1]) == [3.0])
    }
}
