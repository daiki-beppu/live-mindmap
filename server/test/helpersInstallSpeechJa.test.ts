import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, PlatformError, Result, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Helpers } from "../src/helpers.ts";

const processLayer = Effect.fnUntraced(function* (stderr: Stream.Stream<Uint8Array>, code: number, exitGate: Effect.Effect<void>) {
  const commands: ChildProcess.StandardCommand[] = [];
  const state = { closed: 0 };
  const entered = yield* Deferred.make<void>();
  const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => Effect.gen(function* () {
    if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("導入は単一コマンド");
    commands.push(command);
    yield* Effect.addFinalizer(() => Effect.sync(() => { state.closed++; }));
    yield* Deferred.succeed(entered, undefined);
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.andThen(exitGate, Effect.succeed(ChildProcessSpawner.ExitCode(code))),
      isRunning: Effect.succeed(true), kill: () => Effect.void,
      stdin: Sink.drain, stdout: Stream.empty, stderr, all: Stream.empty,
      getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
    });
  })));
  const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "server-helper", args: ["existing-arg"] }).pipe(Layer.provide(spawner))));
  return { helpers, commands, state, entered: Deferred.await(entered) };
});

describe("サーバー指定のヘルパーによる日本語モデルの導入", () => {
  it.effect("710-3: 分割された UTF-8 と行を復号し、同じ実行ファイルで一度起動し、末尾まで読んで終了する", () => Effect.gen(function* () {
    const bytes = new TextEncoder().encode("予約\n取得完了\n末尾");
    const r = yield* processLayer(Stream.fromIterable([bytes.slice(0, 1), bytes.slice(1, 8), bytes.slice(8)]), 0, Effect.void);
    expect(Stream.isStream(r.helpers.installSpeechJa)).toBe(true);
    expect(yield* Stream.runCollect(r.helpers.installSpeechJa)).toEqual(["予約", "取得完了", "末尾"]);
    expect(r.commands.map(({ command, args }) => ({ command, args }))).toEqual([{ command: "server-helper", args: ["existing-arg", "install-speech-ja"] }]);
    expect(r.state.closed).toBe(1);
  }));
  it.effect("710-3: 完了前に進捗を流し、プロセス終了までは導入を完了しない", () => Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const progress = yield* Deferred.make<void>();
    const r = yield* processLayer(Stream.succeed(new TextEncoder().encode("取得中\n")), 0, Deferred.await(release));
    expect(Stream.isStream(r.helpers.installSpeechJa)).toBe(true);
    const fiber = yield* Effect.forkChild(Stream.runForEach(r.helpers.installSpeechJa, (line) => Effect.gen(function* () {
      expect(line).toBe("取得中");
      yield* Deferred.succeed(progress, undefined);
    })));
    yield* Deferred.await(progress);
    yield* Effect.yieldNow;
    expect(fiber.pollUnsafe()).toBeUndefined();
    expect(r.state.closed).toBe(0);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    expect(r.state.closed).toBe(1);
  }));
  it.effect("710-3: 非ゼロ終了は stderr の理由を残した型付き失敗でプロセスを閉じる", () => Effect.gen(function* () {
    const r = yield* processLayer(Stream.succeed(new TextEncoder().encode("日本語モデルは非対応\n")), 1, Effect.void);
    expect(Stream.isStream(r.helpers.installSpeechJa)).toBe(true);
    const result = yield* Effect.result(Stream.runCollect(r.helpers.installSpeechJa));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.message).toContain("日本語モデルは非対応");
    expect(r.commands).toHaveLength(1);
    expect(r.state.closed).toBe(1);
  }));
  it.effect("710-3: 起動失敗は型付き失敗になる", () => Effect.gen(function* () {
    const error = PlatformError.systemError({ _tag: "NotFound", module: "ChildProcessSpawner", method: "spawn" });
    const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.fail(error)));
    const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "absent-helper", args: [] }).pipe(Layer.provide(spawner))));
    expect(Stream.isStream(helpers.installSpeechJa)).toBe(true);
    expect(Result.isFailure(yield* Effect.result(Stream.runCollect(helpers.installSpeechJa)))).toBe(true);
  }));
  it.effect("710-3: 導入中断は開始済み子プロセスの Scope を閉じる", () => Effect.gen(function* () {
    const r = yield* processLayer(Stream.empty, 0, Effect.never);
    expect(Stream.isStream(r.helpers.installSpeechJa)).toBe(true);
    const fiber = yield* Effect.forkChild(Stream.runDrain(r.helpers.installSpeechJa));
    yield* r.entered;
    expect(r.commands).toHaveLength(1);
    yield* Fiber.interrupt(fiber);
    expect(r.state.closed).toBe(1);
  }));
});
