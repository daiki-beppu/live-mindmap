import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, PlatformError, Result, Scope, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Readings, ReadingsFailed } from "../src/readings.ts";

const encode = (s: string) => new TextEncoder().encode(s);

// ChildProcessSpawner だけを偽物にして、本物の Readings.layer を通す
const readingsWith = (spawn: (command: ChildProcess.StandardCommand) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError, Scope.Scope>) => {
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => (ChildProcess.isStandardCommand(command) ? spawn(command) : Effect.die("単一のコマンドで実行する"))),
  );
  return Readings.pipe(Effect.provide(Readings.layer({ command: "server-helper", args: [] }).pipe(Layer.provide(spawner))));
};

const handle = (stdout: string, stderr: string, code: number) =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      isRunning: Effect.succeed(false), kill: () => Effect.void,
      stdin: Sink.drain, stdout: Stream.succeed(encode(stdout)),
      stderr: Stream.succeed(encode(stderr)), all: Stream.empty,
      getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
    }),
  );

describe("Readings.layer: ヘルパーの失敗を ReadingsFailed に変える", () => {
  it.effect("終了コード 0 で標準出力が読める JSON なら、その配列を返す（ヘルパー名の後に readings と語を渡す）", () => Effect.gen(function* () {
    const commands: ReadonlyArray<string>[] = [];
    const readings = yield* readingsWith((command) => {
      commands.push(command.args);
      return handle('[{"surface":"港南店","romaji":"kounanten"}]', "", 0);
    });
    expect(yield* readings.readings(["港南店"])).toEqual([{ surface: "港南店", romaji: "kounanten" }]);
    expect(commands).toEqual([["readings", "港南店"]]);
  }));

  it.effect("起動に失敗（PlatformError）すると ReadingsFailed になる", () => Effect.gen(function* () {
    const readings = yield* readingsWith(() => Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcessSpawner", method: "spawn" })));
    const result = yield* Effect.result(readings.readings(["港南店"]));
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(ReadingsFailed);
  }));

  it.effect("終了コードが 0 以外だと ReadingsFailed になる", () => Effect.gen(function* () {
    const readings = yield* readingsWith(() => handle("", "boom", 1));
    const result = yield* Effect.result(readings.readings(["港南店"]));
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(ReadingsFailed);
  }));

  it.effect("終了コード 0 でも標準出力が JSON として読めないと ReadingsFailed になる", () => Effect.gen(function* () {
    const readings = yield* readingsWith(() => handle("not-json", "", 0));
    const result = yield* Effect.result(readings.readings(["港南店"]));
    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(ReadingsFailed);
  }));
});
