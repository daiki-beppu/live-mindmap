import { describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Result, Schema, Scope } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { emptyMap, LogEvent, makeSession, restoreSession, restoreState, type DiffInput, type DiffUpdateError, type Remark } from "../src/core/index.ts";
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
  const classify = yield* prepareChatgpt(CHATGPT_MODEL).pipe(
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
    yield* session.push(remark(2));
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
    yield* session.push(remark(2));
    yield* session.idle;
    const before = yield* session.snapshot;
    expect(before.round).toBe(1);
    expect(before.nodes.filter((n) => n.kind === "議題").flatMap((n) => n.evidence)).toEqual(["r1", "r2"]);
    yield* session.push(remark(3));
    yield* session.push(remark(4));
    yield* session.idle;
    const paused = yield* session.snapshot;
    expect(paused.nodes).toEqual(before.nodes);
    expect(paused.changes).toEqual(before.changes);
    expect(paused.round).toBe(before.round);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r3", "r4"]);
    yield* TestClock.adjust(FIVE_MINUTES);
    yield* settleUntil(() => calls.length === 3);
    yield* session.idle;
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1", "r2"], ["r3", "r4"], ["r3", "r4"]]);
    expect(ids(calls[2]!.recent)).toEqual(["r1", "r2"]);
    expect((yield* session.snapshot).nodes.filter((n) => n.kind === "議題").flatMap((n) => n.evidence)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(yield* session.unreflectedRemarks).toEqual([]);
  }));

  it.effect("429の発言と新着を保持し、5分ごとの再試行が成功したら文数上限で順に反映する", () => Effect.gen(function* () {
    const failure = yield* rateLimitFailure;
    const requests: string[][] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
      localUpdaterLayer((request) => Effect.suspend(() => {
        const sentences = [...request.prompt.matchAll(/^\d+\. \[(r\d+)\] (.+)$/gm)];
        requests.push(sentences.map((s) => s[1]!));
        return requests.length <= 2 ? Effect.fail(failure) : Effect.succeed({
          議題: { id: "新しい議題", 題: "採用" }, 文: sentences.map((s) => ({ 種類: "説明" as const, text: s[2]! })), 済み: "なし",
        });
      })), silentLog,
    )));
    yield* session.push(remark(1));
    yield* session.push(remark(2));
    yield* session.idle;
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2"]);
    expect((yield* session.snapshot).round).toBe(0);
    yield* TestClock.adjust(60_000);
    for (const n of [3, 4, 5, 6, 7]) yield* session.push(remark(n));
    yield* TestClock.adjust(FIVE_MINUTES - 60_000 - 1);
    yield* session.idle;
    expect(requests).toEqual([["r1", "r2"]]);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    yield* TestClock.adjust(1);
    yield* settleUntil(() => requests.length === 2);
    yield* session.idle;
    expect(requests).toEqual([["r1", "r2"], ["r1", "r2", "r3"]]);
    expect(ids(yield* session.unreflectedRemarks)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    yield* TestClock.adjust(FIVE_MINUTES - 1);
    expect(requests).toHaveLength(2);
    yield* TestClock.adjust(1);
    yield* settleUntil(() => requests.length === 5);
    yield* session.idle;
    expect(requests).toEqual([["r1", "r2"], ["r1", "r2", "r3"], ["r1", "r2", "r3"], ["r4", "r5", "r6"], ["r7"]]);
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
    expect(calls).toEqual([["r1", "r2"], ["r1", "r2"], ["r2", "r3"], ["r3"]]);
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
    expect(calls.map((c) => ids(c.fresh))).toEqual([["r1", "r2"], ["r1", "r2"], ["r3"]]);
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
});
