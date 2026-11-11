import Foundation
import HelperCore

struct EchoMicrophone {
    var microphone: [Float]
    var leak: [Float]
    var utterances: [[Float]]
    var utteranceLength: Int
    var insertAt: [Int]
}

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

func insertionSamples(atSeconds: [Double], firstLineStartSeconds: Double, sampleRate: Int) -> [Int] {
    atSeconds.map { Int(((($0 - firstLineStartSeconds) * Double(sampleRate))).rounded()) }
}

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

private let maximumOutputDelaySamples = 960

/// AEC3 の出力は帯域分割などの内部の遅れで入力より遅れる。そのまま比べると、無関係な信号まで消えて見える。
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

struct WindowResult: Equatable {
    var insertAtSamples: Int
    var retentionDb: Double
    var leakReductionDb: Double
    var referenceRmsDbfs: Double
}

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

struct RecordedEchoMicrophone {
    var microphone: [Float]
    var utterance: [Float]
    var insertAt: [Int]
}

func buildMicrophone(reference: [Float], microphone: [Float], utterance: [Float], insertAt: [Int]) throws -> RecordedEchoMicrophone {
    guard !reference.isEmpty, reference.count == microphone.count else {
        throw SynthError.badScenario("参照と実マイクは空でない同じ長さの同期済み録音が必要")
    }
    let starts = insertAt.sorted()
    guard starts.allSatisfy({ $0 >= 0 && $0 <= microphone.count && utterance.count <= microphone.count - $0 }),
          zip(starts, starts.dropFirst()).allSatisfy({ $1 - $0 >= utterance.count }) else {
        throw SynthError.badScenario("発話の配置が録音の範囲外、または評価窓が重なっている")
    }
    var mixed = microphone
    for start in insertAt {
        for i in utterance.indices { mixed[start + i] += utterance[i] }
    }
    return RecordedEchoMicrophone(microphone: mixed, utterance: utterance, insertAt: insertAt)
}

func recordedRetentionDb(utterance: [Float], outputWithVoice: [Float], outputWithoutVoice: [Float], range: Range<Int>, outputDelay: Int) -> Double {
    let end = min(range.upperBound, outputWithVoice.count - outputDelay, outputWithoutVoice.count - outputDelay)
    guard end > range.lowerBound else { return .nan }
    var dot = 0.0
    var energy = 0.0
    for i in range.lowerBound..<end {
        let basis = Double(utterance[i - range.lowerBound])
        dot += (Double(outputWithVoice[i + outputDelay]) - Double(outputWithoutVoice[i + outputDelay])) * basis
        energy += basis * basis
    }
    return energy > 0 ? decibels(dot * dot / (energy * energy)) : .nan
}

struct EchoMinuteResult {
    var startSeconds: Double
    var endSeconds: Double
    var inputRmsDbfs: Double
    var outputRmsDbfs: Double
    var leakReductionDb: Double
}

func minuteResults(microphone: [Float], output: [Float], outputDelay: Int) -> [EchoMinuteResult] {
    let count = min(microphone.count, output.count - outputDelay)
    guard count > 0 else { return [] }
    return stride(from: 0, to: count, by: 60 * echoSampleRate).map { start in
        let end = min(start + 60 * echoSampleRate, count)
        var inputEnergy = 0.0
        var outputEnergy = 0.0
        for i in start..<end {
            inputEnergy += Double(microphone[i]) * Double(microphone[i])
            outputEnergy += Double(output[i + outputDelay]) * Double(output[i + outputDelay])
        }
        return EchoMinuteResult(
            startSeconds: Double(start) / Double(echoSampleRate),
            endSeconds: Double(end) / Double(echoSampleRate),
            inputRmsDbfs: decibels(inputEnergy / Double(end - start)),
            outputRmsDbfs: decibels(outputEnergy / Double(end - start)),
            leakReductionDb: decibels(inputEnergy / outputEnergy))
    }
}
