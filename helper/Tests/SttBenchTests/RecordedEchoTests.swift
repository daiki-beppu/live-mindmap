import Foundation
import HelperCore
import Testing
@testable import stt_bench

@Suite("実録音のエコー計測")
struct RecordedEchoTests {
    @Test("設定候補は production の一項目だけを変え、bypass を有効にしない", arguments: [
        "suppress-lf-0.6", "delay-hint-40", "ep-gain-0.1",
    ])
    func candidatesChangeOneProductionSetting(name: String) throws {
        let candidate = try #require(EchoCandidate(name))
        var expected = EchoCancellerSettings.production
        switch name {
        case "suppress-lf-0.6": expected.suppressorNormalMaskLfEnrSuppress = 0.6
        case "delay-hint-40": expected.streamDelayMs = 40
        case "ep-gain-0.1": expected.epStrengthDefaultGain = 0.1
        default: Issue.record("テストの候補が未定義: \(name)"); return
        }
        #expect(candidate.name == name)
        #expect(candidate.settings == expected)
        #expect(candidate.bypassSamples == 0)
    }

    @Test("既存設定の抑制閾値と未指定の遅延ヒントを保持する")
    func existingSettingsKeepNativeDefaults() {
        #expect(EchoCancellerSettings.production.epStrengthDefaultGain == 0.01)
        #expect(EchoCancellerSettings.baseline.epStrengthDefaultGain == 1)
        for settings in [EchoCancellerSettings.production, .baseline] {
            #expect(settings.suppressorNormalMaskLfEnrSuppress == 0.4)
            #expect(settings.streamDelayMs == nil)
        }
    }

    @Test("参照と比例しない実マイクを、音量と無音区間を保って使う")
    func preservesRecordedMicrophone() throws {
        let reference: [Float] = [0.8, -0.8, 0.4, -0.4, 0.2, -0.2]
        let microphone: [Float] = [0.01, 0, 0, -0.03, 0.02, 0.04]
        let built = try buildMicrophone(reference: reference, microphone: microphone, utterance: [], insertAt: [])
        #expect(built.microphone == microphone)
    }

    @Test("実マイクに発話を足しても、挿入区間の外の録音は変わらない")
    func addsVoiceToRecordedMicrophone() throws {
        let microphone: [Float] = [0.01, 0, -0.02, 0.03, 0, 0.04]
        let built = try buildMicrophone(
            reference: [Float](repeating: 0.5, count: 6), microphone: microphone,
            utterance: [0.1, -0.1], insertAt: [1, 4])
        let expected: [Float] = [0.01, 0.1, -0.02 - 0.1, 0.03, 0.1, 0.04 - 0.1]
        #expect(built.microphone.count == microphone.count)
        #expect(zip(built.microphone, expected).allSatisfy { abs($0 - $1) < 0.000001 })
    }

    @Test("長さが異なる実録音の組を黙って切り詰めない", arguments: [3, 5])
    func rejectsMismatchedRecordings(microphoneCount: Int) {
        #expect(throws: (any Error).self) {
            _ = try buildMicrophone(
                reference: [Float](repeating: 0.1, count: 4),
                microphone: [Float](repeating: 0.01, count: microphoneCount),
                utterance: [], insertAt: [])
        }
    }

    @Test("録音に収まらない発話を途中で切らない")
    func rejectsTruncatedVoice() {
        #expect(throws: (any Error).self) {
            _ = try buildMicrophone(
                reference: [Float](repeating: 0.1, count: 4),
                microphone: [Float](repeating: 0.01, count: 4),
                utterance: [0.1, -0.1], insertAt: [3])
        }
    }

    @Test("評価窓が重なる発話配置を拒否する")
    func rejectsOverlappingVoiceWindows() {
        #expect(throws: (any Error).self) {
            _ = try buildMicrophone(
                reference: [Float](repeating: 0.1, count: 8),
                microphone: [Float](repeating: 0.01, count: 8),
                utterance: [0.1, -0.1, 0.2], insertAt: [1, 3])
        }
    }

    @Test("発話と相関する漏れも、発話なし出力との差を取って保持率から除く")
    func retentionSubtractsUninjectedOutput() {
        let utterance: [Float] = [0.1, -0.1, 0.2, -0.2]
        let withoutVoice = utterance.map { $0 * 3 }
        let withVoice = zip(withoutVoice, utterance).map { $0 + $1 * 0.5 }
        let retained = recordedRetentionDb(
            utterance: utterance, outputWithVoice: withVoice, outputWithoutVoice: withoutVoice,
            range: 0..<utterance.count, outputDelay: 0)
        #expect(abs(retained - -6.0206) < 0.001)
    }

    @Test("発話なし出力との差と発話を、同じ内部出力遅延でそろえる")
    func retentionAlignsBothOutputs() {
        let utterance: [Float] = [0, 0.1, -0.2, 0.3, 0, 0]
        let withoutVoice: [Float] = [0.02, 0.03, -0.04, 0.05, 0.06, -0.07]
        let withVoice = zip(withoutVoice, utterance).map { $0 + $1 }
        let retained = recordedRetentionDb(
            utterance: Array(utterance[1..<4]),
            outputWithVoice: [0] + Array(withVoice.dropLast()),
            outputWithoutVoice: [0] + Array(withoutVoice.dropLast()),
            range: 1..<4, outputDelay: 1)
        #expect(abs(retained) < 0.001)
    }

    @Test("125 秒の録音を毎分と最後の 5 秒に分け、それぞれの入力と出力のレベルを出す")
    func measuresEveryMinuteIncludingRemainder() {
        let rate = 48_000
        let input = [Float](repeating: 0.1, count: 60 * rate)
            + [Float](repeating: 0.01, count: 60 * rate)
            + [Float](repeating: 0.001, count: 5 * rate)
        let results = minuteResults(microphone: input, output: input.map { $0 * 0.5 }, outputDelay: 0)
        #expect(results.count == 3)
        guard results.count == 3 else { return }
        #expect(results.map(\.startSeconds) == [0, 60, 120])
        #expect(results.map(\.endSeconds) == [60, 120, 125])
        for (result, expectedDbfs) in zip(results, [-20.0, -40, -60]) {
            #expect(abs(result.inputRmsDbfs - expectedDbfs) < 0.001)
            #expect(abs(result.outputRmsDbfs - (expectedDbfs - 6.0206)) < 0.001)
            #expect(abs(result.leakReductionDb - 6.0206) < 0.001)
        }
    }

    @Test("毎分の出力レベルから内部出力遅延の先頭を除く")
    func minuteLevelsCompensateOutputDelay() throws {
        let input = [Float](repeating: 0.1, count: 48_000)
        let output: [Float] = [100] + input.dropLast().map { $0 * 0.5 }
        let results = minuteResults(microphone: input, output: output, outputDelay: 1)
        try #require(results.count == 1)
        #expect(results[0].startSeconds == 0)
        #expect(abs(results[0].endSeconds * 48_000 - 48_000) <= 1)
        #expect(abs(results[0].outputRmsDbfs - -26.0206) < 0.001)
        #expect(abs(results[0].leakReductionDb - 6.0206) < 0.001)
    }
}
