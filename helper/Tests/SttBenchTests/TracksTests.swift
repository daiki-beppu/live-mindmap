import Foundation
import Testing
@testable import stt_bench

// Issue #1031: 合成会議を、進行役の行だけの 自分 トラックと、残りの 相手 トラックに分ける（stt-bench tracks）。
// ここは純粋な部分だけ（時刻表の読み込み、行の振り分け、音声ファイル名、末尾の雑音の無音化、トラックの組み立て）。ファイルは読み書きしないので CI でも流す。
// 本文は診断に出さない。

@Suite("timeline.tsv の読み込み")
struct TimelineRowsTests {
    @Test("話者・開始・終了・本文の 4 列を読み、# で始まる行（#MARK）と空行は飛ばす")
    func parsesRows() throws {
        let text = "#MARK\tslide:a\t2.00\n森川\t0.00\t2.50\tこんにちは\n\n甲\t3.00\t4.25\tはい\n"
        let rows = try parseTimelineRows(text)
        #expect(rows == [
            TimelineRow(speaker: "森川", start: 0, end: 2.5, text: "こんにちは"),
            TimelineRow(speaker: "甲", start: 3, end: 4.25, text: "はい"),
        ])
    }

    @Test("列の数や数値が不正な行は失敗にし、行番号だけを診断に出して本文は出さない")
    func brokenRowFailsWithoutBody() {
        let text = "森川\t0.00\t2.00\tOK\n甲\t3.00\tSECRETBODYTEXT\n"
        do {
            _ = try parseTimelineRows(text)
            Issue.record("失敗するはず")
        } catch {
            let message = "\(error)"
            #expect(message.contains("2"))
            #expect(!message.contains("SECRETBODYTEXT"))
        }
    }

    @Test("開始・終了が数値でない行も、行番号だけで失敗にする")
    func nonNumericTimeFails() {
        do {
            _ = try parseTimelineRows("森川\tabc\t2.00\tSECRETBODYTEXT\n")
            Issue.record("失敗するはず")
        } catch {
            #expect(!"\(error)".contains("SECRETBODYTEXT"))
        }
    }
}

@Suite("進行役の行の振り分け")
struct SplitRowsTests {
    private let rows = [
        TimelineRow(speaker: "森川", start: 0, end: 2, text: "a"),
        TimelineRow(speaker: "甲", start: 3, end: 5, text: "b"),
        TimelineRow(speaker: "森川", start: 6, end: 7, text: "c"),
        TimelineRow(speaker: "乙", start: 8, end: 9, text: "d"),
    ]

    @Test("--self の話者の行だけが 自分、残りが 相手（元の順を保つ。進行役の行は 相手 に入らない）")
    func splitsBySpeaker() throws {
        let split = try splitRows(rows, selfSpeaker: "森川")
        #expect(split.mine.map(\.text) == ["a", "c"])
        #expect(split.others.map(\.text) == ["b", "d"])
    }

    @Test("--self の話者が台本に無ければ失敗にする（空の 自分 トラックを作らない）。診断に本文を出さない")
    func unknownSelfFails() {
        do {
            _ = try splitRows(rows, selfSpeaker: "いない人")
            Issue.record("失敗するはず")
        } catch {
            #expect(!"\(error)".contains("SECRETBODYTEXT"))
        }
    }
}

@Suite("1 行 1 本の音声のファイル名")
struct LineFileNameTests {
    @Test("sha1(声 + 改行 + 文)の先頭 16 桁 + .wav（synth.mjs の fileOf と同じ）")
    func matchesSynthScript() {
        // printf 'Puck\nこんにちは' | shasum の先頭 16 桁
        #expect(lineFileName(voice: "Puck", text: "こんにちは") == "4a41939d3dcd6194.wav")
    }

    @Test("声が違えば別のファイル")
    func voiceMatters() {
        #expect(lineFileName(voice: "Kore", text: "こんにちは") != lineFileName(voice: "Puck", text: "こんにちは"))
    }
}

@Suite("行末の雑音の無音化（synth.mjs の silenceJunkTail と同じ）")
struct SilenceJunkTailTests {
    private let rate = 48000.0

    @Test("最後の 1 ms が大きいとき、その連なりを同じ長さの無音にし、手前の 10 ms を絞る（長さは変えない）")
    func silencesLoudTail() {
        // 1000 サンプルの小さな音 + 末尾 96 サンプル（2 ms）の大きな雑音。雑音は 1000 から始まる
        let samples = [Float](repeating: 0.1, count: 1000) + [Float](repeating: 0.6, count: 96)
        let out = silenceJunkTail(samples, sampleRate: rate)
        #expect(out.count == samples.count)
        #expect(out[1000...].allSatisfy { $0 == 0 })
        // 雑音の手前の 480 サンプル（10 ms）を直線的に絞る: 520 + j 番目は × (1 − (j+1)/480)
        #expect(abs(out[520] - 0.1 * (1 - 1.0 / 480)) < 1e-5)
        #expect(abs(out[759] - 0.05) < 1e-5)
        #expect(abs(out[999]) < 1e-5)
        #expect(out[0..<520].allSatisfy { abs($0 - 0.1) < 1e-6 })
    }

    @Test("最後の 1 ms が閾値（12000 / 32768）以下なら何も変えない。途中の大きな音も触らない")
    func leavesQuietTail() {
        var samples = [Float](repeating: 0.1, count: 1000)
        samples[500] = 0.9
        samples += [Float](repeating: 12000.0 / 32768.0, count: 48)
        #expect(silenceJunkTail(samples, sampleRate: rate) == samples)
    }

    @Test("連なりは大きい窓が続く間だけ（途中に静かな窓があればそこで止める）")
    func stopsAtQuietWindow() {
        // [静か 48][大きい 48][静か 48][大きい 48]: 末尾の 1 窓だけが雑音
        let samples = [Float](repeating: 0.1, count: 48) + [Float](repeating: 0.6, count: 48) + [Float](repeating: 0.1, count: 48) + [Float](repeating: 0.6, count: 48)
        let out = silenceJunkTail(samples, sampleRate: rate)
        #expect(out[144...].allSatisfy { $0 == 0 })
        // 手前の静かな窓（96..<144）は無音にならず、絞られるだけ。その手前の大きな窓も無音にならない
        #expect(out[96] > 0)
        #expect(out[48..<96].allSatisfy { $0 > 0 })
        #expect(out.count == samples.count)
    }

    @Test("1 ms より短い音声は変えない")
    func shortAudioUnchanged() {
        let samples = [Float](repeating: 0.9, count: 10)
        #expect(silenceJunkTail(samples, sampleRate: rate) == samples)
    }
}

@Suite("トラックの組み立て")
struct RenderTrackTests {
    @Test("各行を start の位置に置き、長さは指定のフレーム数（両トラックを同じ長さにするため）")
    func placesAtStart() {
        let out = renderTrack([
            PlacedSamples(startFrame: 5, samples: [0.5, 0.5]),
            PlacedSamples(startFrame: 10, samples: [0.25]),
        ], frames: 20)
        #expect(out.count == 20)
        #expect(out[5] == 0.5 && out[6] == 0.5 && out[10] == 0.25)
        #expect(out.enumerated().filter { ![5, 6, 10].contains($0.offset) }.allSatisfy { $0.element == 0 })
    }

    @Test("行が無いトラックは、指定の長さの無音")
    func emptyTrackIsSilence() {
        let out = renderTrack([], frames: 8)
        #expect(out == [Float](repeating: 0, count: 8))
    }

    @Test("開始位置のフレームは、秒 × サンプリング周波数を四捨五入する")
    func framePositionRounds() {
        #expect(framePosition(seconds: 1.5, sampleRate: 48000) == 72000)
        #expect(framePosition(seconds: 0.000011, sampleRate: 48000) == 1)
    }

    @Test("両トラックの長さは、最後の行の end + 3 秒（synth.mjs の末尾の無音）")
    func trackDurationIsLastEndPlusTail() {
        let rows = [
            TimelineRow(speaker: "甲", start: 3, end: 5, text: "b"),
            TimelineRow(speaker: "森川", start: 0, end: 2, text: "a"),
            TimelineRow(speaker: "乙", start: 8, end: 9.5, text: "d"),
        ]
        #expect(trackDuration(of: rows) == 12.5)
    }
}
