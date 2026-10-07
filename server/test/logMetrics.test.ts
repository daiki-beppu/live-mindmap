// eval の 3 指標（本文の書き換え・1 ノードの書き換えの最多・話し中の兄弟の最多）の数え方。偽の差分の列で確かめる。
import { describe, expect, it } from "vitest";
import { type Dropped, type LogEvent, type Op } from "../src/core/index.ts";
import { logMetrics } from "../src/core/logMetrics.ts";

type Step = { ops: Op[]; error?: string };

// start の後に、diff ごとに発言 1 件（r1, r2, …）を積み、その発言を fresh として diff の行を並べる
function log(steps: Step[], extraRemarks = 0): LogEvent[] {
  const events: LogEvent[] = [{ type: "start", title: "講演" }];
  steps.forEach((step, i) => {
    const id = `r${i + 1}`;
    events.push({ type: "remark", remark: { id, track: "相手", start: i * 10, end: i * 10 + 9, text: `発言 ${i + 1}` } });
    events.push({
      type: "diff",
      input: { recent: [], fresh: [id], nodeCount: 0 },
      ops: step.ops,
      dropped: [] as Dropped[],
      ...(step.error === undefined ? {} : { error: step.error }),
    });
  });
  for (let k = 0; k < extraRemarks; k++) {
    events.push({ type: "remark", remark: { id: `x${k}`, track: "自分", start: 500 + k, end: 501 + k, text: "", duplicate: true } });
  }
  return events;
}

// n(番号) は適用順に振られる id（最初の add が n1）
const add = (ref: string, parent: string, kind: Extract<Op, { op: "add" }>["kind"], text: string, evidence = ["r1"]): Op => ({ op: "add", ref, parent, kind, text, evidence });
const update = (node: string, evidence: string[], more: { text?: string; planStatus?: "検討中" | "却下" } = {}): Op => ({ op: "update", node, evidence, ...more });
const close = (node: string): Op => ({ op: "close", node });

describe("logMetrics: 本文の書き換え", () => {
  it("本文が変わった update だけを書き換えと数える。根拠だけ・同じ本文・状態だけ・捨てられた update は数えない", () => {
    const m = logMetrics(log([
      { ops: [add("t1", "root", "議題", "取り組み"), add("t2", "t1", "要点", "辞書を育てる"), add("t3", "t1", "案", "週次で見直す")] },
      {
        ops: [
          update("n2", ["r2"]), // 根拠だけ（text を渡さない）
          update("n2", ["r2"], { text: "辞書を育てる" }), // 同じ本文
          update("n3", ["r2"], { planStatus: "却下" }), // 状態だけ
          update("n2", ["r999"], { text: "捨てられる本文" }), // 知らない発言が根拠なので applyOps が捨てる
          update("n99", ["r2"], { text: "対象が無い" }), // 対象が無いので捨てられる
        ],
      },
    ]));

    expect(m.rewrites).toBe(0);
    expect(m.maxRewritesPerNode).toBe(0);
  });

  it("本文が実際に変わった update は 1 回と数える。同じ応答で add した ref への update も数える", () => {
    const m = logMetrics(log([
      { ops: [add("t1", "root", "議題", "取り組み"), add("t2", "t1", "要点", "辞書を育てる")] },
      { ops: [update("n2", ["r2"], { text: "辞書を毎週育てる" })] },
      { ops: [add("t9", "n1", "要点", "初版"), update("t9", ["r3"], { text: "改訂版" })] },
    ]));

    expect(m.rewrites).toBe(2);
  });

  it("1 つのノードへの書き換えの最多は、ノードごとの回数の最大。全体の回数とは別に出る", () => {
    const m = logMetrics(log([
      { ops: [add("t1", "root", "議題", "取り組み"), add("t2", "t1", "要点", "a"), add("t3", "t1", "要点", "b")] },
      { ops: [update("n2", ["r2"], { text: "a1" }), update("n3", ["r2"], { text: "b1" })] },
      { ops: [update("n2", ["r3"], { text: "a2" })] },
      { ops: [update("n2", ["r4"], { text: "a3" }), update("n2", ["r4"], { text: "a3" })] }, // 2 つ目は同じ本文
    ]));

    expect(m.rewrites).toBe(4);
    expect(m.maxRewritesPerNode).toBe(3);
  });

  it("書き換えの数は、diff の行の ops の数ではなくログを順に当て直した結果で決まる（error の diff も ops を当てる）", () => {
    const m = logMetrics(log([
      { ops: [add("t1", "root", "議題", "取り組み"), add("t2", "t1", "要点", "a")] },
      { ops: [update("n2", ["r2"], { text: "a1" })], error: "途中で失敗" },
    ]));

    expect(m.rewrites).toBe(1);
  });
});

describe("logMetrics: 発言の数", () => {
  it("remark の行の数（重複の印つき・中身なしも含む）", () => {
    expect(logMetrics(log([{ ops: [add("t1", "root", "議題", "取り組み")] }], 2)).remarks).toBe(3);
  });

  it("start だけのログは、すべて 0", () => {
    expect(logMetrics([{ type: "start", title: "空" }])).toEqual({ remarks: 0, rewrites: 0, maxRewritesPerNode: 0, maxOpenSiblings: 0 });
  });

  it("diff より前に start がないログは、復元と同じ理由で失敗する", () => {
    const events = log([{ ops: [] }]).slice(1);

    expect(() => logMetrics(events)).toThrow("start");
  });
});

describe("logMetrics: 話し中の兄弟の最多", () => {
  it("ルート直下も数える。種別が違う兄弟も合わせて数える", () => {
    const m = logMetrics(log([
      { ops: [add("t1", "root", "議題", "A"), add("t2", "root", "議題", "B"), add("t3", "root", "議題", "C")] },
      {
        ops: [
          add("a1", "n1", "要点", "p1"), add("a2", "n1", "要点", "p2"), add("a3", "n1", "要点", "p3"),
          add("a4", "n1", "論点", "q1"), add("a5", "n1", "案", "r1"),
        ],
      },
    ]));

    expect(m.maxOpenSiblings).toBe(5);
  });

  it("済みのノードは兄弟に数えない", () => {
    const m = logMetrics(log([
      { ops: [add("t1", "root", "議題", "A"), add("t2", "root", "議題", "B")] },
      { ops: [] },
      { ops: [close("n1")] }, // 直前の応答で根拠が足されたのは 1 つ前の round なので閉じられる
      { ops: [add("t3", "root", "議題", "C"), add("t4", "root", "議題", "D")] },
    ]));

    // 開いているのは n2・n3・n4 の 3 つ。済みの n1 を数えると 4 になる
    expect(m.maxOpenSiblings).toBe(3);
  });

  it("途中の時点の最大を取る。後で閉じても最大は下がらない", () => {
    const m = logMetrics(log([
      { ops: [add("t1", "root", "議題", "A"), add("t2", "root", "議題", "B"), add("t3", "root", "議題", "C"), add("t4", "root", "議題", "D")] },
      { ops: [] },
      { ops: [close("n1"), close("n2"), close("n3"), close("n4")] },
    ]));

    expect(m.maxOpenSiblings).toBe(4);
  });

  it("兄弟の数はすべての親について数え、最大の親の値を取る", () => {
    const m = logMetrics(log([
      { ops: [add("t1", "root", "議題", "A"), add("t2", "root", "議題", "B")] },
      { ops: [add("a1", "n1", "要点", "p1"), add("b1", "n2", "要点", "q1"), add("b2", "n2", "要点", "q2"), add("b3", "n2", "要点", "q3")] },
    ]));

    expect(m.maxOpenSiblings).toBe(3);
  });

  it("1 つの応答の途中の状態は数えない（反映ごとのマップで数える）", () => {
    const m = logMetrics(log([
      { ops: [add("t1", "root", "議題", "A"), add("t2", "n1", "要点", "p")] },
      {
        ops: [
          add("x1", "n1", "要点", "q1", ["r2"]), add("x2", "n1", "要点", "q2", ["r2"]), add("x3", "n1", "要点", "q3", ["r2"]), add("x4", "n1", "要点", "q4", ["r2"]),
          { op: "delete", node: "x1" }, { op: "delete", node: "x2" }, { op: "delete", node: "x3" }, { op: "delete", node: "x4" },
        ],
      },
    ]));

    // 応答の途中では n1 の下が 5 つになるが、反映後のマップは 1 つ
    expect(m.maxOpenSiblings).toBe(1);
  });
});

describe("logMetrics: 復元と同じ反映の番号（round）の規則", () => {
  it("error の diff は round を進めない。そのため直前に根拠が足された議題への close は捨てられ、兄弟に数え続ける", () => {
    const base: Step[] = [
      { ops: [add("t1", "root", "議題", "A"), add("t2", "root", "議題", "B")] }, // round 1
      { ops: [], error: "失敗" }, // round は進まない
      { ops: [close("n1")] }, // round 2 で評価する。n1 の根拠は round 1 なので「直前」に当たり、捨てられる
      { ops: [add("t3", "root", "議題", "C")] },
    ];

    // n1 が開いたままなので n1・n2・n3 の 3 つ
    expect(logMetrics(log(base)).maxOpenSiblings).toBe(3);

    // 失敗が無ければ round は 3 になり、close は通って n2・n3 の 2 つ（最大は閉じる前の 2）
    const ok = [base[0]!, { ops: [] }, base[2]!, base[3]!];
    expect(logMetrics(log(ok)).maxOpenSiblings).toBe(2);
  });
});
