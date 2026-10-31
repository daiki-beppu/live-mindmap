import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { logMetrics, type LogEvent } from "../src/core/index.ts";

it.effect("話し中の兄弟の最多から補足だけを外し、通常ノードと補足の採番は保つ", () => Effect.gen(function* () {
  const events: LogEvent[] = [
    { type: "start", title: "定例" },
    { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 10, text: "用語" } },
    { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, dropped: [], ops: [
      { op: "add", ref: "a", parent: "root", kind: "議題", text: "議題", evidence: ["r1"] },
      { op: "add", ref: "b", parent: "a", kind: "案", text: "補足の方法", evidence: ["r1"] },
    ] },
    { type: "supplement", category: "背景", ms: 1, reflectedAt: 10,
      op: { op: "add", parent: "n1", text: "説明", origin: "会議の外", evidence: ["r1"] } },
    { type: "diff", input: { recent: [], fresh: [], nodeCount: 3 }, dropped: [], ops: [
      { op: "add", ref: "c", parent: "n2", kind: "要点", text: "通常の内容", evidence: ["r1"] },
      { op: "update", node: "n4", text: "通常の更新", evidence: ["r1"] },
    ] },
  ];
  expect(yield* logMetrics(events)).toMatchObject({ maxOpenSiblings: 1, rewrites: 1 });
}));

it.effect("補足の採番を計測にも反映し、後続の通常ノードの書き換えを数える", () => Effect.gen(function* () {
  const events: LogEvent[] = [
    { type: "start", title: "定例" },
    { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 10, text: "用語の話" } },
    { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [{ op: "add", ref: "a", parent: "root", kind: "議題", text: "議題", evidence: ["r1"] }], dropped: [] },
    { type: "supplement", op: { op: "add", parent: "n1", text: "説明", origin: "会議の外", evidence: ["r1"] }, category: "用語", term: "用語", ms: 1, reflectedAt: 10 },
    { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 2 }, ops: [{ op: "add", ref: "b", parent: "root", kind: "議題", text: "次の議題", evidence: ["r1"] }], dropped: [] },
    { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 3 }, ops: [{ op: "update", node: "n3", text: "言い直した議題", evidence: ["r1"] }], dropped: [] },
  ];
  expect((yield* logMetrics(events)).rewrites).toBe(1);
}));

it.effect("logMetrics: processedRemarks が fresh の件数を超える成功行は InvalidLogEvent で失敗する", () => Effect.gen(function* () {
  const events: LogEvent[] = [
    { type: "start", title: "定例" },
    { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 10, text: "採用について" } },
    {
      type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 },
      ops: [], dropped: [], processedRemarks: 2,
    },
  ];

  const error = yield* Effect.flip(logMetrics(events));

  expect(error).toMatchObject({ _tag: "InvalidLogEvent" });
}));

it.effect("invConservation: 再適用でも未消費の発言を根拠にした操作は指標へ含めない", () => Effect.gen(function* () {
  const events: LogEvent[] = [
    { type: "start", title: "定例" },
    { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 10, text: "採用について" } },
    { type: "remark", remark: { id: "r2", track: "相手", start: 10, end: 20, text: "未反映の修正" } },
    {
      type: "diff", input: { recent: [], fresh: ["r1", "r2"], nodeCount: 0 },
      ops: [
        { op: "add", ref: "topic", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
        { op: "update", node: "topic", text: "まだ反映しない修正", evidence: ["r2"] },
      ], dropped: [], ...{ processedRemarks: 1 },
    },
  ];
  expect((yield* logMetrics(events)).rewrites).toBe(0);
  // input.fresh 全体の発言参照を検査する既存契約は、部分反映でも維持する。
  const error = yield* Effect.flip(logMetrics([events[0]!, events[1]!, events[3]!]));
  expect(error).toMatchObject({ _tag: "InvalidLogEvent", index: 2 });
  expect(error.reason).toContain("r2");
  expect((yield* logMetrics([...events, {
    type: "diff", input: { recent: ["r1"], fresh: ["r2"], nodeCount: 1 },
    ops: [{ op: "update", node: "n1", text: "反映した修正", evidence: ["r2"] }], dropped: [], ...{ processedRemarks: 1 },
  }])).rewrites).toBe(1);
}));
