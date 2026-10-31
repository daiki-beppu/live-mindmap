import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { supplementMetrics, type EvaluationLogEvent } from "../src/core/supplementMetrics.ts";

const at = (seconds: number) => DateTime.makeUnsafe(`2026-10-01T00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}Z`);
const base = (): EvaluationLogEvent[] => [
  { type: "start", title: "合成会議" },
  { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 20, text: "発言" } },
  { type: "diff", loggedAt: at(10), input: { recent: [], fresh: ["r1"], nodeCount: 0 }, dropped: [], ops: [
    { op: "add", ref: "a", parent: "root", kind: "案", text: "案1", evidence: ["r1"] },
    { op: "add", ref: "b", parent: "root", kind: "案", text: "案2", evidence: ["r1"] },
  ] },
];

describe("補足の実時刻による集計", () => {
  it.effect("反映された追加だけを数え、親の更新で起点を変えずp50とp90を分ける", () => Effect.gen(function* () {
    const log: EvaluationLogEvent[] = [...base(),
      { type: "supplement", loggedAt: at(14), category: "背景", ms: 1, reflectedAt: 20,
        op: { op: "add", parent: "n1", text: "説明1", evidence: ["r1"], origin: "会議の外" } },
      { type: "supplement", loggedAt: at(15), category: "背景", ms: 1, reflectedAt: 20,
        op: { op: "add", parent: "n1", text: "重複するため拒否", evidence: ["r1"], origin: "会議の外" } },
      { type: "diff", loggedAt: at(99), input: { recent: [], fresh: [], nodeCount: 3 }, dropped: [],
        ops: [{ op: "update", node: "n2", text: "案2の更新", evidence: ["r1"] }] },
      { type: "supplement", loggedAt: at(100), category: "背景", ms: 1, reflectedAt: 20,
        op: { op: "add", parent: "n2", text: "説明2", evidence: ["r1"], origin: "会議の外" } },
    ];
    expect(yield* supplementMetrics([], log)).toMatchObject({ delayCount: 2, p50: 4, p90: 90 });
  }));

  it.effect("拒否された親追加には時刻を付けず、後の有効な追加から測る", () => Effect.gen(function* () {
    const log: EvaluationLogEvent[] = [
      ...base(),
      { type: "diff", loggedAt: at(30), input: { recent: [], fresh: [], nodeCount: 2 }, dropped: [], ops: [
        { op: "add", ref: "bad", parent: "missing", kind: "案", text: "拒否", evidence: ["r1"] },
        { op: "add", ref: "c", parent: "root", kind: "案", text: "有効", evidence: ["r1"] },
      ] },
      { type: "supplement", loggedAt: at(40), category: "背景", ms: 1, reflectedAt: 20,
        op: { op: "add", parent: "n3", text: "説明", evidence: ["r1"], origin: "会議の外" } },
    ];
    expect(yield* supplementMetrics([], log)).toMatchObject({ delayCount: 1, p50: 10, p90: 10 });
  }));

  it.effect.each(["diff", "supplement"] as const)("startの無い%s行はInvalidLogEventとして失敗する", (type) => Effect.gen(function* () {
    const event: EvaluationLogEvent = type === "diff"
      ? { type, input: { recent: [], fresh: [], nodeCount: 0 }, ops: [], dropped: [] }
      : { type, op: null, category: null, ms: 1, reflectedAt: 0 };
    expect(yield* Effect.flip(supplementMetrics([], [event]))).toMatchObject({ _tag: "InvalidLogEvent", index: 0 });
  }));
});
