import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Result, Scope } from "effect";
import { DiffUpdater, emptyMap, makeSession } from "../src/core/index.ts";
import { prepareUpdaterLayer } from "../src/diffUpdater.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { fakeAppleLifecycle, waitForDiffState } from "./fixtures/appleLifecycle.ts";
import { settleUntil, silentLog } from "./fixtures/sessionLayers.ts";

const input = { map: emptyMap("定例"), recent: [], fresh: [{ id: "r1", track: "相手" as const, start: 0, end: 1, text: "面接官は3人です。" }] };

describe("Apple の会議中の再起動", () => {
  it.effect("準備後から Session の購読開始前に終了しても、現在の再起動状態を失わない", () => Effect.gen(function* () {
    const fake = yield* fakeAppleLifecycle([{}, { holdReady: true }]);
    const layer = yield* fake.prepare;
    const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
    expect((yield* updater.update(input)).ops.length).toBeGreaterThan(0);
    yield* fake.crash(0);
    yield* settleUntil(() => fake.processes.length === 2);
    expect(fake.processes).toHaveLength(2);
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(layer, silentLog)));
    yield* waitForDiffState(session, "restarting");
    expect(yield* session.diffUpdate).toEqual({ status: "restarting" });
  }));

  it.effect("同じ updater が子の終了後に3回まで起動し直し、新しい ready の URL で更新してから上限で止まる", () => Effect.gen(function* () {
    const fake = yield* fakeAppleLifecycle([{}, { holdReady: true }, { holdReady: true }, { holdReady: true }]);
    const layer = yield* fake.prepare;
    const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(layer, silentLog)));
    expect((yield* updater.update(input)).ops.length).toBeGreaterThan(0);
    for (let restart = 1; restart <= 3; restart++) {
      yield* fake.crash(restart - 1);
      yield* settleUntil(() => fake.processes.length === restart + 1);
      yield* waitForDiffState(session, "restarting");
      expect(yield* session.diffUpdate).toEqual({ status: "restarting" });
      yield* fake.releaseReady(restart);
      yield* waitForDiffState(session, "running");
      expect(yield* session.diffUpdate).toEqual({ status: "running" });
      expect(fake.processes).toHaveLength(restart + 1);
      expect(fake.processes[restart - 1]!.closed).toBe(true);
      const before = fake.requests.length;
      expect((yield* updater.update(input)).ops.length).toBeGreaterThan(0);
      expect(fake.requests.slice(before).map((r) => r.url)).toEqual([`${fake.processes[restart]!.url}/chat/completions`]);
    }
    yield* fake.crash(3);
    yield* settleUntil(() => fake.processes[3]!.closed);
    const result = yield* Effect.result(updater.update(input));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("DiffUpdateStopped");
    expect(fake.processes).toHaveLength(4);
  }));

  it.effect("ready を待っている再起動中の更新は HTTP を送らず通常失敗し、ready 後は同じ updater で更新する", () => Effect.gen(function* () {
    const fake = yield* fakeAppleLifecycle([{}, { holdReady: true }]);
    const layer = yield* fake.prepare;
    const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(layer, silentLog)));
    expect((yield* updater.update(input)).ops.length).toBeGreaterThan(0);
    yield* fake.crash(0);
    yield* settleUntil(() => fake.processes.length === 2);
    expect(fake.processes).toHaveLength(2);
    yield* waitForDiffState(session, "restarting");
    expect(yield* session.diffUpdate).toEqual({ status: "restarting" });
    const before = fake.requests.length;
    const result = yield* Effect.result(updater.update(input));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).not.toBe("DiffUpdatePaused");
      expect(result.failure._tag).not.toBe("DiffUpdateStopped");
    }
    expect(fake.requests).toHaveLength(before);
    yield* fake.releaseReady(1);
    yield* waitForDiffState(session, "running");
    expect(yield* session.diffUpdate).toEqual({ status: "running" });
    expect((yield* updater.update(input)).ops.length).toBeGreaterThan(0);
    expect(fake.requests.at(-1)!.url).toBe(`${fake.processes[1]!.url}/chat/completions`);
  }));

  it.effect("失敗した再起動も3回の上限へ数え、取得した子をすべて閉じる", () => Effect.gen(function* () {
    const fake = yield* fakeAppleLifecycle([{}, { invalidReady: true }, { invalidReady: true }, { invalidReady: true }]);
    const updater = yield* DiffUpdater.pipe(Effect.provide(yield* fake.prepare));
    expect((yield* updater.update(input)).ops.length).toBeGreaterThan(0);
    yield* fake.crash(0);
    yield* settleUntil(() => fake.processes.length >= 4 && fake.processes[3]!.closed);
    expect(fake.processes).toHaveLength(4);
    expect(fake.processes.every((p) => p.closed)).toBe(true);
    const result = yield* Effect.result(updater.update(input));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("DiffUpdateStopped");
  }));

  it.effect.each([false, true])("会議 Scope の終了は再起動せず、取得済みの子を閉じる（ready 待ち %s）", (holdReady) => Effect.gen(function* () {
    const fake = yield* fakeAppleLifecycle([{}, { holdReady }]);
    const scope = yield* Effect.acquireRelease(Scope.make(), (s) => Scope.close(s, Exit.void));
    const updater = yield* DiffUpdater.pipe(Effect.provide(yield* fake.prepare.pipe(Scope.provide(scope))), Scope.provide(scope));
    expect((yield* updater.update(input)).ops.length).toBeGreaterThan(0);
    if (holdReady) {
      yield* fake.crash(0);
      yield* settleUntil(() => fake.processes.length === 2);
      expect(fake.processes).toHaveLength(2);
    }
    const count = fake.processes.length;
    yield* Scope.close(scope, Exit.void);
    yield* settleUntil(() => fake.processes.every((p) => p.closed));
    expect(fake.processes.every((p) => p.closed)).toBe(true);
    expect(fake.processes).toHaveLength(count);
  }));

  it.effect("非 Apple の互換モデルは正常更新後の HTTP 失敗でも Apple を起動しない", () => Effect.gen(function* () {
    const fake = yield* fakeAppleLifecycle([]);
    const model = { name: "compatible", route: "openai-compatible", model: "synthetic", local: false, url: "http://compatible.invalid/v1" } as const;
    const layer = yield* prepareUpdaterLayer(model).pipe(Effect.provide(Layer.merge(fake.deps, unusedApple)));
    const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
    expect((yield* updater.update(input)).ops.length).toBeGreaterThan(0);
    fake.control.status = 500;
    const result = yield* Effect.result(updater.update(input));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).not.toBe("DiffUpdateStopped");
    expect(fake.requests).toHaveLength(3);
    expect(fake.processes).toEqual([]);
  }));
});
