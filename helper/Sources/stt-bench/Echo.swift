import Foundation
import HelperCore

// AEC3（`WebRTCEchoCanceller`）が、開始直後に話者の声（ダブルトーク）を削るかを測る部分（Issue #118）。
// ファイルの入出力は EchoRun.swift。ここは、配列だけで決まる純粋な部分。
//
// 1 つの条件（遅れ・漏れの減衰・候補）につき canceller を 1 つだけ作り、
// 会議の音を参照にして、遅れと減衰をかけた漏れ + 既知の発話（開始 5 / 30 / 60 秒など）を 1 本の連続した流れで通す。
// 発話の残り方は、出力を入力の遅れだけ進めたうえで、元の発話と同じ向きの成分のエネルギーで比べる
// （手法は Tests/HelperCoreTests/EchoCancellerHeavyTests.swift と同じ）。

/// 合成したマイクの信号。`leak` と `utterances` は、`microphone` に足した成分そのもの（全長）。
struct EchoMicrophone {
    var microphone: [Float]
    var leak: [Float]
    /// 挿入位置ごとの発話。発話だけが入った、`microphone` と同じ長さの列。
    var utterances: [[Float]]
    var utteranceLength: Int
    var insertAt: [Int]
}

/// 漏れ `leak[i] = gain * reference[i - d]`（i < d では 0）と、`insertAt` の各位置に置いた発話を足したマイクの信号を作る。
func buildMicrophone(reference: [Float], utterance: [Float], delaySamples: Int, leakGain: Float, insertAt: [Int]) -> EchoMicrophone {
    let count = reference.count
    var leak = [Float](repeating: 0, count: count)
    if delaySamples < count {
        for i in delaySamples..<count { leak[i] = leakGain * reference[i - delaySamples] }
    }
    var microphone = leak
    var utterances: [[Float]] = []
    for start in insertAt {
        var placed = [Float](repeating: 0, count: count)
        for (i, sample) in utterance.enumerated() where start + i < count { placed[start + i] = sample }
        for i in 0..<count { microphone[i] += placed[i] }
        utterances.append(placed)
    }
    return EchoMicrophone(microphone: microphone, leak: leak, utterances: utterances, utteranceLength: utterance.count, insertAt: insertAt)
}

/// 台本の最初の行の start が `atSeconds` に来るようにする、発話の置き始め（先頭の無音の分だけ早める）。
func insertionSamples(atSeconds: [Double], firstLineStartSeconds: Double, sampleRate: Int) -> [Int] {
    atSeconds.map { Int(((($0 - firstLineStartSeconds) * Double(sampleRate))).rounded()) }
}

/// 1 つの canceller に、10 ms（480 サンプル）ごとに reverse → capture を渡し、全区間を連続して処理する。
/// 先頭 `bypassSamples` 未満の区間は、AEC にはそのまま渡して収束を進めるが、返す出力は入力のまま（AEC をかけない候補）。
/// 端数のフレームは 0 で埋めて渡し、出力は `microphone` と同じ長さにする。
/// `windowResults` は出力を `outputDelay` だけ進めて比べるので、AEC をかけない区間の出力にも同じ遅れを付ける（`bypassDelaySamples`）。
func runCanceller(_ canceller: some EchoCanceller, reference: [Float], microphone: [Float], bypassSamples: Int, bypassDelaySamples: Int = 0) -> [Float] {
    var output = microphone
    for i in 0..<min(bypassSamples, microphone.count) { output[i] = i >= bypassDelaySamples ? microphone[i - bypassDelaySamples] : 0 }
    var referenceFrame = [Float](repeating: 0, count: echoFrameSamples)
    var captureFrame = [Float](repeating: 0, count: echoFrameSamples)
    for start in stride(from: 0, to: microphone.count, by: echoFrameSamples) {
        for i in 0..<echoFrameSamples {
            referenceFrame[i] = start + i < reference.count ? reference[start + i] : 0
            captureFrame[i] = start + i < microphone.count ? microphone[start + i] : 0
        }
        referenceFrame.withUnsafeBufferPointer { canceller.processReverse($0.baseAddress!) }
        captureFrame.withUnsafeMutableBufferPointer { canceller.processCapture($0.baseAddress!) }
        for i in 0..<echoFrameSamples where start + i < microphone.count && start + i >= bypassSamples {
            output[start + i] = captureFrame[i]
        }
    }
    return output
}

// MARK: 出力の遅れ

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

private let maximumOutputDelaySamples = 960  // 20 ms

/// 参照を無音にして雑音だけをマイクに通し、出力が入力より何サンプル遅れるかを測る（相関が最大になる遅れ）。
/// AEC3 の出力は帯域分割などの内部の遅れで入力より遅れる。そのまま比べると、無関係な信号まで消えて見える。
/// `correlationSamples` は相関を取る区間の長さ。本番は既定の 1 秒を使う。
func measureOutputDelay(correlationSamples: Int = echoSampleRate, makeCanceller: () throws -> any EchoCanceller) throws -> Int {
    let count = 2 * echoSampleRate
    var noise = DeterministicNoise(state: 9)
    var high: Float = 0
    var low: Float = 0
    var input = (0..<count).map { _ -> Float in
        let x = noise.next()
        high += 0.3 * (x - high)
        low += 0.03 * (x - low)
        return high - low
    }
    let power = input.reduce(Float(0)) { $0 + $1 * $1 } / Float(count)
    let scale = 0.1 / power.squareRoot()
    for i in input.indices { input[i] *= scale }

    let output = runCanceller(try makeCanceller(), reference: [Float](repeating: 0, count: count), microphone: input, bypassSamples: 0)
    var best = (delay: 0, energy: 0.0)
    for delay in 0...maximumOutputDelaySamples {
        var dot = 0.0
        for i in (echoSampleRate / 2)..<(echoSampleRate / 2 + correlationSamples) { dot += Double(output[i + delay]) * Double(input[i]) }
        if abs(dot) > best.energy { best = (delay, abs(dot)) }
    }
    return best.delay
}

// MARK: 窓ごとの数字

struct WindowResult: Equatable {
    var insertAtSamples: Int
    /// 発話の成分のエネルギーが、出力でどれだけ残ったか（dB。0 なら全部残る、負なら削られた）。
    var retentionDb: Double
    /// 同じ区間の漏れの成分のエネルギーが、どれだけ下がったか（dB。正なら下がった）。漏れが無い条件では nan。
    var leakReductionDb: Double
    /// その区間の参照の RMS（dBFS）。
    var referenceRmsDbfs: Double
}

/// `signal` のうち `basis` と同じ向きの成分のエネルギー（区間 `range`）。
private func projectionEnergy(_ signal: [Float], onto basis: [Float], range: Range<Int>) -> Double {
    var dot = 0.0
    var basisEnergy = 0.0
    for i in range {
        dot += Double(signal[i]) * Double(basis[i])
        basisEnergy += Double(basis[i]) * Double(basis[i])
    }
    return basisEnergy > 0 ? dot * dot / basisEnergy : 0
}

private func decibels(_ ratio: Double) -> Double { 10 * log10(ratio) }

/// 挿入位置ごとに、その位置から発話の長さ分の窓で、発話の残り方・漏れの低下量・参照の RMS を求める。
/// 出力は `outputDelay` サンプル進めてから比べる。他の挿入位置の発話は、窓の外なので影響しない。
func windowResults(built: EchoMicrophone, output: [Float], outputDelay: Int, reference: [Float]) -> [WindowResult] {
    let count = built.microphone.count
    let processed = (0..<count).map { $0 + outputDelay < output.count ? output[$0 + outputDelay] : 0 }
    return built.insertAt.enumerated().map { index, start in
        let range = start..<min(start + built.utteranceLength, count - outputDelay, count)
        let utterance = built.utterances[index]
        let retained = projectionEnergy(processed, onto: utterance, range: range)
        let original = projectionEnergy(utterance, onto: utterance, range: range)
        let micLeak = projectionEnergy(built.microphone, onto: built.leak, range: range)
        let outLeak = projectionEnergy(processed, onto: built.leak, range: range)
        let referenceEnergy = range.reduce(0.0) { $0 + Double(reference[$1]) * Double(reference[$1]) }
        return WindowResult(
            insertAtSamples: start,
            retentionDb: decibels(retained / original),
            leakReductionDb: micLeak > 0 ? decibels(micLeak / outLeak) : .nan,
            referenceRmsDbfs: decibels(referenceEnergy / Double(range.count)))
    }
}
