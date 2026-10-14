import { describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Result, Schema, Scope } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { emptyMap, LogEvent, makeSession, restoreSession, restoreState, type DiffInput, type DiffUpdateError, type Remark, type ScreenChange } from "../src/core/index.ts";
import { prepareChatgpt } from "../src/chatgptResponses.ts";
import { localUpdaterLayer } from "../src/localDiffUpdater.ts";
import { classificationRequest } from "../src/localPrompt.ts";
import { CHATGPT_HOME, CHATGPT_MODEL, chatgptCredentials, classification, completedSse, fakeChatgptFiles, fakeChatgptHttp } from "./fixtures/chatgpt.ts";
import { collectLog, forbiddenUpdater, settleUntil, silentLog, updaterLayer } from "./fixtures/sessionLayers.ts";

const FIVE_MINUTES = 300_000;
const code = "subscription_sharing_usage_limit_exceeded";
const remark = (n: number): Remark => ({ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}。` });
const ids = (remarks: readonly Remark[]) => remarks.map((r) => r.id);
const probe = classificationRequest(emptyMap("定例"), [], [{ remark: "probe", text: "確認。" }]);

// HTTP 境界が生成した失敗を使う。core のテストが独自の一時停止タグを定義しないため。
const responseFailure = Effect.fnUntraced(function* (status: number, body: string): Effect.fn.Return<DiffUpdateError> {
  const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
  const http = fakeChatgptHttp((_request, call) => call === 1
    ? new Response(completedSse(classification([{ 種類: "なし" }])))
    : new Response(body, { status, headers: { "content-type": "application/json" } }));
  const { classify } = yield* prepareChatgpt(CHATGPT_MODEL).pipe(
    Effect.provideService(FileSystem.FileSystem, files.fs), Effect.provideService(HttpClient.HttpClient, http.client),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: CHATGPT_HOME }))),
    Effect.orDie,
  );
  const result = yield* Effect.result(classify(probe));
  expect(http.requests).toHaveLength(2);
  if (Result.isSuccess(result)) return yield* Effect.die("失敗応答が成功として返りました");
  return result.failure;
});
const rateLimitFailure = responseFailure(429, JSON.stringify({ error: { code } }));

describe("ChatGPT の利用上限の分類", () => {
  it.effect("429 と指定コードの組だけが通常失敗とは異なるタグになる", () => Effect.gen(function* () {
    const paused = yield* rateLimitFailure;
    const ordinary = yield* responseFailure(500, JSON.stringify({ error: { code: "server_error" } }));
    expect(paused._tag).not.toBe(ordinary._tag);
  }));

  it.effect.each([
    { name: "別コードの429", status: 429, body: JSON.stringify({ error: { code: "rate_limit_exceeded" } }) },
    { name: "別statusの指定コード", status: 500, body: JSON.stringify({ error: { code } }) },
    { name: "不正JSONの429", status: 429, body: "not-json" },
    { name: "構造の異なる429", status: 429, body: JSON.stringify({ message: code }) },
  ])("$name は発言を消費し、5分後も再試行しない", ({ status, body }) => Effect.gen(function* () {
    const failure = yield* responseFailure(status, body);
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => { calls.push(input); return Effect.fail(failure); })), silentLog,
    )));
    yield* session.push(remark(1));
    yield* session.idle;
    expect(calls).toHaveLength(1);
    expect(yield* session.unreflectedRemarks).toEqual([]);
    expect((yield* session.snapshot).round).toBe(0);
    yield* TestClock.adjust(FIVE_MINUTES);
    expect(calls).toHaveLength(1);
  }));
});

describe("同じSessionでの一時停止と再開", () => {
  it.effect("反映済みのマップと履歴を一時停止中も保持し、再開後は未反映分だけを追加する", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length === 2 ? Effect.fail(failure) : Effect.succeed({
          ops: input.fresh.map((r) => ({ op: "add" as const, ref: r.id, parent: "root", kind: "議題" as const, text: r.text, evidence: [r.id] })),
        });
      })), silentLog,
    )));
    yield* session.push(remark(1));
    yield* session.idle;
    const before = yield* session.snapshot;
    expect(before.round).toBe(1);
    expect(before.nodes.filter((n) => n.kind === "議題").flatMap((n) => n.evidence)).toEqual(["r1"]);
    // r2 の呼び出しが利用上限で止まり、止まっている間に届いた r3 は呼び出しを起こさず保持される
    yield* session.push(remark(2));
    yield* session.push(remark(3));
    yield* session.idle;
    const paused = yield* session.snapshot;
    expect(paused.nodes).toEqual(before.nodes);
    expect(paused.changes).toEqual(before.changes);
    expect(paused.round).toBe(before.round);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r2", "r3"]);
    expect(calls).toHaveLength(2);
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 3);
    yield* session.idle;
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1"], ["r2"], ["r2", "r3"]]);
    expect(ids(calls[2]!.recent)).toEqual(["r1"]);
    expect((yield* session.snapshot).nodes.filter((n) => n.kind === "議題").flatMap((n) => n.evidence)).toEqual(["r1", "r2", "r3"]);
    expect(yield* session.unreflectedRemarks).toEqual([]);
  }));

  it.effect("429の発言と新着を保持し、5分ごとの再試行が成功したら古い順に2発言ずつ反映する", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const requests: string[][] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      localUpdaterLayer({ katakana: () => Effect.succeed([]), classify: (request) => Effect.suspend(() => {
        const sentences = [...request.prompt.matchAll(/^\d+\. \[(r\d+)\] (.+)$/gm)];
        requests.push(sentences.map((s) => s[1]!));
        return requests.length <= 2 ? Effect.fail(failure) : Effect.succeed({
          議題: { id: "新しい議題", 題: "採用" }, 文: sentences.map((s) => ({ 種類: "説明" as const, text: s[2]! })), 済み: "なし",
        });
      }) }), silentLog,
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    expect(requests).toEqual([["r1"]]);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2"]);
    expect((yield* session.snapshot).round).toBe(0);
    yield* TestClock.adjust(60_000);
    for (const n of [3, 4, 5, 6, 7]) yield* session.push(remark(n));
    yield* TestClock.adjust(FIVE_MINUTES - 60_000 - 1);
    yield* session.idle;
    expect(requests).toEqual([["r1"]]);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    yield* TestClock.adjust(1);
    yield* settleUntil(() => requests.length === 2);
    yield* session.idle;
    expect(requests).toEqual([["r1"], ["r1", "r2"]]);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    yield* TestClock.adjust(FIVE_MINUTES - 1);
    expect(requests).toHaveLength(2);
    yield* TestClock.adjust(1);
    yield* settleUntil(() => requests.length === 6);
    yield* session.idle;
    expect(requests).toEqual([["r1"], ["r1", "r2"], ["r1", "r2"], ["r3", "r4"], ["r5", "r6"], ["r7"]]);
    expect(yield* session.unreflectedRemarks).toEqual([]);
    expect((yield* session.snapshot).nodes.filter((n) => n.kind === "要点").flatMap((n) => n.evidence)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
  }));

  it.effect("再試行の応答待ちに新着と5分経過が重なっても同時呼び出しは1つで、保持分を先に渡す", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const gate = yield* Deferred.make<void>();
    const calls: string[][] = [];
    let active = 0;
    let maximum = 0;
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.gen(function* () {
        calls.push(ids(input.fresh));
        active++;
        maximum = Math.max(maximum, active);
        if (calls.length === 1) { active--; return yield* Effect.fail(failure); }
        if (calls.length === 2) yield* Deferred.await(gate);
        active--;
        return { ops: [], processedRemarks: 1 };
      })), silentLog,
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2"]);
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 2);
    expect(calls).toHaveLength(2);
    yield* session.push(remark(3));
    yield* TestClock.adjust(FIVE_MINUTES);
    expect(calls).toHaveLength(2);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2", "r3"]);
    yield* Deferred.succeed(gate, undefined);
    yield* session.idle;
    expect(calls).toEqual([["r1"], ["r1", "r2"], ["r2", "r3"], ["r3"]]);
    expect(maximum).toBe(1);
    expect(yield* session.unreflectedRemarks).toEqual([]);
  }));

  it.effect("一時停止中のflushは強制再試行も消費もせず返り、Scope終了後は再試行しない", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => { calls.push(input); return Effect.fail(failure); })), silentLog,
    )), Scope.provide(scope));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2"]);
    yield* session.flush;
    expect(calls).toHaveLength(1);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2"]);
    // 書き出し中はScopeがまだ開いている。取得済みsnapshotと保存ログを変えない。
    const snapshot = yield* session.snapshot;
    yield* TestClock.adjust(FIVE_MINUTES * 2);
    expect(calls).toHaveLength(1);
    expect(yield* session.snapshot).toEqual(snapshot);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2"]);
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust(FIVE_MINUTES * 2);
    expect(calls).toHaveLength(1);
  }));

  it.effect("再試行中に終了のflushが始まったら進行中の更新を待ち、後の再試行を起動しない", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const gate = yield* Deferred.make<void>();
    let calls = 0;
    let flushed = false;
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer(() => Effect.gen(function* () {
        calls++;
        if (calls === 2) yield* Deferred.await(gate);
        return yield* Effect.fail(failure);
      })), silentLog,
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls === 2);
    expect(calls).toBe(2);
    const flush = yield* session.flush.pipe(Effect.andThen(Effect.sync(() => { flushed = true; })), Effect.forkChild);
    yield* Effect.yieldNow;
    expect(flushed).toBe(false);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(flush);
    expect(flushed).toBe(true);
    yield* TestClock.adjust(FIVE_MINUTES * 2);
    expect(calls).toBe(2);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2"]);
  }));

  it.effect("再試行が通常失敗ならその回を消費し、新着の処理へ戻る", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        if (calls.length === 1) return Effect.fail(failure);
        if (calls.length === 2) return Effect.fail({ _tag: "UpdateFailed", message: "合成の通常失敗" });
        return Effect.succeed({ ops: [] });
      })), silentLog,
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2"]);
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 2);
    yield* session.idle;
    expect(yield* session.unreflectedRemarks).toEqual([]);
    yield* session.push(remark(3));
    yield* session.flush;
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1"], ["r1", "r2"], ["r3"]]);
    expect(ids(calls[2]!.recent)).toEqual(["r1", "r2"]);
    yield* TestClock.adjust(FIVE_MINUTES);
    expect(calls).toHaveLength(3);
  }));

  it.effect("停止・試行・再開を各1行で記録し、JSONLの読み直しが発言とマップを保存する", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const events: LogEvent[] = [];
    let calls = 0;
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls++;
        return calls === 1 ? Effect.fail(failure) : Effect.succeed({ ops: input.fresh.map((r) => ({ op: "add" as const, ref: r.id, parent: "root", kind: "議題" as const, text: r.text, evidence: [r.id] })) });
      })), collectLog(events),
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    const pausedEvents = events.map((e) => JSON.parse(JSON.stringify(e)) as unknown);
    const paused = yield* restoreState(pausedEvents);
    expect(ids(paused.pending)).toEqual(["r1", "r2"]);
    expect(paused.round).toBe(0);
    const transitions = () => events.filter((e) => !["start", "remark", "diff"].includes(e.type));
    expect(transitions().map((e) => e.type)).toEqual(["diff-update-paused"]);
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls === 2);
    yield* session.idle;
    expect(transitions().map((e) => e.type)).toEqual(["diff-update-paused", "diff-update-retry", "diff-update-resumed"]);
    for (const event of events) yield* Schema.decodeEffect(LogEvent)(JSON.parse(JSON.stringify(event)));
    const restored = yield* restoreSession(events.map((e) => JSON.parse(JSON.stringify(e)) as unknown)).pipe(Effect.provide(Layer.merge(forbiddenUpdater, silentLog)));
    expect(yield* restored.unreflectedRemarks).toEqual([]);
    expect(yield* restored.snapshot).toEqual(yield* session.snapshot);
  }));

  it.effect("対応と捨てた操作を持つ成功の後に利用上限で止まると、再試行の入力にも、止まったログから復元した状態にも、前回の応答は載らない", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const events: LogEvent[] = [];
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        if (calls.length === 2) return Effect.fail(failure);
        return Effect.succeed({ ops: calls.length === 1
          ? [
            { op: "add" as const, ref: "u1", parent: "root", kind: "議題" as const, text: "採用", evidence: ["r1"] },
            { op: "add" as const, ref: "u2", parent: "n99", kind: "課題" as const, text: "親が無い", evidence: ["r1"] },
          ]
          : [] });
      })), collectLog(events),
    )));
    yield* session.push(remark(1));
    yield* session.idle;
    yield* session.push(remark(2));
    yield* session.idle;
    // 2 回目の入力には 1 回目の応答が載り、その回が利用上限で止まる
    expect(calls[1]!.previousResponse?.refs).toEqual({ u1: "n1" });
    expect(calls[1]!.previousResponse?.dropped.map((d) => d.reason)).toEqual(["親が存在しない"]);
    const restoredState = yield* restoreState(events.map((e) => JSON.parse(JSON.stringify(e)) as unknown));
    expect(restoredState.previousResponse).toBeUndefined();
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 3);
    yield* session.idle;
    expect("previousResponse" in calls[2]!).toBe(false);
  }));
});

describe("一時停止から戻った後の小分け", () => {
  const shot = (start: number): ScreenChange => ({ start, image: { id: `s${start}`, bytes: new Uint8Array([start]) } });
  const timed = (n: number, end: number): Remark => ({ id: `r${n}`, track: "相手", start: end - 1, end, text: `発言${n}。` });
  const maxEnd = (input: DiffInput) => Math.max(...input.fresh.map((r) => r.end));

  it.effect("溜まった発言は古い順に2発言以下ずつ渡り、つなげると溜まった分と一致する", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length === 1 ? Effect.fail(failure) : Effect.succeed({ ops: [] });
      })), silentLog,
    )));
    for (const n of [1, 2, 3, 4, 5, 6]) yield* session.push(remark(n));
    yield* session.idle;
    expect(calls).toHaveLength(1);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 4);
    yield* session.idle;
    expect(calls).toHaveLength(4);
    const retried = calls.slice(1).map((c) => ids(c.fresh));
    for (const fresh of retried) expect(fresh.length).toBeLessThanOrEqual(2);
    expect(retried.flat()).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(yield* session.unreflectedRemarks).toEqual([]);
  }));

  it.effect("溜まっている間に映り始めた共有画面は捨てられず、各回に添える画面はその回の発言のendを超えず、前の回の境目より後になる", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const calls: DiffInput[] = [];
    const written: { file: string; bytes: Uint8Array }[] = [];
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length === 1 ? Effect.fail(failure) : Effect.succeed({ ops: [] });
      })), collectLog(events, written),
    )));
    const ends = [10, 20, 30, 40, 50, 60];
    for (const [i, end] of ends.entries()) yield* session.push(timed(i + 1, end));
    yield* session.idle;
    expect(calls).toHaveLength(1);
    for (const start of [5, 15, 25, 35, 45]) yield* session.pushScreen(shot(start));
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 4);
    yield* session.idle;
    expect(calls).toHaveLength(4);
    const retried = calls.slice(1);
    let bound = -Infinity;
    for (const call of retried) {
      expect(call.fresh.length).toBeLessThanOrEqual(2);
      for (const screen of call.screens ?? []) {
        expect(screen.start).toBeLessThanOrEqual(maxEnd(call));
        expect(screen.start).toBeGreaterThan(bound);
      }
      bound = maxEnd(call);
    }
    expect(retried.flatMap((c) => (c.screens ?? []).map((s) => s.start))).toEqual([5, 15, 25, 35, 45]);
  }));

  it.effect("停止中にたまった共有画面は3枚上限で捨てられず、最初の回に全て添えられ、復元しても未送信に残らない", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const calls: DiffInput[] = [];
    const written: { file: string; bytes: Uint8Array }[] = [];
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length === 1 ? Effect.fail(failure) : Effect.succeed({ ops: [] });
      })), collectLog(events, written),
    )));
    yield* session.push(timed(1, 1));
    yield* session.idle;
    expect(calls).toHaveLength(1);
    for (const start of [5, 15, 25, 35, 45]) yield* session.pushScreen(shot(start));
    for (const [i, end] of [50, 60, 70, 80].entries()) yield* session.push(timed(i + 2, end));
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 4);
    yield* session.idle;
    const retried = calls.slice(1);
    expect(ids(retried[0]!.fresh)).toEqual(["r1", "r2"]);
    expect(retried[0]!.screens?.map((s) => s.start)).toEqual([5, 15, 25, 35, 45]);
    expect(retried.flatMap((c) => (c.screens ?? []).map((s) => s.start))).toEqual([5, 15, 25, 35, 45]);
    const diffs = events.filter((e) => e.type === "diff");
    expect(diffs[0]?.input.screens?.map((s) => s.start)).toEqual([5, 15, 25, 35, 45]);
    const restored = yield* restoreState(events.map((e) => JSON.parse(JSON.stringify(e)) as unknown));
    expect(restored.screens.unsent.map((h) => h.start)).toEqual([]);
  }));

  it.effect("停止中にたまった画面が最後の発言のendより後でも次の回に全て添え、渡し終えた後は3枚上限に戻る", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length === 1 ? Effect.fail(failure) : Effect.succeed({ ops: [] });
      })), collectLog([], []),
    )));
    yield* session.push(timed(1, 10));
    yield* session.idle;
    for (const start of [15, 25, 35, 45, 55]) yield* session.pushScreen(shot(start));
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 2);
    yield* session.idle;
    expect(calls[1]!.screens).toBeUndefined();
    yield* session.push(timed(2, 60));
    yield* session.idle;
    expect(calls).toHaveLength(3);
    expect(calls[2]!.screens?.map((s) => s.start)).toEqual([15, 25, 35, 45, 55]);
    for (const start of [65, 75, 85, 95]) yield* session.pushScreen(shot(start));
    yield* session.push(timed(3, 100));
    yield* session.idle;
    expect(calls).toHaveLength(4);
    expect(calls[3]!.screens?.map((s) => s.start)).toEqual([75, 85, 95]);
  }));

  it.effect("画面を添えた再試行が再び一時停止しても、次の再試行に同じ画面が全て添えられる", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length <= 2 ? Effect.fail(failure) : Effect.succeed({ ops: [] });
      })), collectLog([], []),
    )));
    yield* session.push(timed(1, 10));
    yield* session.idle;
    for (const start of [15, 25, 35, 45, 55]) yield* session.pushScreen(shot(start));
    yield* session.push(timed(2, 60));
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 2);
    yield* session.idle;
    expect(calls[1]!.screens?.map((s) => s.start)).toEqual([15, 25, 35, 45, 55]);
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 3);
    yield* session.idle;
    expect(calls).toHaveLength(3);
    expect(calls[2]!.screens?.map((s) => s.start)).toEqual([15, 25, 35, 45, 55]);
  }));

  it.effect("溜まった分を渡し終えた後は、呼び出し中に届いた発言を1回でまとめて渡す", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const gate = yield* Deferred.make<void>();
    const calls: string[][] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.gen(function* () {
        calls.push(ids(input.fresh));
        if (calls.length === 1) return yield* Effect.fail(failure);
        if (calls.length === 3) yield* Deferred.await(gate);
        return { ops: [] };
      })), silentLog,
    )));
    for (const n of [1, 2, 3, 4]) yield* session.push(remark(n));
    yield* session.idle;
    expect(calls).toEqual([["r1"]]);
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 3);
    expect(calls).toEqual([["r1"], ["r1", "r2"], ["r3", "r4"]]);
    for (const n of [5, 6, 7]) yield* session.push(remark(n));
    expect(calls).toHaveLength(3);
    yield* Deferred.succeed(gate, undefined);
    yield* session.idle;
    expect(calls).toEqual([["r1"], ["r1", "r2"], ["r3", "r4"], ["r5", "r6", "r7"]]);
  }));

  it.effect("溜まりの最後の回が一部だけ反映され、新着と重なっても、残りは2発言以下ずつ渡す", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const gate = yield* Deferred.make<void>();
    const calls: string[][] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.gen(function* () {
        calls.push(ids(input.fresh));
        if (calls.length === 1) return yield* Effect.fail(failure);
        if (calls.length === 3) {
          yield* Deferred.await(gate);
          return { ops: [], processedRemarks: 1 };
        }
        return { ops: [] };
      })), silentLog,
    )));
    for (const n of [1, 2, 3, 4]) yield* session.push(remark(n));
    yield* session.idle;
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 3);
    expect(calls).toEqual([["r1"], ["r1", "r2"], ["r3", "r4"]]);
    for (const n of [5, 6, 7]) yield* session.push(remark(n));
    yield* Deferred.succeed(gate, undefined);
    yield* session.idle;
    expect(calls).toEqual([["r1"], ["r1", "r2"], ["r3", "r4"], ["r4", "r5"], ["r6", "r7"]]);
  }));

  const outOfOrderStarts = [25, 35, 45, 55, 5];
  const expectOutOfOrderCatchUp = (calls: readonly DiffInput[], events: readonly LogEvent[]) => {
    expect(calls).toHaveLength(3);
    expect(ids(calls[1]!.fresh)).toEqual(["r1", "r2"]);
    expect(calls[1]!.screens?.map((s) => s.start)).toEqual([5]);
    expect(ids(calls[2]!.fresh)).toEqual(["r3"]);
    expect(calls[2]!.screens?.map((s) => s.start)).toEqual([25, 35, 45, 55]);
    const diffs = events.filter((e) => e.type === "diff");
    expect(diffs.map((e) => e.input.screens?.map((s) => s.start))).toEqual([[5], [25, 35, 45, 55]]);
  };

  it.effect("停止中に共有画面が時刻と食い違う順で届いても、startが最も遅い画面を印にして3枚上限で捨てない", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const calls: DiffInput[] = [];
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.suspend(() => {
        calls.push(input);
        return calls.length === 1 ? Effect.fail(failure) : Effect.succeed({ ops: [] });
      })), collectLog(events, []),
    )));
    yield* session.push(timed(1, 1));
    yield* session.idle;
    expect(calls).toHaveLength(1);
    for (const start of outOfOrderStarts) yield* session.pushScreen(shot(start));
    yield* session.push(timed(2, 10));
    yield* session.push(timed(3, 60));
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 3);
    yield* session.idle;
    expectOutOfOrderCatchUp(calls, events);
  }));

  it.effect("呼び出し中に共有画面が時刻と食い違う順で届き、その回が一時停止しても、startが最も遅い画面を印にする", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const gate = yield* Deferred.make<void>();
    const calls: DiffInput[] = [];
    const events: LogEvent[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      updaterLayer((input) => Effect.gen(function* () {
        calls.push(input);
        if (calls.length === 1) {
          yield* Deferred.await(gate);
          return yield* Effect.fail(failure);
        }
        return { ops: [] };
      })), collectLog(events, []),
    )));
    yield* session.push(timed(1, 1));
    yield* settleUntil(() => calls.length === 1);
    for (const start of outOfOrderStarts) yield* session.pushScreen(shot(start));
    yield* Deferred.succeed(gate, undefined);
    yield* session.idle;
    yield* session.push(timed(2, 10));
    yield* session.push(timed(3, 60));
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 3);
    yield* session.idle;
    expectOutOfOrderCatchUp(calls, events);
  }));
});
