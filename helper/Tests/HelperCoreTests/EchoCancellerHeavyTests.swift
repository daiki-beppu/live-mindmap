import Foundation
import Testing
@testable import HelperCore

// 実際の WebRTC AEC3 の効き目。合成した信号で、参照から予測できる成分が減り、無関係な信号は残ることを確かめる。
// 評価は収束を待つため、最初の 3 秒を除いた区間で行う。
// APM の出力は入力より数 ms 遅れる（帯域分割などの内部の遅れ）。そのまま入力と比べると、無関係な信号まで消えて見えるので、
// 参照を無音にして雑音だけを通した出力から遅れを測り、その分だけ出力を進めてから比べる。

private let sampleRate = 48_000
private let seconds = 10
private let echoDelaySamples = 1_920  // 40 ms
private let echoGain: Float = 0.5  // −6 dB
private let evaluationStart = 3 * sampleRate
private let maximumOutputDelaySamples = 960  // 20 ms

/// 決定的な擬似乱数（SplitMix64）。範囲は −1〜1。
private struct DeterministicNoise {
    var state: UInt64

    mutating func next() -> Float {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Float(Double(z >> 11) / Double(1 << 53)) * 2 - 1
    }
}

/// 約 230 Hz〜2.3 kHz に帯域を絞った雑音。二乗平均平方根が `rms` になるよう正規化する。
private func bandLimitedNoise(count: Int, seed: UInt64, rms: Float) -> [Float] {
    var noise = DeterministicNoise(state: seed)
    var high: Float = 0
    var low: Float = 0
    var signal = (0..<count).map { _ -> Float in
        let x = noise.next()
        high += 0.3 * (x - high)
        low += 0.03 * (x - low)
        return high - low
    }
    let power = signal.reduce(Float(0)) { $0 + $1 * $1 } / Float(count)
    let scale = rms / power.squareRoot()
    for i in signal.indices { signal[i] *= scale }
    return signal
}

/// 発話のように、基本周波数 180 Hz の倍音（1〜8 次）が 0.2 秒ごとに入り切りする信号。`scale` は倍音の振幅。
/// 定常な雑音は、AEC3 が背景雑音として抑えるため、「残る」ことの確認には使えない。
private func harmonicBursts(count: Int, scale: Float) -> [Float] {
    (0..<count).map { index -> Float in
        guard (index / 9_600) % 2 == 0 else { return 0 }
        let time = Float(index) / Float(sampleRate)
        var value: Float = 0
        for harmonic in 1...8 { value += sin(2 * Float.pi * 180 * Float(harmonic) * time) / Float(harmonic) }
        return value * scale
    }
}

/// 参照を無音にして雑音だけをマイクに通し、出力が入力より何サンプル遅れるかを測る（相関が最大になる遅れ）。
private func measureOutputDelay() throws -> Int {
    let count = 2 * sampleRate
    let input = bandLimitedNoise(count: count, seed: 9, rms: 0.1)
    let silence = [Float](repeating: 0, count: echoTestFrameSamples)
    let canceller = try WebRTCEchoCanceller()
    var output = input
    for start in stride(from: 0, to: count, by: echoTestFrameSamples) {
        silence.withUnsafeBufferPointer { canceller.processReverse($0.baseAddress!) }
        output.withUnsafeMutableBufferPointer { canceller.processCapture($0.baseAddress! + start) }
    }
    var best = (delay: 0, energy: 0.0)
    for delay in 0...maximumOutputDelaySamples {
        var dot = 0.0
        for i in (sampleRate / 2)..<(sampleRate + sampleRate / 2) { dot += Double(output[i + delay]) * Double(input[i]) }
        if abs(dot) > best.energy { best = (delay, abs(dot)) }
    }
    return best.delay
}

/// `signal` のうち `basis` と同じ向きの成分のエネルギー（区間 `range`）。
private func projectionEnergy(_ signal: [Float], onto basis: [Float], range: Range<Int>) -> Double {
    var dot = 0.0
    var basisEnergy = 0.0
    for i in range {
        dot += Double(signal[i]) * Double(basis[i])
        basisEnergy += Double(basis[i]) * Double(basis[i])
    }
    return dot * dot / basisEnergy
}

private func decibels(_ ratio: Double) -> Double { 10 * log10(ratio) }

@Suite("エコーキャンセル（実際の WebRTC AEC3）", .timeLimit(.minutes(2)))
struct EchoCancellerHeavyTests {
    @Test("40 ms 遅れて −6 dB に減衰した参照の成分が 15 dB 以上減り、参照と無関係な信号は 10 dB 以上は減らない")
    func removesDelayedReferenceAndKeepsUnrelatedSignal() throws {
        let count = sampleRate * seconds
        let reference = bandLimitedNoise(count: count, seed: 1, rms: 0.1)
        let unrelated = harmonicBursts(count: count, scale: 0.05)  // 参照より 15 dB 前後小さい
        let echo = (0..<count).map { $0 >= echoDelaySamples ? echoGain * reference[$0 - echoDelaySamples] : 0 }
        let microphone = (0..<count).map { echo[$0] + unrelated[$0] }

        let canceller = try WebRTCEchoCanceller()
        var output = microphone
        for start in stride(from: 0, to: count, by: echoTestFrameSamples) {
            reference.withUnsafeBufferPointer { canceller.processReverse($0.baseAddress! + start) }
            output.withUnsafeMutableBufferPointer { canceller.processCapture($0.baseAddress! + start) }
        }

        let delay = try measureOutputDelay()
        let processed = (0..<count).map { $0 + delay < count ? output[$0 + delay] : 0 }
        let range = evaluationStart..<(count - maximumOutputDelaySamples)
        let echoReduction = decibels(
            projectionEnergy(microphone, onto: echo, range: range) / projectionEnergy(processed, onto: echo, range: range))
        let unrelatedReduction = decibels(
            projectionEnergy(microphone, onto: unrelated, range: range) / projectionEnergy(processed, onto: unrelated, range: range))
        #expect(echoReduction >= 15, "参照から予測できる成分の低下: \(echoReduction) dB（出力の遅れ \(delay) サンプル）")
        #expect(unrelatedReduction < 10, "無関係な信号の低下: \(unrelatedReduction) dB（出力の遅れ \(delay) サンプル）")
    }
}

/// 漏れの無い条件（参照は流れるが、マイクには発話だけが入る）で、20 秒を 1 つの canceller に連続して流し、
/// `windows` の各秒から 1 秒の窓の残り方（出力と入力のエネルギー比、dB。0 なら全部残る）を返す。
/// マイクには `speechStartSeconds` 秒まで何も入らず（参照だけが流れる）、そこから発話が始まる。
private func retentionWithoutLeak(_ canceller: WebRTCEchoCanceller, windows: [Int], speechStartSeconds: Int = 0) throws -> [Int: Double] {
    let count = sampleRate * 20
    let reference = bandLimitedNoise(count: count, seed: 1, rms: 0.1)
    var microphone = harmonicBursts(count: count, scale: 0.05)
    for index in 0..<(speechStartSeconds * sampleRate) { microphone[index] = 0 }
    var output = microphone
    for start in stride(from: 0, to: count, by: echoTestFrameSamples) {
        reference.withUnsafeBufferPointer { canceller.processReverse($0.baseAddress! + start) }
        output.withUnsafeMutableBufferPointer { canceller.processCapture($0.baseAddress! + start) }
    }
    let delay = try measureOutputDelay()
    var result: [Int: Double] = [:]
    for from in windows {
        var inputEnergy = 0.0
        var outputEnergy = 0.0
        for i in (from * sampleRate)..<((from + 1) * sampleRate) {
            inputEnergy += Double(microphone[i]) * Double(microphone[i])
            outputEnergy += Double(output[i + delay]) * Double(output[i + delay])
        }
        result[from] = decibels(outputEnergy / inputEnergy)
    }
    return result
}

@Suite("エコーキャンセルの開始直後（実際の WebRTC AEC3）", .timeLimit(.minutes(2)))
struct EchoCancellerStartupHeavyTests {
    @Test("漏れの無い条件で、発話が開始 1・2・3・5 秒に始まっても、その 1 秒の残り方が定常（15 秒）との差 3 dB 未満")
    func startupRetentionMatchesSteadyState() throws {
        for from in [1, 2, 3, 5] {
            let retention = try retentionWithoutLeak(WebRTCEchoCanceller(), windows: [from, 15], speechStartSeconds: from)
            let startup = try #require(retention[from])
            let steady = try #require(retention[15])
            #expect(abs(startup - steady) < 3, "発話の開始 \(from) 秒: \(startup) dB、定常（15 秒）: \(steady) dB")
        }
    }

    @Test("引数なしの初期化は production の設定と同じ出力を返す（本番の経路が production に届く）")
    func defaultInitUsesProductionSettings() throws {
        let byDefault = try retentionWithoutLeak(WebRTCEchoCanceller(), windows: [1, 5, 15])
        let production = try retentionWithoutLeak(WebRTCEchoCanceller(settings: .production), windows: [1, 5, 15])
        #expect(byDefault == production)
    }

    @Test("baseline の設定で作った canceller は、#118 の AEC3 の既定の挙動を保つ（開始 2 秒に始まる発話が定常より 3 dB 以上多く削られる）")
    func baselineSettingsKeepStartupSuppression() throws {
        let retention = try retentionWithoutLeak(WebRTCEchoCanceller(settings: .baseline), windows: [2, 15], speechStartSeconds: 2)
        let startup = try #require(retention[2])
        let steady = try #require(retention[15])
        #expect(steady - startup >= 3, "発話の開始 2 秒: \(startup) dB、定常（15 秒）: \(steady) dB")
    }
}
