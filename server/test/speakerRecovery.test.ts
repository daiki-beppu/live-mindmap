import { describe, expect, it } from "@effect/vitest";
import { assignSpeakers, scoreAttribution, scoreMixing, scoreRelinking } from "../bench/speakerAccuracy.ts";

const truth = (speaker: string, start: number, end: number) => ({ speaker, start, end });
const segment = (arrival: number, slot: number, start: number, end: number) => ({ arrival, slot, start, end });
const said = (start: number, end: number, speaker: string) => ({ track: "相手", start, end, speaker });
const self = "進行役";

describe("混入の検出の集計", () => {
  it("第2位がちょうど10%なら当たりにし、確定区間の開始からの遅延の偶数中央値を取る", () => {
    const result = scoreMixing({
      self, origin: 0, restarts: [],
      timeline: [truth(self, 0, 100), truth("甲", 0, 9), truth("乙", 9, 10), truth("甲", 20, 29), truth("乙", 29, 30)],
      segments: [segment(8, 0, 0, 8), segment(10, 0, 8, 10), segment(29, 1, 20, 29), segment(30, 1, 29, 30)],
      mixed: [{ slot: 0, at: 10 }, { slot: 1, at: 35 }],
    });

    expect(result).toEqual({ people: 2, detected: 2, hits: 2, falsePositives: 0, medianDelay: 4 });
  });

  it("第2位が10%未満なら誤検出とし、当たりがなければ遅延を持たない", () => {
    const result = scoreMixing({
      self, origin: 0, restarts: [],
      timeline: [truth(self, 20, 30), truth("甲", 0, 9.1), truth("乙", 9.1, 10)],
      segments: [segment(10, 0, 0, 10)], mixed: [{ slot: 0, at: 11 }],
    });

    expect(result).toEqual({ people: 2, detected: 1, hits: 0, falsePositives: 1, medianDelay: undefined });
  });

  it("検出時点に届いていない確定区間と別の枠を当たりに使わない", () => {
    const result = scoreMixing({
      self, origin: 0, restarts: [],
      timeline: [truth("甲", 0, 8), truth("乙", 8, 10)],
      segments: [segment(1, 0, 0, 8), segment(2, 1, 8, 10), segment(20, 0, 8, 10)],
      mixed: [{ slot: 0, at: 10 }, { slot: 0, at: 21 }],
    });

    expect(result).toEqual({ people: 2, detected: 2, hits: 1, falsePositives: 1, medianDelay: 13 });
  });

  it("遅延は最終的に第2位になった人の最初の確定区間から取り、奇数中央値を取る", () => {
    const result = scoreMixing({
      self, origin: 0, restarts: [],
      timeline: [
        truth("甲", 0, 10), truth("乙", 10, 12), truth("丙", 12, 13), truth("乙", 13, 18),
        truth("甲", 20, 30), truth("乙", 30, 32), truth("甲", 35, 40), truth("乙", 40, 42),
      ],
      segments: [
        segment(10, 0, 0, 10), segment(12, 0, 10, 12), segment(13, 0, 12, 13), segment(18, 0, 13, 18),
        segment(30, 1, 20, 30), segment(32, 1, 30, 32), segment(40, 2, 35, 40), segment(42, 2, 40, 42),
      ],
      mixed: [{ slot: 0, at: 20 }, { slot: 1, at: 32 }, { slot: 2, at: 44 }],
    });

    expect(result).toEqual({ people: 3, detected: 3, hits: 3, falsePositives: 0, medianDelay: 4 });
  });

  it("再起動前の同じ番号の枠の区間を、再起動後の検出に混ぜない", () => {
    const result = scoreMixing({
      self, origin: 100, restarts: [{ at: 10, source: "flag" }],
      timeline: [truth("甲", 0, 5), truth("乙", 5, 10)],
      segments: [segment(105, 0, 0, 5), segment(110, 0, 5, 10)],
      mixed: [{ slot: 0, at: 111 }],
    });

    expect(result).toEqual({ people: 2, detected: 1, hits: 0, falsePositives: 1, medianDelay: undefined });
  });

  it("混入なしでも台本の重複を除いた相手の人数を出す", () => {
    expect(scoreMixing({
      self, origin: 0, restarts: [], segments: [], mixed: [],
      timeline: [truth(self, 0, 1), truth("甲", 1, 2), truth("甲", 2, 3), truth("乙", 3, 4)],
    })).toEqual({ people: 2, detected: 0, hits: 0, falsePositives: 0, medianDelay: undefined });
  });
});

describe("再起動後のつなぎ直しの集計", () => {
  const timeline = [truth(self, 90, 100), truth("甲", 0, 50), truth("乙", 50, 60)];
  const remarks = [said(0, 20, "相手 A"), said(50, 60, "相手 B")];

  it("枠の最後の記録で4分類し、対応なしラベル・reverted・記録なし・重なりなしを区別する", () => {
    const result = scoreRelinking({
      self, timeline, personOf: assignSpeakers({ self, timeline, remarks }), origin: 0, restarts: [{ at: 10, source: "flag" }],
      segments: [0, 1, 2, 3, 4, 5].map((slot) => segment(11, slot, 20, 22)).concat([segment(11, 6, 80, 82), segment(11, 7, 90, 92)]),
      links: [
        { at: 12, slot: 0, result: "new" },
        { at: 13, slot: 0, result: "linked", label: "相手 A" },
        { at: 12, slot: 1, result: "linked", label: "相手 B" },
        { at: 12, slot: 2, result: "linked", label: "対応しないラベル" },
        { at: 12, slot: 3, result: "new" },
        { at: 12, slot: 4, result: "reverted", label: "相手 A" },
        { at: 12, slot: 6, result: "new" },
        { at: 12, slot: 7, result: "new" },
      ],
    });

    expect(result).toEqual({ correct: 1, wrong: 2, new: 1, none: 2 });
  });

  it("枠の人は全区間の重なりを足して決め、再起動前の同じ枠とlinkを引き継がない", () => {
    const result = scoreRelinking({
      self, timeline, personOf: assignSpeakers({ self, timeline, remarks }), origin: 100, restarts: [{ at: 10, source: "flag" }],
      segments: [segment(105, 0, 50, 60), segment(110, 0, 20, 22), segment(111, 0, 23, 25), segment(112, 0, 50, 53), segment(112, 1, 25, 27)],
      links: [{ at: 106, slot: 1, result: "new" }, { at: 113, slot: 0, result: "linked", label: "相手 A" }],
    });

    expect(result).toEqual({ correct: 1, wrong: 0, new: 0, none: 1 });
  });

  it("会議全体の1対1対応を使い、枠ごとの最大や再起動後だけの対応で付け直さない", () => {
    const input = {
      self,
      timeline: [truth(self, 100, 101), truth("甲", 0, 3), truth("乙", 10, 12), truth("甲", 20, 23)],
      remarks: [said(0, 3, "相手 X"), said(10, 12, "相手 X"), said(20, 23, "相手 Y")],
    };

    const personOf = assignSpeakers(input);
    expect([...personOf]).toEqual([["相手 X", "乙"], ["相手 Y", "甲"]]);
    expect(scoreAttribution({ ...input, personOf })).toMatchObject({ correct: 2, wrong: 1 });
    expect(scoreRelinking({
      ...input, personOf, origin: 0, restarts: [{ at: 10, source: "flag" }],
      segments: [segment(11, 0, 0, 3), segment(21, 1, 10, 12)],
      links: [{ at: 12, slot: 0, result: "linked", label: "相手 X" }, { at: 22, slot: 1, result: "linked", label: "相手 Y" }],
    })).toEqual({ correct: 0, wrong: 2, new: 0, none: 0 });
  });

  it("再起動がなければ適用なし、再起動後に枠がなければ4分類とも0件", () => {
    const input = { self, timeline, personOf: assignSpeakers({ self, timeline, remarks }), origin: 0, segments: [], links: [] };

    expect(scoreRelinking({ ...input, restarts: [] })).toBeUndefined();
    expect(scoreRelinking({ ...input, restarts: [{ at: 10, source: "flag" }] })).toEqual({ correct: 0, wrong: 0, new: 0, none: 0 });
  });
});
