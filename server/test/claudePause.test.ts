import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema, Scope, Context } from "effect";
import { TestClock } from "effect/testing";
import { AgentSdk, layerClaude } from "../src/claude.ts";
import { DiffUpdater, LogEvent, makeSession, restoreSession, restoreState, type Remark } from "../src/core/index.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { collectLog, forbiddenUpdater, settleUntil, silentLog, updaterLayer } from "./fixtures/sessionLayers.ts";

const FIVE_MINUTES = 300_000;
const TEN_MINUTES = 600_000;
const remark = (n: number): Remark => ({ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}。` });
const ids = (remarks: readonly Remark[]) => remarks.map((r) => r.id);
const roundTrip = (events: readonly LogEvent[]) => events.map((e) => JSON.parse(JSON.stringify(e)) as unknown);

// 偽の query()。user メッセージを 1 つ読むたびに、script(その呼び出しの通し番号) が返す SDK メッセージの列を流す。
// 通し番号は query を開き直してもリセットしない（差分更新の呼び出し順を表す）
type Script = (call: number) => unknown[];
// rejected の後に、SDK が続けて流しうる失敗の result も付ける（イベントの時点で一時停止にできることを確かめる）
const rejected = (resetsAtSeconds?: number) => [
  { type: "rate_limit_event", rate_limit_info: { status: "rejected", ...(resetsAtSeconds === undefined ? {} : { resetsAt: resetsAtSeconds }) } },
  { type: "result", subtype: "error_during_execution", usage: { input_tokens: 1, output_tokens: 1 } },
];
const success = (refs: readonly string[]) => [
  { type: "assistant", message: { id: "msg", model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 } } },
  {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, output_tokens: 1 },
    structured_output: { ops: refs.map((r) => ({ op: "add", ref: r, parent: "root", kind: "議題", text: r, evidence: [r] })) },
  },
];
const failure = [{ type: "result", subtype: "error_during_execution", usage: { input_tokens: 1, output_tokens: 1 } }];

const claudeUpdater = (script: Script) =>
  Effect.gen(function* () {
    let call = 0;
    const query = ((params: { prompt: AsyncIterable<unknown> }) => {
      const gen = (async function* () {
        for await (const _message of params.prompt) yield* script(call++);
      })();
      return Object.assign(gen, { close: () => {} });
    }) as unknown as AgentSdk["Service"]["query"];
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const sdk = Layer.succeed(AgentSdk, AgentSdk.of({ query }));
    const context = yield* Layer.buildWithScope(layerClaude(defaultClaude.model).pipe(Layer.provide(sdk)), scope);
    return { updater: Context.get(context, DiffUpdater), calls: () => call };
  });

const openSession = (script: Script, events: LogEvent[] = []) =>
  Effect.gen(function* () {
    const { updater, calls } = yield* claudeUpdater(script);
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(Layer.succeed(DiffUpdater, updater), collectLog(events))));
    return { session, calls };
  });

const transitions = (events: readonly LogEvent[]) => events.filter((e) => e.type.startsWith("diff-update-"));

describe("Claude の利用上限で差分更新を一時停止する（同じ Session の上で）", () => {
  it.effect("rejected の回は発言が未反映に残り、round は進まず、一時停止（Claude の利用上限）がログと状態に出る", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const { session, calls } = yield* openSession(() => rejected(TEN_MINUTES / 1000), events);

      yield* session.push(remark(1));
      yield* session.idle;

      expect(calls()).toBe(1);
      expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1"]);
      expect((yield* session.snapshot).round).toBe(0);
      expect(yield* session.diffUpdate).toEqual({ status: "paused", reason: "Claude の利用上限" });
      expect(transitions(events)).toEqual([{ type: "diff-update-paused", reason: "Claude の利用上限" }]);
    }));

  it.effect("resetsAt の時刻に試し直し（その 1ms 前までは呼ばない）、成功すると再開して retry → resumed が残る", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const { session, calls } = yield* openSession((call) => (call === 0 ? rejected(TEN_MINUTES / 1000) : success(["r1", "r2"])), events);
      yield* session.push(remark(1));
      yield* session.idle;
      yield* session.push(remark(2));

      yield* TestClock.adjust(FIVE_MINUTES); // 5 分では試さない
      yield* TestClock.adjust(FIVE_MINUTES - 1);
      yield* session.idle;
      expect(calls()).toBe(1);
      expect(yield* session.diffUpdate).toEqual({ status: "paused", reason: "Claude の利用上限" });

      yield* TestClock.adjust(1);
      yield* settleUntil(() => calls() === 2);
      yield* session.idle;

      expect(calls()).toBe(2);
      expect(yield* session.diffUpdate).toEqual({ status: "running" });
      expect(yield* session.unreflectedRemarks).toEqual([]);
      expect((yield* session.snapshot).round).toBe(1);
      expect(transitions(events)).toEqual([
        { type: "diff-update-paused", reason: "Claude の利用上限" },
        { type: "diff-update-retry", reason: "Claude の利用上限" },
        { type: "diff-update-resumed" },
      ]);
    }));

  it.effect("resetsAt が無いときは 5 分ごとに試し、戻ったら再開する", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const { session, calls } = yield* openSession((call) => (call < 2 ? rejected() : success(["r1"])), events);
      yield* session.push(remark(1));
      yield* session.idle;

      yield* TestClock.adjust(FIVE_MINUTES - 1);
      expect(calls()).toBe(1);
      yield* TestClock.adjust(1);
      yield* settleUntil(() => calls() === 2);
      yield* session.idle;
      expect(yield* session.diffUpdate).toEqual({ status: "paused", reason: "Claude の利用上限" });
      yield* TestClock.adjust(FIVE_MINUTES - 1);
      expect(calls()).toBe(2);
      yield* TestClock.adjust(1);
      yield* settleUntil(() => calls() === 3);
      yield* session.idle;

      expect(yield* session.diffUpdate).toEqual({ status: "running" });
      expect(yield* session.unreflectedRemarks).toEqual([]);
      expect(transitions(events).map((e) => e.type)).toEqual(["diff-update-paused", "diff-update-retry", "diff-update-paused", "diff-update-retry", "diff-update-resumed"]);
    }));

  it.effect("resetsAt に試してもまだ上限（返った resetsAt は過去）なら、その後は 5 分ごとに試す", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* openSession((call) => (call === 0 ? rejected(TEN_MINUTES / 1000) : call === 1 ? rejected(TEN_MINUTES / 1000) : success(["r1"])));
      yield* session.push(remark(1));
      yield* session.idle;

      yield* TestClock.adjust(TEN_MINUTES);
      yield* settleUntil(() => calls() === 2);
      yield* session.idle;
      expect(calls()).toBe(2);
      yield* TestClock.adjust(FIVE_MINUTES - 1);
      expect(calls()).toBe(2);
      yield* TestClock.adjust(1);
      yield* settleUntil(() => calls() === 3);
      yield* session.idle;

      expect(yield* session.diffUpdate).toEqual({ status: "running" });
      expect(yield* session.unreflectedRemarks).toEqual([]);
    }));

  it.effect("再試行でも戻らず、先の resetsAt が返っても、その後は 5 分ごとに試す", () =>
    Effect.gen(function* () {
      const { session, calls } = yield* openSession((call) => (call === 0 ? rejected(TEN_MINUTES / 1000) : call === 1 ? rejected((TEN_MINUTES + 3_600_000) / 1000) : success(["r1"])));
      yield* session.push(remark(1));
      yield* session.idle;

      yield* TestClock.adjust(TEN_MINUTES);
      yield* settleUntil(() => calls() === 2);
      yield* session.idle;
      yield* TestClock.adjust(FIVE_MINUTES - 1);
      expect(calls()).toBe(2);
      yield* TestClock.adjust(1);
      yield* settleUntil(() => calls() === 3);
      yield* session.idle;

      expect(yield* session.diffUpdate).toEqual({ status: "running" });
      expect(yield* session.unreflectedRemarks).toEqual([]);
    }));

  it.effect("利用上限ではない失敗は今までどおり処理済みになり、一時停止にも再試行にもならない", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const { session, calls } = yield* openSession(() => failure, events);

      yield* session.push(remark(1));
      yield* session.idle;
      yield* TestClock.adjust(TEN_MINUTES);

      expect(calls()).toBe(1);
      expect(yield* session.unreflectedRemarks).toEqual([]);
      expect(yield* session.diffUpdate).toEqual({ status: "running" });
      expect(transitions(events)).toEqual([]);
    }));
});

describe("Claude の利用上限で止まったログからの復元", () => {
  it.effect("止まった時点のログを読み直すと、その回の発言が未反映で戻り、前回の応答は載らず、全行が LogEvent として読める", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const { session } = yield* openSession((call) => (call === 0 ? success(["r1"]) : rejected(TEN_MINUTES / 1000)), events);
      yield* session.push(remark(1));
      yield* session.idle;
      yield* session.push(remark(2));
      yield* session.idle;
      expect(ids(yield* session.unreflectedRemarks)).toEqual(["r2"]);

      const rows = roundTrip(events);
      for (const row of rows) yield* Schema.decodeUnknownEffect(LogEvent)(row);
      const state = yield* restoreState(rows);
      expect(ids(state.pending)).toEqual(["r2"]);
      expect(state.round).toBe(1);
      expect(state.previousResponse).toBeUndefined();
      const restored = yield* restoreSession(rows).pipe(Effect.provide(Layer.merge(forbiddenUpdater, silentLog)));
      expect(ids(yield* restored.unreflectedRemarks)).toEqual(["r2"]);
    }));
  const CLAUDE_LIMIT = { status: "paused", reason: "Claude の利用上限" } as const;

  it.effect("止まった時点のログを復元すると、一時停止（Claude の利用上限）で戻る", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const { session } = yield* openSession((call) => (call === 0 ? success(["r1"]) : rejected(TEN_MINUTES / 1000)), events);
      yield* session.push(remark(1));
      yield* session.idle;
      yield* session.push(remark(2));
      yield* session.idle;

      const rows = roundTrip(events);
      expect((yield* restoreState(rows)).diffUpdate).toEqual(CLAUDE_LIMIT);
      const restored = yield* restoreSession(rows).pipe(Effect.provide(Layer.merge(forbiddenUpdater, silentLog)));
      expect(yield* restored.diffUpdate).toEqual(CLAUDE_LIMIT);
      expect(ids(yield* restored.unreflectedRemarks)).toEqual(["r2"]);
    }));

  it.effect("復元した一時停止の状態から 5 分後に再試行し、成功すると running に戻り、retry と resumed がログに残る", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const { session } = yield* openSession((call) => (call === 0 ? success(["r1"]) : rejected(TEN_MINUTES / 1000)), events);
      yield* session.push(remark(1));
      yield* session.idle;
      yield* session.push(remark(2));
      yield* session.idle;
      const rows = roundTrip(events);

      const fresh: string[][] = [];
      const restoredEvents: LogEvent[] = [];
      const updater = updaterLayer((input) => {
        fresh.push([...input.fresh.map((r) => r.id)]);
        return Effect.succeed({ ops: [] });
      });
      const restored = yield* restoreSession(rows).pipe(Effect.provide(Layer.merge(updater, collectLog(restoredEvents))));
      yield* restored.push(remark(3));
      yield* TestClock.adjust(FIVE_MINUTES - 1);
      expect(fresh).toEqual([]);

      yield* TestClock.adjust(1);
      yield* settleUntil(() => fresh.length === 1);
      yield* restored.idle;
      expect(fresh).toEqual([["r2", "r3"]]);
      expect(yield* restored.diffUpdate).toEqual({ status: "running" });
      expect(yield* restored.unreflectedRemarks).toEqual([]);
      expect(transitions(restoredEvents)).toEqual([
        { type: "diff-update-retry", reason: "Claude の利用上限" },
        { type: "diff-update-resumed" },
      ]);
    }));

  it.effect("再開して成功したログ（resumed の行あり）は running で戻る", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const { session, calls } = yield* openSession((call) => (call === 0 ? rejected(TEN_MINUTES / 1000) : success(["r1"])), events);
      yield* session.push(remark(1));
      yield* session.idle;
      yield* TestClock.adjust(TEN_MINUTES);
      yield* settleUntil(() => calls() === 2);
      yield* session.idle;

      const rows = roundTrip(events);
      expect((yield* restoreState(rows)).diffUpdate).toEqual({ status: "running" });
      const restored = yield* restoreSession(rows).pipe(Effect.provide(Layer.merge(forbiddenUpdater, silentLog)));
      expect(yield* restored.diffUpdate).toEqual({ status: "running" });
      expect(yield* restored.unreflectedRemarks).toEqual([]);
    }));

  it.effect("再試行が通常の失敗で終わったログ（resumed の行なし）も running で戻り、発言は処理済みになる", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const { session, calls } = yield* openSession((call) => (call === 0 ? rejected(TEN_MINUTES / 1000) : failure), events);
      yield* session.push(remark(1));
      yield* session.idle;
      yield* TestClock.adjust(TEN_MINUTES);
      yield* settleUntil(() => calls() === 2);
      yield* session.idle;

      const rows = roundTrip(events);
      expect(rows.some((row) => (row as { type: string }).type === "diff-update-resumed")).toBe(false);
      expect((yield* restoreState(rows)).diffUpdate).toEqual({ status: "running" });
      const restored = yield* restoreSession(rows).pipe(Effect.provide(Layer.merge(forbiddenUpdater, silentLog)));
      expect(yield* restored.diffUpdate).toEqual({ status: "running" });
      expect(yield* restored.unreflectedRemarks).toEqual([]);
    }));
});
