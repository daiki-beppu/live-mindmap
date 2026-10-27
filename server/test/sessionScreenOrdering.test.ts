import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePaused, makeSession, restoreSession, restoreState, type DiffInput, type LogEvent, type Remark, type ScreenChange } from "../src/core/index.ts";
import { logLayer, updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

const spoken = (end: number): Remark => ({ id: `r${end}`, track: "相手", start: end - 1, end, text: "発言。" });
const shot = (start: number): ScreenChange => ({ start, image: { id: `s${start}`, bytes: new Uint8Array([start]) } });
const pause = new DiffUpdatePaused({ reason: "ChatGPT の利用上限", message: "上限" });

const waitFor = Effect.fnUntraced(function* (condition: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`${description} が期限内に完了しなかった`);
    yield* Effect.yieldNow;
  }
});

const barrier = Effect.fnUntraced(function* () {
  const released = yield* Deferred.make<void>();
  let entered = false;
  return {
    hold: Effect.gen(function* () {
      entered = true;
      yield* Deferred.await(released);
    }),
    wait: waitFor(() => entered, "ログ書き込み境界への到達"),
    release: Deferred.succeed(released, undefined),
  };
});

const recording = (beforeWrite: (event: LogEvent) => Effect.Effect<void>, afterWrite?: (event: LogEvent) => Effect.Effect<void>) => {
  const events: LogEvent[] = [];
  const files = new Map<string, Uint8Array>();
  const log = logLayer(
    (event) => Effect.gen(function* () {
      yield* beforeWrite(event);
      events.push(event);
      if (afterWrite) yield* afterWrite(event);
    }),
    (file, bytes) => Effect.sync(() => { files.set(file, bytes); }),
    (file) => Effect.sync(() => {
      const bytes = files.get(file);
      if (bytes === undefined) throw new Error(`画像が保存されていない: ${file}`);
      return bytes;
    }),
  );
  return { events, log };
};

describe("共有画面の受け取りと呼び出しの結末の記録順", () => {
  it.effect("screen 行の保存後に受信を中断しても、記録した画面は続きと復元後の両方に添えられる", () => Effect.gen(function* () {
    const screenWrite = yield* barrier();
    const { events, log } = recording(() => Effect.void, (event) => event.type === "screen" ? screenWrite.hold : Effect.void);
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(log, updaterLayer((input) => {
      calls.push(input);
      return Effect.succeed({ ops: [] });
    }))));
    const receiving = yield* session.pushScreen(shot(10)).pipe(Effect.forkChild({ startImmediately: true }));
    yield* screenWrite.wait;
    const interrupting = yield* Fiber.interrupt(receiving).pipe(Effect.forkChild({ startImmediately: true }));
    yield* screenWrite.release;
    yield* Fiber.join(interrupting);
    const logged = [...events];
    const restoredCalls: DiffInput[] = [];
    const restored = yield* restoreSession(logged).pipe(Effect.provide(Layer.merge(log, updaterLayer((input) => {
      restoredCalls.push(input);
      return Effect.succeed({ ops: [] });
    }))));
    yield* session.push(spoken(20));
    yield* session.idle;
    yield* restored.push(spoken(20));
    yield* restored.idle;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.screens).toEqual([{ start: 10, image: { id: "0010.0.jpg", bytes: new Uint8Array([10]) } }]);
    expect(restoredCalls).toHaveLength(1);
    expect(restoredCalls[0]!.screens).toEqual(calls[0]!.screens);
  }));

  it.effect("screen 行の保存後に一時停止と再試行が重なっても、元と復元した続きは同じ4画面を添える", () => Effect.gen(function* () {
    const screenWrite = yield* barrier();
    const reply = yield* Deferred.make<void>();
    const { events, log } = recording(() => Effect.void, (event) => event.type === "screen" && event.start === 10 ? screenWrite.hold : Effect.void);
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(log, updaterLayer((input) => {
      calls.push(input);
      return calls.length === 1 ? Deferred.await(reply).pipe(Effect.andThen(Effect.fail(pause))) : Effect.succeed({ ops: [] });
    }))));
    yield* session.push(spoken(1));
    yield* waitFor(() => calls.length === 1, "一時停止する呼び出しの開始");
    const receiving = yield* session.pushScreen(shot(10)).pipe(Effect.forkChild({ startImmediately: true }));
    yield* screenWrite.wait;
    yield* Deferred.succeed(reply, undefined);
    // 全 Fiber が待ちに入ってから時計が進む。結末が画面の記録完了を待つ場合も、ここでは待ち合わせない。
    yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
    yield* screenWrite.release;
    yield* Fiber.join(receiving);
    yield* session.idle;
    yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
    yield* waitFor(() => calls.length === 2, "画面の記録完了後の再試行");
    yield* session.idle;
    const logged = [...events];
    const restoredCalls: DiffInput[] = [];
    const restored = yield* restoreSession(logged).pipe(Effect.provide(Layer.merge(log, updaterLayer((input) => {
      restoredCalls.push(input);
      return Effect.succeed({ ops: [] });
    }))));
    for (const start of [20, 30, 40]) {
      yield* session.pushScreen(shot(start));
      yield* restored.pushScreen(shot(start));
    }
    yield* session.push(spoken(50));
    yield* session.idle;
    yield* restored.push(spoken(50));
    yield* restored.idle;
    expect(calls[2]!.screens?.map((screen) => screen.start)).toEqual([10, 20, 30, 40]);
    expect(restoredCalls).toHaveLength(1);
    expect(restoredCalls[0]!.screens).toEqual(calls[2]!.screens);
  }));

  it.effect.each([false, true])("screen の書き込み待ちと更新が重なっても、diff の件数は先行する screen 行数を超えない（通常失敗: %s）", (fail) => Effect.gen(function* () {
    const screenWrite = yield* barrier();
    const { events, log } = recording((event) => event.type === "screen" ? screenWrite.hold : Effect.void);
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(log, updaterLayer((input) => {
      calls.push(input);
      return fail ? Effect.fail({ _tag: "UpdateFailed", message: "通常失敗" }) : Effect.succeed({ ops: [] });
    }))));
    const receiving = yield* session.pushScreen(shot(10)).pipe(Effect.forkChild({ startImmediately: true }));
    yield* screenWrite.wait;
    yield* session.push(spoken(20));
    yield* waitFor(() => calls.length === 1, "書き込み待ち中の差分更新の開始");
    yield* screenWrite.release;
    yield* Fiber.join(receiving);
    yield* session.idle;
    yield* session.push(spoken(30));
    yield* session.idle;

    const diffs = events.filter((event) => event.type === "diff");
    expect(diffs).toHaveLength(2);
    expect(diffs[0]!.error !== undefined).toBe(fail);
    let screens = 0;
    for (const event of events) {
      if (event.type === "screen") screens++;
      if (event.type === "diff") expect(event.input.screenCount ?? 0).toBeLessThanOrEqual(screens);
    }
    yield* restoreState(events);
    expect(calls[1]!.screens).toEqual([{ start: 10, image: { id: "0010.0.jpg", bytes: new Uint8Array([10]) } }]);
  }));

  it.effect.each([false, true])("再試行の diff 書き込み中に受けた画面は、ライブと復元した続きで一致する（通常失敗: %s）", (fail) => Effect.gen(function* () {
    const diffWrite = yield* barrier();
    const { events, log } = recording((event) => event.type === "diff" ? diffWrite.hold : Effect.void);
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(log, updaterLayer((input): Effect.Effect<{ ops: [] }, UpdateFailure> => {
      calls.push(input);
      if (calls.length === 1) return Effect.fail(pause);
      return fail ? Effect.fail({ _tag: "UpdateFailed", message: "通常失敗" }) : Effect.succeed({ ops: [] });
    }))));
    yield* session.push(spoken(1));
    yield* session.idle;
    expect((yield* session.diffUpdate).status).toBe("paused");
    yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
    yield* diffWrite.wait;
    const receivers = [];
    for (const start of [10, 20, 30, 40]) {
      receivers.push(yield* session.pushScreen(shot(start)).pipe(Effect.forkChild({ startImmediately: true })));
    }
    yield* diffWrite.release;
    for (const receiver of receivers) yield* Fiber.join(receiver);
    yield* session.idle;
    const logged = events.map((event): unknown => JSON.parse(JSON.stringify(event)));
    const restoredCalls: DiffInput[] = [];
    const restored = yield* restoreSession(logged).pipe(Effect.provide(Layer.merge(log, updaterLayer((input) => {
      restoredCalls.push(input);
      return Effect.succeed({ ops: [] });
    }))));
    yield* session.push(spoken(50));
    yield* session.idle;
    yield* restored.push(spoken(50));
    yield* restored.idle;

    expect(calls).toHaveLength(3);
    expect(restoredCalls).toHaveLength(1);
    expect(calls[2]!.screens?.map((screen) => screen.start)).toEqual([20, 30, 40]);
    expect(restoredCalls[0]!.screens).toEqual(calls[2]!.screens);
  }));

  it.effect("一時停止の記録待ちに届いた画面は、停止の行に続いて記録され、復元した再試行にも全件添えられる", () => Effect.gen(function* () {
    const pausedWrite = yield* barrier();
    const { events, log } = recording((event) => event.type === "diff-update-paused" ? pausedWrite.hold : Effect.void);
    const calls: DiffInput[] = [];
    const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(log, updaterLayer((input) => {
      calls.push(input);
      return calls.length === 1 ? Effect.fail(pause) : Effect.succeed({ ops: [] });
    }))));
    yield* session.push(spoken(1));
    yield* pausedWrite.wait;
    const receivers = [];
    for (const start of [10, 20, 30, 40]) {
      receivers.push(yield* session.pushScreen(shot(start)).pipe(Effect.forkChild({ startImmediately: true })));
    }
    yield* pausedWrite.release;
    for (const receiver of receivers) yield* Fiber.join(receiver);
    yield* session.idle;
    const logged = [...events];
    const restoredCalls: DiffInput[] = [];
    const restored = yield* restoreSession(logged).pipe(Effect.provide(Layer.merge(log, updaterLayer((input) => {
      restoredCalls.push(input);
      return Effect.succeed({ ops: [] });
    }))));
    yield* session.push(spoken(50));
    yield* restored.push(spoken(50));
    yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
    yield* waitFor(() => calls.length === 2 && restoredCalls.length === 1, "ライブと復元したセッションの再試行");
    yield* session.idle;
    yield* restored.idle;

    expect(logged.filter((event) => event.type === "screen" || event.type === "diff-update-paused").map((event) => event.type))
      .toEqual(["diff-update-paused", "screen", "screen", "screen", "screen"]);
    expect(calls[1]!.screens?.map((screen) => screen.start)).toEqual([10, 20, 30, 40]);
    expect(restoredCalls[0]!.screens).toEqual(calls[1]!.screens);
  }));
});
