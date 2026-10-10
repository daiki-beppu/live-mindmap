import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Sink, Stream, type Cause } from "effect";
import { ChildProcessSpawner, type ChildProcess } from "effect/process";
import { AppleIntelligence } from "../src/appleIntelligence.ts";
import { settleUntil } from "./fixtures/sessionLayers.ts";

// 計画のプロセス境界。問い合わせは一回で終了、launch は呼び出し側 Scope の資源を返す。
// 構造化した stdout の名前は実装時に変更できるが、準備待ちと寿命の assertion は維持する。
const fakeProcess = Effect.fnUntraced(function* (stdoutGate: Effect.Effect<void>) {
  const output = yield* Queue.make<Uint8Array, Cause.Done>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const reading = yield* Deferred.make<void>();
  const state = { spawned: [] as ChildProcess.StandardCommand[], closed: 0 };
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => Effect.gen(function* () {
    state.spawned.push(command as ChildProcess.StandardCommand);
    yield* Effect.addFinalizer(() => Effect.sync(() => { state.closed++; }));
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Deferred.await(exited),
      isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
      kill: () => Effect.asVoid(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
      stdin: Sink.drain,
      stdout: Stream.fromEffect(Effect.andThen(Deferred.succeed(reading, undefined), stdoutGate)).pipe(
        Stream.flatMap(() => Stream.fromQueue(output) as Stream.Stream<Uint8Array>),
      ),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  })));
  const emit = (text: string) => Queue.offer(output, new TextEncoder().encode(text));
  const exit = (code: number) => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(code));
  const closeOutput = Queue.end(output);
  const end = (code: number) => Effect.gen(function* () {
    yield* closeOutput;
    yield* exit(code);
  });
  return { state, layer, emit, end, exit, closeOutput, reading };
});
const boot = Effect.fnUntraced(function* (stdoutGate: Effect.Effect<void> = Effect.void) {
  const fake = yield* fakeProcess(stdoutGate);
  const apple = yield* AppleIntelligence.pipe(Effect.provide(
    AppleIntelligence.layer({ command: "fake-apple", args: [] }).pipe(Layer.provide(fake.layer)),
  ));
  return { fake, apple };
});

describe("Apple Intelligence の子プロセス", () => {
  for (const order of ["分類先行", "出力直後終了", "終了通知先行"] as const) {
    it.effect(`利用不可通知の理由と次の行動を終了順序によらず二行で保持する（${order}）`, () => Effect.gen(function* () {
      for (let attempt = 0; attempt < 3; attempt++) {
        const gate = yield* Deferred.make<void>();
        const { fake, apple } = yield* boot(Deferred.await(gate));
        const launching = yield* Effect.forkChild(Effect.scoped(Effect.result(apple.launch)));
        yield* Deferred.await(fake.reading);
        yield* fake.emit('{"osVersion":"27.0","availability":{"status":"unavailable","reason":"modelNotReady"}}\n');
        if (order === "終了通知先行") {
          yield* fake.exit(0);
          yield* Effect.yieldNow;
          yield* fake.closeOutput;
        }
        yield* Deferred.succeed(gate, undefined);
        if (order === "出力直後終了") yield* fake.end(0);
        const result = yield* Fiber.join(launching);
        if (order === "分類先行") yield* fake.end(0);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          const lines = result.failure.message.split("\n");
          expect(lines, result.failure.message).toHaveLength(2);
          expect(lines[0]).toContain("準備中");
          expect(lines[1]).toMatch(/待|しばらく/);
        }
        expect(fake.state.spawned).toHaveLength(1);
        expect(fake.state.closed).toBe(1);
      }
    }));
  }
  it.effect("availability を読み終えた問い合わせ子はセッション外に残さない", () => Effect.gen(function* () {
    const { fake, apple } = yield* boot();
    const querying = yield* Effect.forkChild(apple.availability);
    yield* settleUntil(() => fake.state.spawned.length === 1);
    expect(fake.state.spawned).toHaveLength(1);
    yield* fake.emit('{"osVersion":"27.0","availability":{"status":"available"}}\n');
    yield* fake.end(0);
    expect(yield* Fiber.join(querying)).toEqual({ osVersion: "27.0", availability: { status: "available" } });
    expect(fake.state.closed).toBe(1);
  }));

  it.effect("準備完了の行を全部受けるまで待ち、準備後も Scope の終了まで子を保持する", () => Effect.gen(function* () {
    const { fake, apple } = yield* boot();
    const ready = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const running = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
      const endpoint = yield* apple.launch;
      expect(endpoint.url).toBe("http://127.0.0.1:8766/v1");
      yield* Deferred.succeed(ready, undefined);
      yield* Deferred.await(finish);
    })));
    yield* settleUntil(() => fake.state.spawned.length === 1);
    expect(fake.state.spawned).toHaveLength(1);
    yield* fake.emit('{"type":"ready","url":"http://127.0.0.1:8766');
    yield* Effect.yieldNow;
    expect(yield* Deferred.isDone(ready)).toBe(false);
    yield* fake.emit('/v1","contextSize":8192}\n');
    yield* Deferred.await(ready);
    expect(fake.state.closed).toBe(0);
    expect(fake.state.spawned[0]!.command).toBe("fake-apple");
    expect(fake.state.spawned[0]!.options.forceKillAfter).toBe(5_000);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(running);
    expect(fake.state.closed).toBe(1);
  }));

  it.effect.each([0, 7])("準備完了より前に子が終了したら無期限に待たず拒否する（終了コード %s）", (code) => Effect.gen(function* () {
    const { fake, apple } = yield* boot();
    let finished = false;
    const launching = yield* Effect.forkChild(Effect.scoped(Effect.result(apple.launch)).pipe(Effect.tap(() => Effect.sync(() => { finished = true; }))));
    yield* settleUntil(() => fake.state.spawned.length === 1);
    expect(fake.state.spawned).toHaveLength(1);
    yield* fake.end(code);
    yield* settleUntil(() => finished);
    expect(finished).toBe(true);
    const result = yield* Fiber.join(launching);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.message).toContain("出力が閉じました");
    expect(fake.state.closed).toBe(1);
  }));

  it.effect("準備待ちを中断したら取得済みの子を停止する", () => Effect.gen(function* () {
    const { fake, apple } = yield* boot();
    const launching = yield* Effect.forkChild(Effect.scoped(apple.launch));
    yield* settleUntil(() => fake.state.spawned.length === 1);
    expect(fake.state.spawned).toHaveLength(1);
    expect(launching.pollUnsafe()).toBeUndefined();
    yield* Fiber.interrupt(launching);
    expect(fake.state.closed).toBe(1);
  }));

  it.effect("準備情報が外部の URL を示しても推論先として受理しない", () => Effect.gen(function* () {
    const { fake, apple } = yield* boot();
    const launching = yield* Effect.forkChild(Effect.scoped(Effect.result(apple.launch)));
    yield* settleUntil(() => fake.state.spawned.length === 1);
    expect(fake.state.spawned).toHaveLength(1);
    yield* fake.emit('{"type":"ready","url":"https://outside.invalid/v1","contextSize":8192}\n');
    const result = yield* Fiber.join(launching);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("UpdaterUnavailable");
      expect(result.failure.message).toContain("ループバック URL");
    }
    expect(fake.state.closed).toBe(1);
  }));

  it.effect("起動した子が利用不可になった場合も理由を二行で返して閉じる", () => Effect.gen(function* () {
    const { fake, apple } = yield* boot();
    const launching = yield* Effect.forkChild(Effect.scoped(Effect.result(apple.launch)));
    yield* settleUntil(() => fake.state.spawned.length === 1);
    expect(fake.state.spawned).toHaveLength(1);
    yield* fake.emit('{"osVersion":"27.0","availability":{"status":"unavailable","reason":"modelNotReady"}}\n');
    const result = yield* Fiber.join(launching);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message.split("\n")).toHaveLength(2);
      expect(result.failure.message).toContain("準備中");
    }
    expect(fake.state.closed).toBe(1);
  }));
});
