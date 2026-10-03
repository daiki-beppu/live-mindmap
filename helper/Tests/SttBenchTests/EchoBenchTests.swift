import AVFoundation
import Foundation
import HelperCore
import Testing
@testable import stt_bench

// `stt-bench echo` の純粋な部分。本物の AEC3 も `say` も使わず、偽の canceller で固定する。
// 本物の AEC3 を通した数字は、調査文書（docs/investigations/2026-10-03-aec-startup-double-talk.md）に記録する。
// 偽の canceller は HelperCore の `EchoCanceller`（public）に準拠させる。

private let frame = 480
private let rate = 48_000

/// 周期がサンプル数に対して整数になる正弦波（1 秒 = 48 000 サンプルの中で周波数の整数倍で閉じる）。
/// 周波数の違う正弦波どうしは、1 秒の整数倍の区間で厳密に直交するので、成分の分離を厳密に確かめられる。
private func sine(count: Int, hz: Double, amplitude: Float) -> [Float] {
    (0..<count).map { amplitude * Float(sin(2 * Double.pi * hz * Double($0) / Double(rate))) }
}

/// capture をそのまま返す。呼び出しの履歴を残す。
private final class RecordingCanceller: EchoCanceller, @unchecked Sendable {
    enum Call: Equatable { case reverse(first: Float, count: Int), capture(first: Float, count: Int) }
    private(set) var calls: [Call] = []
    let captureScale: Float
    init(captureScale: Float = 1) { self.captureScale = captureScale }

    func processReverse(_ frame: UnsafePointer<Float>) {
        calls.append(.reverse(first: frame[0], count: 480))
    }

    func processCapture(_ frame: UnsafeMutablePointer<Float>) {
        calls.append(.capture(first: frame[0], count: 480))
        for i in 0..<480 { frame[i] *= captureScale }
    }
}

/// capture を `delaySamples` サンプル遅らせて返す（AEC3 の内部の遅れの代わり）。
private final class DelayingCanceller: EchoCanceller, @unchecked Sendable {
    private var pending: [Float]
    init(delaySamples: Int) { pending = [Float](repeating: 0, count: delaySamples) }

    func processReverse(_ frame: UnsafePointer<Float>) {}

    func processCapture(_ frame: UnsafeMutablePointer<Float>) {
        pending.append(contentsOf: UnsafeBufferPointer(start: frame, count: 480))
        for i in 0..<480 { frame[i] = pending[i] }
        pending.removeFirst(480)
    }
}

@Suite("エコー計測: マイク信号の組み立て")
struct BuildMicrophoneTests {
    @Test("漏れは mic[i] = gain * ref[i - d]、i < d では 0。発話が無い区間のマイクは漏れだけになる")
    func leakIsDelayedAndAttenuated() {
        let reference = (0..<1_000).map { Float($0 + 1) }
        let built = buildMicrophone(reference: reference, utterance: [1, 1], delaySamples: 10, leakGain: 0.25, insertAt: [500])
        #expect(built.microphone.count == reference.count)
        for i in 0..<10 { #expect(built.leak[i] == 0) }
        for i in [10, 11, 100, 499, 502, 999] { #expect(built.leak[i] == 0.25 * reference[i - 10]) }
        #expect(built.microphone[100] == built.leak[100])
    }

    @Test("発話は指定した各位置に足され、基準信号は発話だけが入った同じ長さの列になる")
    func utterancesPlacedAtEachInsertionPoint() {
        let reference = [Float](repeating: 1, count: 100)
        let built = buildMicrophone(reference: reference, utterance: [2, 3, 4], delaySamples: 5, leakGain: 0.5, insertAt: [10, 50])
        #expect(built.utterances.count == 2)
        #expect(built.utterances[0].count == reference.count)
        #expect(Array(built.utterances[0][10..<13]) == [2, 3, 4])
        #expect(Array(built.utterances[1][50..<53]) == [2, 3, 4])
        #expect(built.utterances[0].enumerated().allSatisfy { ($0.offset < 10 || $0.offset >= 13) ? $0.element == 0 : true })
        for i in 0..<reference.count {
            #expect(built.microphone[i] == built.leak[i] + built.utterances[0][i] + built.utterances[1][i])
        }
    }

    @Test("漏れの減衰 0 なら、マイクは発話だけになる（対照条件）")
    func zeroLeakGainGivesUtterancesOnly() {
        let reference = [Float](repeating: 1, count: 40)
        let built = buildMicrophone(reference: reference, utterance: [7], delaySamples: 3, leakGain: 0, insertAt: [20])
        #expect(built.leak.allSatisfy { $0 == 0 })
        #expect(built.microphone[20] == 7)
        #expect(built.microphone[21] == 0)
    }

    @Test("挿入位置は、台本の最初の行の start が指定秒に来るように決まる（先頭の無音を補正する）")
    func insertionSamplesCompensateLeadingSilence() {
        let samples = insertionSamples(atSeconds: [5, 30, 60], firstLineStartSeconds: 1.0, sampleRate: rate)
        #expect(samples == [4 * rate, 29 * rate, 59 * rate])
    }
}

@Suite("エコー計測: 1 インスタンスでの連続処理")
struct RunCancellerTests {
    @Test("reverse → capture を 480 サンプルずつ、全区間で交互に同じインスタンスへ渡し、渡す内容は入力そのもの")
    func feedsFramesInOrderToOneInstance() {
        let reference = (0..<(frame * 4)).map { Float($0) }
        let microphone = (0..<(frame * 4)).map { Float($0) + 0.5 }
        let canceller = RecordingCanceller()
        let output = runCanceller(canceller, reference: reference, microphone: microphone, bypassSamples: 0)
        #expect(output == microphone)
        #expect(canceller.calls == (0..<4).flatMap { k -> [RecordingCanceller.Call] in
            [.reverse(first: Float(k * frame), count: frame), .capture(first: Float(k * frame) + 0.5, count: frame)]
        })
    }

    @Test("bypass 区間は出力 = 入力のまま、しかも AEC には全区間を渡して収束を進める。それより後は処理結果になる")
    func bypassKeepsInputButStillFeedsCanceller() {
        let count = frame * 6
        let reference = [Float](repeating: 0.1, count: count)
        let microphone = (0..<count).map { Float($0 % 97) + 1 }
        let canceller = RecordingCanceller(captureScale: 0.5)
        let output = runCanceller(canceller, reference: reference, microphone: microphone, bypassSamples: frame * 2)
        #expect(Array(output[0..<(frame * 2)]) == Array(microphone[0..<(frame * 2)]))
        #expect(Array(output[(frame * 2)...]) == microphone[(frame * 2)...].map { $0 * 0.5 })
        let captures = canceller.calls.filter { if case .capture = $0 { return true } else { return false } }
        #expect(captures.count == 6)
        #expect(canceller.calls.count == 12)
        // bypass 区間の capture にも、元のマイク信号がそのまま渡っている
        #expect(captures[0] == .capture(first: microphone[0], count: frame))
        #expect(captures[1] == .capture(first: microphone[frame], count: frame))
    }

    @Test("bypass 区間の出力には、outputDelay の補正に合わせた遅れを付けられる（補正後に入力と揃う）")
    func bypassOutputCanCarryOutputDelay() {
        let count = frame * 4
        let microphone = (0..<count).map { Float($0 + 1) }
        let output = runCanceller(RecordingCanceller(), reference: [Float](repeating: 0, count: count), microphone: microphone,
                                  bypassSamples: frame * 2, bypassDelaySamples: 100)
        #expect(Array(output[0..<100]) == [Float](repeating: 0, count: 100))
        #expect(Array(output[100..<(frame * 2)]) == Array(microphone[0..<(frame * 2 - 100)]))
        #expect(Array(output[(frame * 2)...]) == Array(microphone[(frame * 2)...]))
    }

    @Test("出力の長さは入力のマイクと同じ")
    func outputLengthMatchesMicrophone() {
        let output = runCanceller(RecordingCanceller(), reference: [Float](repeating: 0, count: frame * 3),
                                  microphone: [Float](repeating: 1, count: frame * 3), bypassSamples: 0)
        #expect(output.count == frame * 3)
    }
}

@Suite("エコー計測: 候補と wav")
struct EchoCandidateTests {
    @Test("候補名は baseline、production、bypass-<有限な 0 以上の秒> だけ")
    func parsesCandidates() {
        #expect(EchoCandidate("baseline") == .baseline)
        #expect(EchoCandidate("bypass-3") == .bypass(seconds: 3))
        #expect(EchoCandidate("bypass-inf") == nil)
        #expect(EchoCandidate("bypass--1") == nil)
        #expect(EchoCandidate("other") == nil)
    }

    @Test("production は本番の設定（EchoCancellerSettings.production）で動かし、名前を往復できる")
    func productionUsesProductionSettings() {
        #expect(EchoCandidate("production") == .production)
        #expect(EchoCandidate.production.name == "production")
        #expect(EchoCandidate.production.settings == .production)
        #expect(EchoCandidate.production.bypassSamples == 0)
    }

    @Test("baseline と bypass は #118 の設定（EchoCancellerSettings.baseline）で動かす")
    func baselineAndBypassUseBaselineSettings() {
        #expect(EchoCandidate.baseline.settings == .baseline)
        #expect(EchoCandidate.bypass(seconds: 3).settings == .baseline)
    }

    @Test("bypass 区間の出力に出力の遅れを付ければ、遅れを補正した窓の残り方は 0 dB になる（runCanceller → windowResults の結合）")
    func bypassWindowIsAlignedAfterCompensation() throws {
        let seconds = 4
        let count = rate * seconds
        let reference = sine(count: count, hz: 1_000, amplitude: 0.1)
        let built = buildMicrophone(reference: reference, utterance: sine(count: rate, hz: 440, amplitude: 0.1),
                                    delaySamples: 1_920, leakGain: 0.3, insertAt: [rate])
        let delay = 137
        let output = runCanceller(DelayingCanceller(delaySamples: delay), reference: reference, microphone: built.microphone,
                                  bypassSamples: 3 * rate, bypassDelaySamples: delay)
        let aligned = windowResults(built: built, output: output, outputDelay: delay, reference: reference)
        #expect(abs(aligned[0].retentionDb) < 0.1, "残り方: \(aligned[0].retentionDb) dB")
        let unaligned = runCanceller(DelayingCanceller(delaySamples: delay), reference: reference, microphone: built.microphone, bypassSamples: 3 * rate)
        #expect(abs(windowResults(built: built, output: unaligned, outputDelay: delay, reference: reference)[0].retentionDb) > 0.5)
    }

    @Test("writeWav は指定したサンプルレートで書き、読み戻すと同じレートと長さになる")
    func writeWavUsesGivenSampleRate() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("echo-bench-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        try writeWav(sine(count: rate, hz: 440, amplitude: 0.1), to: url, sampleRate: Double(rate))
        let file = try AVAudioFile(forReading: url)
        #expect(file.processingFormat.sampleRate == Double(rate))
        #expect(file.length == AVAudioFramePosition(rate))
    }
}

@Suite("エコー計測: 出力の遅れと残り方の数字")
struct WindowResultsTests {
    private let seconds = 4
    private var count: Int { rate * seconds }

    private func scenario(leakGain: Float) -> (reference: [Float], built: EchoMicrophone) {
        let reference = sine(count: count, hz: 1_000, amplitude: 0.1)
        let utterance = sine(count: rate, hz: 440, amplitude: 0.1)  // 1 秒
        let built = buildMicrophone(reference: reference, utterance: utterance, delaySamples: 1_920, leakGain: leakGain, insertAt: [rate, 3 * rate])
        return (reference, built)
    }

    @Test("出力の遅れの測定: 参照を無音にして雑音を通し、相関が最大になる遅れを返す")
    func measuresOutputDelay() throws {
        #expect(try measureOutputDelay(makeCanceller: { DelayingCanceller(delaySamples: 0) }) == 0)
        #expect(try measureOutputDelay(makeCanceller: { DelayingCanceller(delaySamples: 137) }) == 137)
    }

    @Test("何も消さない canceller なら、発話の残り方は 0 dB、漏れの低下量は 0 dB")
    func identityKeepsEverything() throws {
        let (reference, built) = scenario(leakGain: 0.3)
        let output = runCanceller(RecordingCanceller(), reference: reference, microphone: built.microphone, bypassSamples: 0)
        let results = windowResults(built: built, output: output, outputDelay: 0, reference: reference)
        #expect(results.count == 2)
        for result in results {
            #expect(abs(result.retentionDb) < 0.05, "残り方: \(result.retentionDb) dB")
            #expect(abs(result.leakReductionDb) < 0.05, "漏れの低下量: \(result.leakReductionDb) dB")
        }
    }

    @Test("振幅を半分にする canceller なら、発話の残り方も漏れの低下量も約 6.02 dB（符号は残り方が負、低下量が正）")
    func halvingGivesSixDecibels() throws {
        let (reference, built) = scenario(leakGain: 0.3)
        let output = runCanceller(RecordingCanceller(captureScale: 0.5), reference: reference, microphone: built.microphone, bypassSamples: 0)
        let results = windowResults(built: built, output: output, outputDelay: 0, reference: reference)
        for result in results {
            #expect(abs(result.retentionDb - -6.0206) < 0.1, "残り方: \(result.retentionDb) dB")
            #expect(abs(result.leakReductionDb - 6.0206) < 0.1, "漏れの低下量: \(result.leakReductionDb) dB")
        }
    }

    @Test("出力が遅れていても、outputDelay で補正すれば残り方は 0 dB に戻る（補正しないと崩れる）")
    func compensatesOutputDelay() throws {
        let (reference, built) = scenario(leakGain: 0.3)
        let delay = 137
        let output = runCanceller(DelayingCanceller(delaySamples: delay), reference: reference, microphone: built.microphone, bypassSamples: 0)
        let compensated = windowResults(built: built, output: output, outputDelay: delay, reference: reference)
        for result in compensated { #expect(abs(result.retentionDb) < 0.1, "補正後の残り方: \(result.retentionDb) dB") }
        let uncompensated = windowResults(built: built, output: output, outputDelay: 0, reference: reference)
        #expect(uncompensated.contains { abs($0.retentionDb) > 0.5 })
    }

    @Test("挿入時刻ごとに別の結果が返り、時刻と、その区間の参照の RMS（dBFS）が付く")
    func perInsertionResultHasTimeAndReferenceLevel() throws {
        let (reference, built) = scenario(leakGain: 0.3)
        let output = runCanceller(RecordingCanceller(), reference: reference, microphone: built.microphone, bypassSamples: 0)
        let results = windowResults(built: built, output: output, outputDelay: 0, reference: reference)
        #expect(results.map(\.insertAtSamples) == [rate, 3 * rate])
        // 振幅 0.1 の正弦波の RMS は 0.1/√2 → 約 −23.01 dBFS
        for result in results { #expect(abs(result.referenceRmsDbfs - -23.0103) < 0.1, "参照: \(result.referenceRmsDbfs) dBFS") }
    }

    @Test("発話の残り方は、区間の外の信号に影響されない（別の挿入位置の発話を混ぜても、その区間の数字は変わらない）")
    func windowIgnoresOtherInsertions() throws {
        let (reference, built) = scenario(leakGain: 0)
        // 1 回目の発話だけを半分にして、2 回目はそのままにする出力
        var output = built.microphone
        for i in rate..<(2 * rate) { output[i] *= 0.5 }
        let results = windowResults(built: built, output: output, outputDelay: 0, reference: reference)
        #expect(abs(results[0].retentionDb - -6.0206) < 0.1)
        #expect(abs(results[1].retentionDb) < 0.1)
    }
}
