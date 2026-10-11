import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, PlatformError, Result, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Helpers } from "../src/helpers.ts";

const status = { microphone: "authorized", screenCapture: true, speechJa: { status: "supported", installedLocales: [] } };
const processLayer = Effect.fnUntraced(function* (stdout: string, code: number, exitGate: Effect.Effect<void>) {
  const commands: ChildProcess.StandardCommand[] = [];
  const state = { closed: 0 };
  const entered = yield* Deferred.make<void>();
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => Effect.gen(function* () {
    if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("確認は単一のコマンドで実行する");
    commands.push(command);
    yield* Effect.addFinalizer(() => Effect.sync(() => { state.closed++; }));
    yield* Deferred.succeed(entered, undefined);
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.andThen(exitGate, Effect.succeed(ChildProcessSpawner.ExitCode(code))),
      isRunning: Effect.succeed(true), kill: () => Effect.void,
      stdin: Sink.drain, stdout: Stream.succeed(new TextEncoder().encode(stdout)),
      stderr: Stream.empty, all: Stream.empty,
      getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
    });
  })));
  const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "server-helper", args: ["existing-arg"] }).pipe(Layer.provide(layer))));
  return { helpers, commands, state, entered: Deferred.await(entered) };
});

describe("サーバーが起動するヘルパーの check", () => {
  it.effect("C1: 既存引数の後に check を付け、一行の JSON を復号しプロセスの Scope を閉じる", () => Effect.gen(function* () {
    const r = yield* processLayer(JSON.stringify(status) + "\n", 0, Effect.void);
    expect(Effect.isEffect(r.helpers.check)).toBe(true);
    expect(yield* r.helpers.check).toEqual(status);
    expect(r.commands.map(({ command, args }) => ({ command, args }))).toEqual([{ command: "server-helper", args: ["existing-arg", "check"] }]);
    expect(r.state.closed).toBe(1);
  }));

  it.effect("C4: 画面を確認しないコマンドは --no-screen を渡し画面結果なしで成功する", () => Effect.gen(function* () {
    const output = { microphone: status.microphone, speechJa: status.speechJa };
    const r = yield* processLayer(JSON.stringify(output) + "\n", 0, Effect.void);
    expect(Effect.isEffect(r.helpers.checkNoScreen)).toBe(true);
    expect(yield* r.helpers.checkNoScreen).toEqual(output);
    expect(r.commands.map(({ args }) => args)).toEqual([["existing-arg", "check", "--no-screen"]]);
    expect(r.state.closed).toBe(1);
  }));

  it.effect.each([
    { stdout: "not-json", code: 0 },
    { stdout: JSON.stringify({ ...status, microphone: "invalid" }), code: 0 },
    { stdout: JSON.stringify({ microphone: "authorized", speechJa: status.speechJa }), code: 0 },
    { stdout: JSON.stringify(status), code: 1 },
  ])("C1・C3: 不正出力または非ゼロ終了 $stdout / $code は型付き失敗になる", ({ stdout, code }) => Effect.gen(function* () {
    const r = yield* processLayer(stdout, code, Effect.void);
    expect(Effect.isEffect(r.helpers.check)).toBe(true);
    expect(Result.isFailure(yield* Effect.result(r.helpers.check))).toBe(true);
    expect(r.commands).toHaveLength(1);
    expect(r.state.closed).toBe(1);
  }));

  it.effect("C3: 起動失敗は型付き失敗となる", () => Effect.gen(function* () {
    const error = PlatformError.systemError({ _tag: "NotFound", module: "ChildProcessSpawner", method: "spawn" });
    const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.fail(error)));
    const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "absent-helper", args: [] }).pipe(Layer.provide(spawner))));
    expect(Effect.isEffect(helpers.check)).toBe(true);
    expect(Result.isFailure(yield* Effect.result(helpers.check))).toBe(true);
  }));

  it.effect("C1: 終了を待つ確認を中断すると、開始済みプロセスの Scope を閉じる", () => Effect.gen(function* () {
    const r = yield* processLayer(JSON.stringify(status), 0, Effect.never);
    expect(Effect.isEffect(r.helpers.check)).toBe(true);
    const fiber = yield* Effect.forkChild(r.helpers.check);
    yield* r.entered;
    expect(r.commands).toHaveLength(1);
    yield* Fiber.interrupt(fiber);
    expect(r.state.closed).toBe(1);
  }));
});
