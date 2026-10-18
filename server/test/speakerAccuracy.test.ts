import { describe, expect, it } from "@effect/vitest";
import { assignOneToOne, computeDer, countUnsplit, groundTruthSpeaker, scoreAttribution, tentativeChangeRate } from "../bench/speakerAccuracy.ts";

// Issue #1031: Eval speakerAccuracy の計算（純関数）。
// 正解の人の決め方、ラベルと人の 1 対 1 の対応、分類（正解 / 取り違え / 話者なし）、DER（collar 0.25 秒）、
// 仮から確定で枠が替わった割合、切れなかった発言の数。CLI の出力と本文を出さないことは speakerAccuracy.it.test.ts。

const truth = (speaker: string, start: number, end: number) => ({ speaker, start, end });
const said = (start: number, end: number, speaker?: string, track: "相手" | "自分" = "相手") => ({ track, start, end, ...(speaker === undefined ? {} : { speaker }) });

describe("正解の人（発言の区間と最も長く重なる人）", () => {
  it("2 人にまたがる発言は、先に重なった人ではなく、長く重なる人", () => {
    expect(groundTruthSpeaker({ start: 0, end: 10 }, [truth("A", 0, 1), truth("B", 1, 10)])).toBe("B");
  });

  it("同じ人の複数の行は重なりを足して比べる（1 行ずつの最大ではない）", () => {
    expect(groundTruthSpeaker({ start: 0, end: 9 }, [truth("A", 0, 3), truth("B", 3, 6), truth("A", 6, 9)])).toBe("A");
  });

  it("区間の外にある行は数えない", () => {
    expect(groundTruthSpeaker({ start: 5, end: 7 }, [truth("A", 0, 5.5), truth("B", 6, 100), truth("C", 0, 4)])).toBe("B");
  });

  it("重なる行がなければ正解の人なし（端が接するだけも重ならない）", () => {
    expect(groundTruthSpeaker({ start: 0, end: 2 }, [truth("A", 2, 4), truth("B", 10, 12)])).toBeUndefined();
    expect(groundTruthSpeaker({ start: 0, end: 2 }, [])).toBeUndefined();
  });
});

describe("ラベルと人の 1 対 1 の対応（重なりの合計が最大）", () => {
  it("貪欲に行ごとの最大を選ばず、合計が最大の割り当てにする（[[3,2],[3,0]] は 0→1・1→0 の合計 5）", () => {
    expect(assignOneToOne([[3, 2], [3, 0]])).toEqual([1, 0]);
  });

  it("同じ人に 2 つのラベルを対応させない", () => {
    const result = assignOneToOne([[5, 1], [6, 0]]);

    expect(new Set(result.filter((c) => c !== undefined)).size).toBe(result.filter((c) => c !== undefined).length);
    expect(result).toEqual([1, 0]);
  });

  it("ラベルが人より多いと、余ったラベルは対応なし（重なりの合計が最大になるラベルが残る）", () => {
    expect(assignOneToOne([[4, 0], [0, 3], [1, 1]])).toEqual([0, 1, undefined]);
  });

  it("人がラベルより多くても、各ラベルは別の人に対応する", () => {
    expect(assignOneToOne([[1, 5, 0], [0, 4, 3]])).toEqual([1, 2]);
  });

  it("重なりが全くないラベルは対応なし", () => {
    expect(assignOneToOne([[0, 0], [2, 0]])).toEqual([undefined, 0]);
  });

  it("空の表は空の対応", () => {
    expect(assignOneToOne([])).toEqual([]);
  });
});

describe("分類（正解 / 取り違え / 話者なし）", () => {
  const timeline = [truth("森川", 0, 2), truth("甲", 3, 5), truth("乙", 6, 8)];

  it("対応したラベルが正解の人なら正解。--self の発言と 自分 トラックの発言は採点しない", () => {
    const result = scoreAttribution({ self: "森川", timeline, remarks: [said(0, 2, "自分", "自分"), said(3, 5, "相手 A"), said(6, 8, "相手 B")] });

    expect([result.correct, result.wrong, result.none, result.noTruth]).toEqual([2, 0, 0, 0]);
    expect(result.rates).toEqual({ correct: 1, wrong: 0, none: 0 });
  });

  it("ラベルの名前ではなく会議全体の対応で比べる（相手 A が乙、相手 B が甲に当たっていても、一貫していれば正解）", () => {
    const result = scoreAttribution({
      self: "森川",
      timeline: [truth("森川", 0, 1), truth("甲", 3, 5), truth("乙", 6, 8), truth("甲", 10, 12), truth("乙", 14, 16)],
      remarks: [said(3, 5, "相手 B"), said(6, 8, "相手 A"), said(10, 12, "相手 B"), said(14, 16, "相手 A")],
    });

    expect([result.correct, result.wrong]).toEqual([4, 0]);
  });

  it("1 発言ごとに対応を取り直さない: 対応は会議全体で 1 つ。合計が最大の対応で数える（貪欲な対応は 正解 1・取り違え 2）", () => {
    // 相手 X: 甲 3 秒 + 乙 2 秒、相手 Y: 甲 3 秒。X→乙・Y→甲（合計 5）が最大
    const result = scoreAttribution({
      self: "森川",
      timeline: [truth("森川", 100, 101), truth("甲", 0, 3), truth("乙", 10, 12), truth("甲", 20, 23)],
      remarks: [said(0, 3, "相手 X"), said(10, 12, "相手 X"), said(20, 23, "相手 Y")],
    });

    expect([result.correct, result.wrong, result.none]).toEqual([2, 1, 0]);
  });

  it("話者なしは取り違えに数えず、別に数える", () => {
    const result = scoreAttribution({ self: "森川", timeline, remarks: [said(3, 5, "相手 A"), said(6, 8)] });

    expect([result.correct, result.wrong, result.none]).toEqual([1, 0, 1]);
    expect(result.rates).toEqual({ correct: 0.5, wrong: 0, none: 0.5 });
  });

  it("人と対応できなかったラベル（ラベルが人より多い）の発言は取り違え", () => {
    const result = scoreAttribution({
      self: "森川",
      timeline: [truth("森川", 100, 101), truth("甲", 0, 3), truth("乙", 10, 13), truth("甲", 20, 21)],
      remarks: [said(0, 3, "相手 A"), said(10, 13, "相手 B"), said(20, 21, "相手 C")],
    });

    expect([result.correct, result.wrong, result.none]).toEqual([2, 1, 0]);
  });

  it("別の人と対応したラベルの発言は取り違え", () => {
    const result = scoreAttribution({ self: "森川", timeline, remarks: [said(3, 5, "相手 A"), said(6, 7, "相手 A")] });

    expect([result.correct, result.wrong, result.none]).toEqual([1, 1, 0]);
  });

  it("正解の人なしの発言（--self の行にしか重ならない・どの行にも重ならない）は、数えた上で割合の分母から外す。話者なしでも同じ", () => {
    const result = scoreAttribution({ self: "森川", timeline, remarks: [said(3, 5, "相手 A"), said(0.5, 1.5, "相手 B"), said(20, 21, "相手 A"), said(30, 31)] });

    expect([result.correct, result.wrong, result.none, result.noTruth]).toEqual([1, 0, 0, 3]);
    expect(result.rates).toEqual({ correct: 1, wrong: 0, none: 0 });
  });

  it("正解の人なしの発言のラベルは、ラベルと人の対応に影響しない", () => {
    const result = scoreAttribution({
      self: "森川",
      timeline,
      remarks: [said(3, 5, "相手 A"), said(20, 30, "相手 B"), said(6, 8, "相手 B")],
    });

    expect([result.correct, result.wrong, result.noTruth]).toEqual([2, 0, 1]);
  });
});

describe("DER（collar 0.25 秒）", () => {
  const ref = (...rows: Array<[string, number, number]>) => rows.map(([speaker, start, end]) => truth(speaker, start, end));
  const hyp = (...rows: Array<[number, number, number]>) => rows.map(([slot, start, end]) => ({ slot, start, end }));

  it("完全に一致すれば 0（枠の番号と人の名前は別物。対応は重なり最大で取る）", () => {
    const result = computeDer({ reference: ref(["A", 0, 10], ["B", 10, 20]), hypothesis: hyp([5, 0, 10], [3, 10, 20]) });

    expect(result.der).toBeCloseTo(0, 5);
    expect([result.missedSeconds, result.falseAlarmSeconds, result.confusionSeconds].map((s) => Math.round(s * 10))).toEqual([0, 0, 0]);
  });

  it("境から 0.2 秒ずれた仮説は collar の内側なので 0", () => {
    const result = computeDer({ reference: ref(["A", 0, 10], ["B", 10, 20]), hypothesis: hyp([0, 0, 10.2], [1, 10.2, 20]) });

    expect(result.der).toBeCloseTo(0, 5);
  });

  it("境から 1 秒ずれると、collar の外の 0.75 秒が付け間違い（採点する参照は collar 1.0 秒を除いた 19 秒）", () => {
    const result = computeDer({ reference: ref(["A", 0, 10], ["B", 10, 20]), hypothesis: hyp([0, 0, 11], [1, 11, 20]) });

    expect(result.confusionSeconds).toBeCloseTo(0.75, 1);
    expect(result.referenceSeconds).toBeCloseTo(19, 1);
    expect(result.der).toBeCloseTo(0.75 / 19, 2);
  });

  it("仮説が無ければ取りこぼし（collar を除いた 9.5 秒すべて）で DER 1", () => {
    const result = computeDer({ reference: ref(["A", 0, 10]), hypothesis: [] });

    expect(result.missedSeconds).toBeCloseTo(9.5, 1);
    expect(result.der).toBeCloseTo(1, 2);
  });

  it("参照に無い区間の検出は余計な検出", () => {
    const result = computeDer({ reference: ref(["A", 0, 10]), hypothesis: hyp([0, 0, 20]) });

    expect(result.falseAlarmSeconds).toBeCloseTo(9.75, 1);
    expect(result.der).toBeCloseTo(9.75 / 9.5, 2);
  });

  it("人と対応できなかった枠は付け間違い（1 人を 2 つの枠に割ると、短い方の枠の分）", () => {
    const result = computeDer({ reference: ref(["A", 0, 10]), hypothesis: hyp([0, 0, 6], [1, 6, 10]) });

    expect(result.confusionSeconds).toBeCloseTo(3.75, 1);
    expect(result.der).toBeCloseTo(3.75 / 9.5, 2);
  });

  it("collar の幅は 0.25 秒: 境から 0.3 秒ずれた分は collar の外で付け間違いになる", () => {
    const result = computeDer({ reference: ref(["A", 0, 10], ["B", 10, 20]), hypothesis: hyp([0, 0, 10.3], [1, 10.3, 20]) });

    expect(result.confusionSeconds).toBeGreaterThan(0.03);
    expect(result.confusionSeconds).toBeLessThan(0.07);
  });
});

describe("仮のラベルが確定で替わった割合", () => {
  // 仮のラベルは replayOffline が付ける（speakerReplay.test.ts で確かめる）。ここでは、ラベルの比較と分母の扱いを確かめる
  it("仮のラベルと確定のラベルが同じなら替わっていない。違えば替わった", () => {
    const result = tentativeChangeRate({
      remarks: [{ tentative: "相手 A", speaker: "相手 A" }, { tentative: "相手 B", speaker: "相手 A" }, { tentative: "相手 A", speaker: "相手 B" }],
    });

    expect(result).toEqual({ changed: 2, total: 3 });
  });

  it("仮のラベルか確定のラベルが無い発言（話者なしを含む）は分母に入れない", () => {
    const result = tentativeChangeRate({
      remarks: [{ speaker: "相手 A" }, { tentative: "相手 A" }, {}, { tentative: "相手 A", speaker: "相手 A" }],
    });

    expect(result).toEqual({ changed: 0, total: 1 });
  });

  it("発言が無ければ 0 件", () => {
    expect(tentativeChangeRate({ remarks: [] })).toEqual({ changed: 0, total: 0 });
  });
});

describe("切れなかった発言（正解では 2 人以上と重なる断片）", () => {
  const lines = [truth("森川", 20, 22), truth("A", 0, 2), truth("B", 2, 4), truth("A", 10, 11.8), truth("B", 11.8, 12), truth("A", 22, 24), truth("B", 30, 30.5), truth("C", 30.5, 32)];

  it("2 人と重なる発言を数える", () => {
    expect(countUnsplit({ self: "森川", timeline: lines, remarks: [said(0, 4, "相手 A")] })).toBe(1);
  });

  it("重なりが短い人も数える（本番の 0.5 秒の下限を採点に持ち込まない）", () => {
    expect(countUnsplit({ self: "森川", timeline: lines, remarks: [said(10, 12, "相手 A")] })).toBe(1);
  });

  it("端が接するだけの人は数えない", () => {
    expect(countUnsplit({ self: "森川", timeline: lines, remarks: [said(0, 2, "相手 A")] })).toBe(0);
  });

  it("--self の行は人に数えない（自分と相手 1 人にまたがる発言は切れなかった発言ではない）", () => {
    expect(countUnsplit({ self: "森川", timeline: lines, remarks: [said(20, 24, "相手 A")] })).toBe(0);
  });

  it("1 人の発言、話者なしの発言も、正解で 2 人にまたがれば数える。自分 トラックの発言は数えない", () => {
    expect(countUnsplit({ self: "森川", timeline: lines, remarks: [said(0, 2, "相手 A"), said(0, 4), said(0, 4, "自分", "自分")] })).toBe(1);
  });
});
