import { describe, expect, it } from "vitest";
import { createSession, type DiffInput } from "../src/core/index.ts";
import {
  finalDelays,
  finalRemarks,
  indexRemarks,
  lineDelays,
  parseResults,
  percentile,
  settleVolatile,
  summarize,
  type SttResult,
} from "../bench/sttLatency.ts";
import { reflectedArrivals, replayByArrival } from "../bench/sttReplay.ts";

// 計測結果（stt-bench run の出力）の 1 行。arrival は流し始めを 0 とする壁時計、start / end は音声ファイルの秒。
const partial = (arrival: number, start: number, end: number, text: string, track: SttResult["track"] = "相手"): SttResult => ({
  track, arrival, isFinal: false, start, end, text,
});
const final = (arrival: number, start: number, end: number, text: string, track: SttResult["track"] = "相手"): SttResult => ({
  track, arrival, isFinal: true, start, end, text,
});

const T = 2; // 途中結果がこの秒数変わらなければ、確定したものとして扱う（しきい値の具体値は設計判断。テストでは固定して使う）

describe("計測結果の読み込みと集計", () => {
  it("JSONL を 1 行 1 結果として読み、空行は無視する", () => {
    const text = [
      JSON.stringify(partial(12.34, 10.1, 12.2, "明日の")),
      "",
      JSON.stringify(final(13.5, 10.1, 12.2, "明日の会議。", "自分")),
      "",
    ].join("\n");
    expect(parseResults(text)).toEqual([
      { track: "相手", arrival: 12.34, isFinal: false, start: 10.1, end: 12.2, text: "明日の" },
      { track: "自分", arrival: 13.5, isFinal: true, start: 10.1, end: 12.2, text: "明日の会議。" },
    ]);
  });

  it("確定までの遅れは、確定結果だけを数え、届いた時刻 − 発言の end で測る", () => {
    const results = [
      partial(11.0, 10.0, 10.8, "明日の"),
      final(19.0, 10.0, 10.8, "明日の会議。"), // 8.2
      partial(20.0, 21.0, 21.5, "はい"),
      final(23.0, 21.0, 21.5, "はい。"), // 1.5
    ];
    expect(finalDelays(results).map((d) => Math.round(d * 10) / 10)).toEqual([8.2, 1.5]);
  });

  it("分位点は、整列した値の floor(p × 件数) 番目（最大を超えない）。空なら NaN で、入力は並べ替えない", () => {
    const xs = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const copy = [...xs];
    expect(percentile(xs, 0.5)).toBe(6);
    expect(percentile(xs, 0.9)).toBe(10);
    expect(percentile(xs, 1)).toBe(10);
    expect(xs).toEqual(copy);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe("途中結果が T 秒変わらなければ確定として扱う", () => {
  it("同じ区間の途中結果が更新され続けた後、最後に届いた時刻 + T に、最後の本文・区間で 1 件だけ出す", () => {
    const { remarks } = settleVolatile(
      [partial(11.0, 10.0, 11.2, "明日の"), partial(11.5, 10.0, 11.9, "明日の会議")],
      { quietSeconds: T, lateFinal: "discard" },
    );
    expect(remarks).toEqual([
      { id: "r1", track: "相手", start: 10.0, end: 11.9, text: "明日の会議", at: 13.5, source: "stable" },
    ]);
  });

  it("T 経つ前に同じ区間の新しい途中結果が届けば、T を数え直す（言い直しで本文が変わっても同じ発話の更新）", () => {
    const { remarks } = settleVolatile(
      [partial(11.0, 10.0, 11.0, "はい、そうですね"), partial(12.5, 10.0, 11.0, "はい、そう")],
      { quietSeconds: T, lateFinal: "discard" },
    );
    expect(remarks).toHaveLength(1);
    expect(remarks[0]).toMatchObject({ text: "はい、そう", at: 14.5 });
  });

  it("本文が同じでも区間（start）が違えば別の発話として、それぞれ自分の時刻に出し、ID は連番で重複しない", () => {
    const { remarks } = settleVolatile(
      [partial(11.0, 10.0, 10.8, "はい"), partial(15.0, 14.0, 14.6, "はい")],
      { quietSeconds: T, lateFinal: "discard" },
    );
    expect(remarks.map((r) => [r.id, r.start, r.at])).toEqual([
      ["r1", 10.0, 13.0],
      ["r2", 14.0, 17.0],
    ]);
  });

  it("トラックが違えば、start が同じでも別の発話", () => {
    const { remarks } = settleVolatile(
      [partial(11.0, 10.0, 10.8, "はい", "自分"), partial(11.2, 10.0, 10.9, "いいえ", "相手")],
      { quietSeconds: T, lateFinal: "discard" },
    );
    expect(remarks.map((r) => [r.track, r.text, r.at]).sort()).toEqual([
      ["相手", "いいえ", 13.2],
      ["自分", "はい", 13.0],
    ].sort());
  });

  it("更新の間隔が T を超えたら、そこで出し、後の途中結果は別の発話として数える", () => {
    const { remarks } = settleVolatile(
      [partial(11.0, 10.0, 11.0, "明日の"), partial(15.0, 10.0, 12.0, "明日の会議")],
      { quietSeconds: T, lateFinal: "discard" },
    );
    expect(remarks.map((r) => [r.id, r.text, r.at])).toEqual([
      ["r1", "明日の", 13.0],
      ["r2", "明日の会議", 17.0],
    ]);
  });

  it("T 経つ前に確定結果が届いたら、途中結果からは出さず、確定結果を届いた時刻に 1 回だけ出す", () => {
    for (const lateFinal of ["discard", "correct"] as const) {
      const { remarks, overwritten } = settleVolatile(
        [partial(11.0, 10.0, 11.0, "明日"), final(11.5, 10.0, 12.0, "明日の会議。")],
        { quietSeconds: T, lateFinal },
      );
      expect(remarks).toEqual([
        { id: "r1", track: "相手", start: 10.0, end: 12.0, text: "明日の会議。", at: 11.5, source: "final" },
      ]);
      expect(overwritten).toBe(0);
    }
  });

  describe("確定結果が、出したあとに届いたとき", () => {
    // 2 つの途中結果の区間（10.0〜12.0 と 14.0〜15.5）をまたぐ 1 件の確定結果
    const stream = [
      partial(11.0, 10.0, 12.0, "明日の会議"),
      partial(15.0, 14.0, 15.5, "はい"),
      final(20.0, 10.0, 15.5, "明日の会議は十時。はい。"),
    ];

    it("捨てる: 追加で何も流さず、文字が違った確定結果を 1 件として数える", () => {
      const { remarks, overwritten } = settleVolatile(stream, { quietSeconds: T, lateFinal: "discard" });
      expect(remarks.map((r) => [r.id, r.source, r.at])).toEqual([
        ["r1", "stable", 13.0],
        ["r2", "stable", 17.0],
      ]);
      expect(overwritten).toBe(1);
    });

    it("訂正として流す: またいだ確定結果は、対応する発言すべてに対して 1 件だけ、届いた時刻に流す", () => {
      const { remarks, overwritten } = settleVolatile(stream, { quietSeconds: T, lateFinal: "correct" });
      expect(remarks).toHaveLength(3);
      expect(remarks[2]).toEqual({
        id: "r3", track: "相手", start: 10.0, end: 15.5, text: "明日の会議は十時。はい。", at: 20.0, source: "correction",
      });
      expect(overwritten).toBe(1);
    });

    it("先に出した発言の一部だけが覆われ、残りの発話が T 前なら、その発話を確定の届いた時刻に出す", () => {
      const { remarks } = settleVolatile(
        [
          partial(11.0, 10.0, 12.0, "明日の会議"),
          partial(19.5, 14.0, 16.0, "はい"),
          final(20.0, 10.0, 16.0, "明日の会議。はい。"),
        ],
        { quietSeconds: T, lateFinal: "discard" },
      );
      expect(remarks.map((r) => [r.start, r.at])).toEqual([[10.0, 13.0], [14.0, 20.0]]);
      // 後着の確定本文は流さず、どちらも途中結果の本文で出す
      expect(remarks.map((r) => [r.text, r.source])).toEqual([["明日の会議", "stable"], ["はい", "stable"]]);
    });

    it("どちらの規則でも、本文が同じ確定結果は訂正に数えず、何も流さない", () => {
      for (const lateFinal of ["discard", "correct"] as const) {
        const { remarks, overwritten } = settleVolatile(
          [partial(11.0, 10.0, 12.0, "明日の会議"), final(20.0, 10.0, 12.0, "明日の会議")],
          { quietSeconds: T, lateFinal },
        );
        expect(remarks).toHaveLength(1);
        expect(overwritten).toBe(0);
      }
    });
  });
});

describe("文ごとの話し終わりからの遅れ", () => {
  it("行の区間の中央を覆う発言のうち、最初に届いたものまでの時間 − 行の end。覆う発言がない行は数えない", () => {
    const lines = [{ start: 1, end: 3 }, { start: 3.5, end: 4.5 }, { start: 30, end: 31 }];
    const arrivals = [{ start: 1, end: 4.5, at: 12 }, { start: 0, end: 5, at: 15 }];
    expect(lineDelays(lines, arrivals)).toEqual([9, 7.5]);
  });
});

describe("集計の表", () => {
  it("--lines があるとき、複数の文をまとめた確定結果も、各文の話し終わりから数えた遅れで、確定・途中結果の両方の行に出る", () => {
    const lines = [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }];
    // 3 文が 1 件の確定結果にまとまって、arrival 20 に届く（途中結果は同じ区間を更新し続け、最後の更新が 19）
    const results = [partial(5, 0, 5, "あ"), partial(19, 0, 8, "あいう"), final(20, 0, 8, "あいう。")];
    const rows = summarize(results, T, lines).trim().split("\n");
    // 遅れは 20-2, 20-5, 20-8 = 18, 15, 12 → p50 15.0, p90 18.0。確定結果の end（8）から数えた 12 だけではない
    expect(rows[1]).toBe("| 確定結果（現状） | 3 | 15.0 | 18.0 |  |");
    expect(rows[2]).toContain("| 3 |");
  });
});

describe("ノードに反映された時刻", () => {
  const items = [
    { id: "r1", track: "相手" as const, start: 0, end: 2, text: "a" },
    { id: "r2", track: "相手" as const, start: 3, end: 5, text: "b" },
  ];

  it("ノードを足す・更新する操作の根拠に挙がった発言だけを、その差分更新の終わりの時刻で数える（ops が空の更新は数えない）", () => {
    const diffs = [
      { ops: [] },
      { ops: [{ op: "noop" }] },
      { ops: [{ op: "add", evidence: ["r1"] }] },
      { ops: [{ op: "update", evidence: ["r1", "r2"] }] },
    ];
    expect(reflectedArrivals(diffs, [10, 11, 12, 13], items)).toEqual([
      { start: 0, end: 2, at: 12 },
      { start: 3, end: 5, at: 13 },
    ]);
  });

  it("適用されず捨てられた操作（dropped）の根拠は、ノードに出ていないので数えない", () => {
    const op = { op: "add", evidence: ["r1"] };
    expect(reflectedArrivals([{ ops: [op], dropped: [{ op }] }], [10], items)).toEqual([]);
  });

  it("失敗した差分更新は数えない", () => {
    expect(reflectedArrivals([{ ops: [{ op: "add", evidence: ["r1"] }], error: "x" }], [10], items)).toEqual([]);
  });

  it("同じ ID の発言が 2 件ある入力は、集計せずに例外で止まる", () => {
    const dup = [
      { id: "r3", track: "相手" as const, start: 0, end: 2, text: "a" },
      { id: "r3", track: "相手" as const, start: 3, end: 5, text: "b" },
    ];
    expect(() => reflectedArrivals([{ ops: [{ op: "add", evidence: ["r3"] }] }], [10], dup)).toThrow(/r3/);
  });
});

describe("確定結果より後に届いた途中結果", () => {
  it("確定結果が覆った発話には加わらず、同じ区間の後の途中結果は別の発話として T 後に出る", () => {
    const { remarks } = settleVolatile(
      [partial(11.0, 10.0, 10.8, "はい"), final(11.5, 10.0, 10.8, "はい。"), partial(12.0, 10.0, 11.5, "はいそれで")],
      { quietSeconds: T, lateFinal: "discard" },
    );
    expect(remarks.map((r) => [r.text, r.at, r.source])).toEqual([
      ["はい。", 11.5, "final"],
      ["はいそれで", 14.0, "stable"],
    ]);
  });
});

describe("現状（確定結果だけ）の発言", () => {
  it("途中結果は流さず、確定結果を届いた順の連番 ID・届いた時刻で出す", () => {
    const remarks = finalRemarks([partial(1, 0, 1, "あ"), final(9, 5, 6, "後"), final(5, 0, 1, "先")]);
    expect(remarks.map((r) => [r.id, r.text, r.at, r.source])).toEqual([
      ["r1", "先", 5, "final"],
      ["r2", "後", 9, "final"],
    ]);
  });
});

describe("発言の ID から元の区間を引く", () => {
  it("ID から、元の区間（start / end）と出した時刻を引ける", () => {
    const { remarks } = settleVolatile(
      [partial(11.0, 10.0, 10.8, "はい"), partial(15.0, 14.0, 14.6, "はい")],
      { quietSeconds: T, lateFinal: "discard" },
    );
    const byId = indexRemarks(remarks);
    expect(byId.get("r2")).toMatchObject({ start: 14.0, end: 14.6, at: 17.0 });
  });

  it("同じ ID が 2 回出たら例外にする（ぶつかったまま遅れを数えない）", () => {
    const dup = { track: "相手" as const, start: 0, end: 1, text: "はい", at: 2, source: "stable" as const };
    expect(() => indexRemarks([{ id: "r1", ...dup }, { id: "r1", ...dup }])).toThrow(/r1/);
  });
});

describe("届いた時刻で本番のセッションに流す", () => {
  const items = [
    { id: "r1", track: "相手" as const, start: 0.5, end: 2.0, text: "a", at: 10.0 },
    { id: "r2", track: "相手" as const, start: 2.0, end: 3.0, text: "b", at: 10.5 },
    { id: "r3", track: "自分" as const, start: 3.0, end: 4.0, text: "c", at: 14.0 },
  ];

  function setup(events: string[]) {
    return createSession({
      title: "定例",
      updater: async (input: DiffInput) => {
        events.push(`diff:${input.fresh.map((u) => u.id).join("+")}`);
        return { ops: [] };
      },
      log: (e) => {
        if (e.type === "remark") events.push(`push:${e.remark.id}`);
      },
    });
  }

  it("発言の end ではなく届いた時刻（at）の差だけ待ってから流す（最初は 0 からの差）", async () => {
    const events: string[] = [];
    const sleeps: number[] = [];
    await replayByArrival(setup(events), items, { sleep: async (ms) => void sleeps.push(Math.round(ms)) });
    expect(sleeps).toEqual([10_000, 500, 3_500]);
  });

  it("待ってから流す順で、流した発言は最後に取りこぼさず差分更新に渡る", async () => {
    const events: string[] = [];
    await replayByArrival(setup(events), items, { sleep: async () => {} });
    expect(events.filter((s) => s.startsWith("push:"))).toEqual(["push:r1", "push:r2", "push:r3"]);
    const diffed = events.filter((s) => s.startsWith("diff:")).join("+").replaceAll("diff:", "").split("+");
    expect(diffed.sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("セッションに渡す発言は、Remark の項目だけ（計測用の at や source を混ぜない）", async () => {
    const pushed: unknown[] = [];
    const session = createSession({
      title: "定例",
      updater: async () => ({ ops: [] }),
      log: (e) => {
        if (e.type === "remark") pushed.push(e.remark);
      },
    });
    await replayByArrival(session, [{ ...items[0]!, source: "stable" }], { sleep: async () => {} });
    expect(pushed).toEqual([{ id: "r1", track: "相手", start: 0.5, end: 2.0, text: "a" }]);
  });
});
