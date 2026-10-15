import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makeSession, type DiffInput } from "../src/core/index.ts";
import {
  finalDelays,
  finalRemarks,
  indexRemarks,
  lineDelays,
  parseResults,
  percentile,
  settledRemarks,
  summarize,
  type SttResult,
} from "../bench/sttLatency.ts";
import { reflectedArrivals, replayByArrival } from "../bench/sttReplay.ts";
import { logLayer, updaterLayer } from "./fixtures/sessionLayers.ts";

// 計測結果（stt-bench run の出力）の 1 行。arrival は流し始めを 0 とする壁時計、start / end は音声ファイルの秒。
const partial = (arrival: number, start: number, end: number, text: string, track: SttResult["track"] = "相手"): SttResult => ({
  track, arrival, isFinal: false, start, end, text,
});
const final = (arrival: number, start: number, end: number, text: string, track: SttResult["track"] = "相手"): SttResult => ({
  track, arrival, isFinal: true, start, end, text,
});

const T = 2; // 途中結果がこの秒数変わらなければ、確定したものとして扱う（しきい値の具体値は設計判断。テストでは固定して使う）

describe("計測結果の読み込みと集計", () => {
  it.effect("JSONL を 1 行 1 結果として読み、空行は無視する", () => Effect.gen(function* () {
    const text = [
      JSON.stringify(partial(12.34, 10.1, 12.2, "明日の")),
      "",
      JSON.stringify(final(13.5, 10.1, 12.2, "明日の会議。", "自分")),
      "",
    ].join("\n");
    expect(yield* parseResults(text)).toEqual([
      { track: "相手", arrival: 12.34, isFinal: false, start: 10.1, end: 12.2, text: "明日の" },
      { track: "自分", arrival: 13.5, isFinal: true, start: 10.1, end: 12.2, text: "明日の会議。" },
    ]);
  }));

  it.effect.each([
    { name: "JSON として読めない行", text: `${JSON.stringify(partial(1, 0, 1, "あ"))}\n{"track":` },
    { name: "形が違う行（isFinal が無い）", text: JSON.stringify({ track: "相手", arrival: 1, start: 0, end: 1, text: "あ" }) },
    { name: "形が違う行（track が相手・自分でない）", text: JSON.stringify({ ...partial(1, 0, 1, "あ"), track: "第三者" }) },
  ])("結果の行が壊れていれば（$name）、飛ばさずに失敗する", ({ text }) => Effect.gen(function* () {
    const failure = yield* Effect.flip(parseResults(text));
    expect(failure).toBeDefined();
  }));

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

// 出した時刻 at は、時計を 10ms ごとに進めて期限を拾うので、期限の時刻から 10ms 以内に出る
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.02);
const atsOf = (remarks: readonly { at: number }[]) => remarks.map((r) => r.at);

describe("途中結果を本番の区切り方で発言にする", () => {
  it("相手の途中結果に文の終わりが付いて落ち着いたら、そこで切って出す（文の終わり + 50ms）。残りは --quiet の秒数後に出る", () => {
    const remarks = settledRemarks([partial(1.0, 0, 1.0, "明日です。それで")], 1);
    expect(remarks.map((r) => [r.id, r.text])).toEqual([["r1", "明日です。"], ["r2", "それで"]]);
    near(remarks[0]!.at, 1.05);
    near(remarks[1]!.at, 2.0);
  });

  it("同じ発話の続きは、出した分の後ろだけが次の発言になる（同じ文が二重に出ない）", () => {
    const remarks = settledRemarks([partial(1.0, 0, 1.0, "明日です。"), partial(1.5, 0, 1.5, "明日です。それで")], 1);
    expect(remarks.map((r) => r.text)).toEqual(["明日です。", "それで"]);
    near(remarks[0]!.at, 1.05);
    near(remarks[1]!.at, 2.5);
  });

  it.each([{ quiet: 1, at: 4 }, { quiet: 2, at: 5 }])("文の終わりの無い途中結果は、--quiet の秒数（$quiet）だけ変わらなければ出る", ({ quiet, at }) => {
    const remarks = settledRemarks([partial(3.0, 2.0, 2.8, "はい")], quiet);
    expect(remarks.map((r) => r.text)).toEqual(["はい"]);
    near(remarks[0]!.at, at);
  });

  it("時計は途中結果の届いた時刻で進む: end が 5 で arrival が 8 の途中結果は、end から数えた 6 ではなく、arrival から数えた 9 に出る", () => {
    const remarks = settledRemarks([partial(8, 0, 5, "はい")], 1);
    expect(remarks).toHaveLength(1);
    near(remarks[0]!.at, 9);
  });

  it("途中結果が更新され続ければ、静かな間を数え直し、最後の本文で 1 件だけ出す", () => {
    const remarks = settledRemarks([partial(1.0, 0, 1.0, "はい"), partial(1.5, 0, 1.5, "はいそうですね")], 1);
    expect(remarks.map((r) => r.text)).toEqual(["はいそうですね"]);
    near(remarks[0]!.at, 2.5);
  });

  it("静かな間を超えて届いた続きは、出した分の後ろだけを別の発言にする", () => {
    const remarks = settledRemarks([partial(1.0, 0, 1.0, "はい"), partial(4.0, 0, 4.0, "はいそうですね")], 1);
    expect(remarks.map((r) => r.text)).toEqual(["はい", "そうですね"]);
    near(remarks[0]!.at, 2);
    near(remarks[1]!.at, 5);
  });

  it("本文が同じでも区間（start）が違えば別の発話として、それぞれ自分の時刻に出す", () => {
    const remarks = settledRemarks([partial(11.0, 10.0, 10.8, "はい"), partial(15.0, 14.0, 14.6, "はい")], T);
    expect(remarks.map((r) => [r.id, r.start, r.end])).toEqual([["r1", 10.0, 10.8], ["r2", 14.0, 14.6]]);
    near(remarks[0]!.at, 13);
    near(remarks[1]!.at, 17);
  });

  it("自分の途中結果からは発言を作らない（自分の途中結果だけの入力は 0 件）。相手の途中結果の発言は作る", () => {
    expect(settledRemarks([partial(1.0, 0, 1.0, "もしもし。", "自分"), partial(2.0, 0, 2.0, "はい", "自分")], 1)).toEqual([]);
    const remarks = settledRemarks([partial(11.0, 10.0, 10.8, "はい", "自分"), partial(11.2, 10.0, 10.9, "いいえ", "相手")], T);
    expect(remarks.map((r) => [r.track, r.text])).toEqual([["相手", "いいえ"]]);
    near(remarks[0]!.at, 13.2);
  });

  it("自分の確定結果は、届いた時刻にそのまま発言になる", () => {
    expect(settledRemarks([final(41, 30, 31, "単独。", "自分")], 1)).toEqual([
      { id: "r1", track: "自分", start: 30, end: 31, text: "単独。", at: 41 },
    ]);
  });

  it("T 経つ前に確定結果が届いたら、途中結果からは出さず、確定結果を届いた時刻に 1 回だけ出す", () => {
    const remarks = settledRemarks([partial(11.0, 10.0, 11.0, "明日"), final(11.5, 10.0, 12.0, "明日の会議。")], T);
    expect(remarks).toEqual([{ id: "r1", track: "相手", start: 10.0, end: 12.0, text: "明日の会議。", at: 11.5 }]);
  });

  it("途中結果から出した後に確定結果が届いても、確定結果は流さない（訂正は出ない）", () => {
    const remarks = settledRemarks([partial(12.0, 10.0, 12.0, "明日の会議"), final(20.0, 10.0, 12.0, "明日の会議は十時。")], T);
    expect(remarks.map((r) => r.text)).toEqual(["明日の会議"]);
    near(remarks[0]!.at, 14);
  });

  it("発言は { id, track, start, end, text, at } だけを持つ（words や source など本番の規則の内部の項目を漏らさない）", () => {
    for (const remark of settledRemarks([partial(1.0, 0, 1.0, "明日です。それで"), final(9, 5, 6, "後。")], 1)) {
      expect(Object.keys(remark).sort()).toEqual(["at", "end", "id", "start", "text", "track"]);
    }
  });

  describe("複数のトラック・発話・確定が混ざった列", () => {
    const results = [
      partial(1.0, 0, 2, "あ"), partial(1.5, 0, 2.5, "あい"), partial(1.2, 0, 1.5, "自分の", "自分"),
      final(2.0, 0, 2.6, "あい。"),
      partial(10, 5, 7, "うえ"), partial(14, 5, 8, "うえお"),
      final(20, 5, 8, "うえおか。"),
      final(41, 30, 31, "単独。", "自分"),
      partial(45, 40, 41, "未確定"),
      final(5.0, 0, 1.6, "自分の。", "自分"),
    ];
    const expectedOrder = [
      ["r1", "相手", "あい。", 2],
      ["r2", "自分", "自分の。", 5],
      ["r3", "相手", "うえ", 12],
      ["r4", "相手", "お", 16],
      ["r5", "自分", "単独。", 41],
      ["r6", "相手", "未確定", 47],
    ] as const;

    it("発言は出した時刻の順に並び、ID は r1… の連番で重複しない（ID から indexRemarks で引ける）", () => {
      const remarks = settledRemarks(results, T);
      expect(remarks.map((r) => [r.id, r.track, r.text])).toEqual(expectedOrder.map(([id, track, text]) => [id, track, text]));
      remarks.forEach((r, i) => near(r.at, expectedOrder[i]![3]));
      expect(atsOf(remarks)).toEqual([...atsOf(remarks)].sort((a, b) => a - b));
      expect(indexRemarks(remarks).get("r4")).toMatchObject({ start: 7, end: 8, text: "お" });
    });

    it("入力の配列と要素を書き換えず、到着の順が入れ替わっていても同じ結果になる", () => {
      const before = JSON.stringify(results);
      expect(settledRemarks([...results].reverse(), T)).toEqual(settledRemarks(results, T));
      expect(JSON.stringify(results)).toBe(before);
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
  it("途中結果の行は、本番の規則で作った発言の遅れ（出した時刻 − end）の件数・p50・p90 を出す。確定結果の行とは別の値", () => {
    // 発言の遅れ: 4-2.8=1.2、14-12.5=1.5、確定結果 40-31=9。確定結果の行は 9 だけ
    const results = [partial(3.0, 2.0, 2.8, "はい"), partial(13.0, 12.0, 12.5, "いえ"), final(40, 30, 31, "あ。")];
    const rows = summarize(results, 1).trim().split("\n");
    expect(rows[1]).toBe("| 確定結果（現状） | 1 | 9.0 | 9.0 |");
    expect(rows[2]).toMatch(/\| 3 \| 1\.5 \| 9\.0 \|$/);
  });

  it("--lines があるとき、複数の文をまとめた確定結果も、各文の話し終わりから数えた遅れで、確定・途中結果の両方の行に出る。上書きの列は無い", () => {
    const lines = [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }];
    // 3 文が 1 件の確定結果にまとまって、arrival 20 に届く（途中結果は同じ区間を更新し続け、最後の更新が 19）
    const results = [partial(5, 0, 5, "あ"), partial(19, 0, 8, "あいう"), final(20, 0, 8, "あいう。")];
    const rows = summarize(results, T, lines).trim().split("\n");
    // 遅れは 20-2, 20-5, 20-8 = 18, 15, 12 → p50 15.0, p90 18.0。確定結果の end（8）から数えた 12 だけではない
    expect(rows[0]).toBe("| 方式 | 件数 | 遅れ p50 (秒) | 遅れ p90 (秒) |");
    expect(rows[1]).toBe("| 確定結果（現状） | 3 | 15.0 | 18.0 |");
    expect(rows).toHaveLength(3);
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
    const remarks = settledRemarks([partial(11.0, 10.0, 10.8, "はい"), partial(15.0, 14.0, 14.6, "はい")], T);
    const byId = indexRemarks(remarks);
    expect(byId.get("r2")).toMatchObject({ start: 14.0, end: 14.6 });
    near(byId.get("r2")!.at, 17.0);
  });

  it("同じ ID が 2 回出たら例外にする（ぶつかったまま遅れを数えない）", () => {
    const dup = { track: "相手" as const, start: 0, end: 1, text: "はい", at: 2 };
    expect(() => indexRemarks([{ id: "r1", ...dup }, { id: "r1", ...dup }])).toThrow(/r1/);
  });
});

describe("届いた時刻で本番のセッションに流す", () => {
  const items = [
    { id: "r1", track: "相手" as const, start: 0.5, end: 2.0, text: "a", at: 10.0 },
    { id: "r2", track: "相手" as const, start: 2.0, end: 3.0, text: "b", at: 10.5 },
    { id: "r3", track: "自分" as const, start: 3.0, end: 4.0, text: "c", at: 14.0 },
  ];

  const setup = (events: string[]) =>
    makeSession({ title: "定例" }).pipe(
      Effect.provide(
        Layer.merge(
          updaterLayer((input: DiffInput) =>
            Effect.sync(() => {
              events.push(`diff:${input.fresh.map((u) => u.id).join("+")}`);
              return { ops: [] };
            }),
          ),
          logLayer((e) =>
            Effect.sync(() => {
              if (e.type === "remark") events.push(`push:${e.remark.id}`);
            }),
          ),
        ),
      ),
    );

  it.effect("発言の end ではなく届いた時刻（at）の差だけ待ってから流す（最初は 0 からの差）", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const sleeps: number[] = [];
      yield* replayByArrival(yield* setup(events), items, { sleep: (ms) => Effect.sync(() => void sleeps.push(Math.round(ms))) });
      expect(sleeps).toEqual([10_000, 500, 3_500]);
    }));

  it.effect("待ってから流す順で、流した発言は最後に取りこぼさず差分更新に渡る", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      yield* replayByArrival(yield* setup(events), items, { sleep: () => Effect.void });
      expect(events.filter((s) => s.startsWith("push:"))).toEqual(["push:r1", "push:r2", "push:r3"]);
      const diffed = events.filter((s) => s.startsWith("diff:")).join("+").replaceAll("diff:", "").split("+");
      expect(diffed.sort()).toEqual(["r1", "r2", "r3"]);
    }));

  it.effect("セッションに渡す発言は、Remark の項目だけ（計測用の at や source を混ぜない）", () =>
    Effect.gen(function* () {
      const pushed: unknown[] = [];
      const session = yield* makeSession({ title: "定例" }).pipe(
        Effect.provide(
          Layer.merge(
            updaterLayer(() => Effect.succeed({ ops: [] })),
            logLayer((e) =>
              Effect.sync(() => {
                if (e.type === "remark") pushed.push(e.remark);
              }),
            ),
          ),
        ),
      );
      yield* replayByArrival(session, [{ ...items[0]!, source: "final" }], { sleep: () => Effect.void });
      expect(pushed).toEqual([{ id: "r1", track: "相手", start: 0.5, end: 2.0, text: "a" }]);
    }));
});
