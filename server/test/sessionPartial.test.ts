import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { makeSession, restoreSession, type DiffInput, type DiffOutput, type LogEvent, type Op, type Remark } from "../src/core/index.ts";
import { collectLog, settleUntil, updaterLayer } from "./fixtures/sessionLayers.ts";

const remark = (n: number): Remark => ({ id: `r${n}`, track: "相手", start: n * 10, end: n * 10 + 9, text: `発言${n}` });
const ids = (remarks: readonly Remark[]) => remarks.map((r) => r.id);
const add = (r: Remark): Op => ({ op: "add", ref: `topic-${r.id}`, parent: "root", kind: "議題", text: r.text, evidence: [r.id] });
const partial = (input: DiffInput): DiffOutput & { processedRemarks: number } => ({ ops: [add(input.fresh[0]!)], processedRemarks: 1 });

describe("invConservation: 部分反映", () => {
  it.effect("未消費の発言を根拠にした操作は適用せず、次回の反映で初めて使える", () => Effect.gen(function* () {
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.succeed({ ops: input.fresh.map(add), processedRemarks: 1 })), collectLog(events),
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    const diffs = events.filter((e) => e.type === "diff");
    expect(diffs[0]?.dropped).toEqual([expect.objectContaining({ op: expect.objectContaining({ evidence: ["r2"] }) })]);
    expect(diffs[1]?.dropped).toEqual([]);
    expect((yield* session.snapshot).nodes.filter((n) => n.kind === "議題").map((n) => n.evidence)).toEqual([["r1"], ["r2"]]);
  }));
  it.effect("残り1件も新着を待たず同じSessionで反映する", () => Effect.gen(function* () {
    const calls: DiffInput[] = [];
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.sync(() => { calls.push(input); return partial(input); })), collectLog(events),
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1", "r2"], ["r2"]]);
    expect(calls.map((c) => ids(c.recent))).toEqual([[], ["r1"]]);
    expect(yield* session.unreflectedRemarks).toEqual([]);
    const snapshot = yield* session.snapshot;
    expect(snapshot.nodes.filter((n) => n.kind === "議題").map((n) => [n.text, n.evidence, n.touchedAt])).toEqual([
      ["発言1", ["r1"], 19], ["発言2", ["r2"], 29],
    ]);
    expect(events.filter((e) => e.type === "diff")).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ fresh: ["r1", "r2"] }), processedRemarks: 1 }),
      expect.objectContaining({ input: expect.objectContaining({ fresh: ["r2"] }), processedRemarks: 1 }),
    ]);
  }));

  it.effect("応答待ちに届いた新着より先に残りを渡し、同時に1回だけ更新する", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const calls: DiffInput[] = [];
    let active = 0;
    let maximum = 0;
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.gen(function* () {
        calls.push(input);
        active++;
        maximum = Math.max(maximum, active);
        if (calls.length === 1) yield* Deferred.await(gate);
        active--;
        return partial(input);
      })), collectLog([]),
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* settleUntil(() => calls.length === 1);
    yield* session.push(remark(3));
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1", "r2"]]);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2", "r3"]);
    yield* Deferred.succeed(gate, undefined);
    yield* session.idle;
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1", "r2"], ["r2", "r3"], ["r3"]]);
    expect(maximum).toBe(1);
    expect(yield* session.unreflectedRemarks).toEqual([]);
  }));

  it.effect("flushは部分成功で残った全発言を処理してから返る", () => Effect.gen(function* () {
    const calls: DiffInput[] = [];
    const session = yield* restoreSession([
      { type: "start", title: "定例" }, ...[1, 2, 3].map((n) => ({ type: "remark", remark: remark(n) })),
    ]).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.sync(() => { calls.push(input); return partial(input); })), collectLog([]),
    )));
    yield* session.flush;
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1", "r2", "r3"], ["r2", "r3"], ["r3"]]);
    expect(yield* session.unreflectedRemarks).toEqual([]);
    expect((yield* session.snapshot).nodes.filter((n) => n.kind === "議題").map((n) => n.evidence)).toEqual([["r1"], ["r2"], ["r3"]]);
  }));

  it.effect("部分反映ログをJSONL往復しても残りを復元し、再開後に反映する", () => Effect.gen(function* () {
    const calls: DiffInput[] = [];
    const events = [
      { type: "start", title: "定例" },
      { type: "remark", remark: remark(1) }, { type: "remark", remark: remark(2) },
      { type: "diff", input: { recent: [], fresh: ["r1", "r2"], nodeCount: 0 }, ops: [add(remark(1))], dropped: [], processedRemarks: 1 },
    ];
    const jsonl = events.map((e) => JSON.stringify(e)).join("\n");
    const session = yield* restoreSession(jsonl.split("\n").map((line): unknown => JSON.parse(line))).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.sync(() => { calls.push(input); return partial(input); })), collectLog([]),
    )));
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r2"]);
    expect((yield* session.snapshot).nodes.find((n) => n.text === "発言1")?.touchedAt).toBe(19);
    yield* session.flush;
    expect(calls.map((c) => [ids(c.recent), ids(c.fresh)])).toEqual([[["r1"], ["r2"]]]);
    expect(yield* session.unreflectedRemarks).toEqual([]);
    expect((yield* session.snapshot).nodes.filter((n) => n.kind === "議題").map((n) => n.evidence)).toEqual([["r1"], ["r2"]]);
  }));

  it.effect("反映数を省略したupdaterは全件消費し、次回は後続だけを渡す（C04）", () => Effect.gen(function* () {
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.sync(() => { calls.push(input); return { ops: input.fresh.map(add) }; })), collectLog([]),
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    expect(yield* session.unreflectedRemarks).toEqual([]);
    yield* session.push(remark(3));
    yield* session.flush;
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1", "r2"], ["r3"]]);
  }));

  it.effect("部分成功の次の通常失敗はその入力を全件消費し、後続へ進む（C05）", () => Effect.gen(function* () {
    const calls: DiffInput[] = [];
    const events: LogEvent[] = [];
    const session = yield* restoreSession([
      { type: "start", title: "定例" }, ...[1, 2, 3].map((n) => ({ type: "remark", remark: remark(n) })),
    ]).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length === 2 ? Effect.fail({ _tag: "UpdateFailed", message: "合成の通信失敗" }) : Effect.succeed(partial(input));
      })), collectLog(events),
    )));
    yield* session.flush;
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1", "r2", "r3"], ["r2", "r3"]]);
    expect(yield* session.unreflectedRemarks).toEqual([]);
    expect(events.filter((e) => e.type === "diff")[1]).toMatchObject({ ops: [], error: expect.stringContaining("合成の通信失敗") });
    expect((yield* session.snapshot).nodes.filter((n) => n.kind === "議題").map((n) => n.evidence)).toEqual([["r1"]]);
    yield* session.push(remark(4));
    yield* session.flush;
    expect(ids(calls[2]!.fresh)).toEqual(["r4"]);
    expect(ids(calls[2]!.recent)).toEqual(["r1", "r2", "r3"]);
  }));

  for (const count of [0, -1, 0.5, 3]) {
    it.effect(`不正な反映数${count}は通常失敗として全件消費し、操作を反映しない`, () => Effect.gen(function* () {
      const calls: DiffInput[] = [];
      const events: LogEvent[] = [];
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
        updaterLayer((input) => Effect.sync(() => {
          calls.push(input);
          return { ops: [add(input.fresh[0]!)], processedRemarks: calls.length === 1 ? count : 1 };
        })), collectLog(events),
      )));
      yield* session.push(remark(1));
      yield* session.push(remark(2));
      yield* session.idle;
      expect(calls).toHaveLength(1);
      expect((yield* session.snapshot).nodes.filter((n) => n.kind === "議題")).toEqual([]);
      expect(yield* session.unreflectedRemarks).toEqual([]);
      expect(events.find((e) => e.type === "diff")).toMatchObject({ ops: [], error: expect.any(String) });
      yield* session.push(remark(3));
      yield* session.flush;
      expect(ids(calls[1]!.fresh)).toEqual(["r3"]);
    }));
  }
});
