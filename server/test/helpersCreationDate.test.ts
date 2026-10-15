import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, PlatformError, Result, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Helpers } from "../src/helpers.ts";

// サーバーが起動するヘルパーの creation-date（録画のファイルの作成日時を 1 回だけ問い合わせる）の契約。
// 成功は ISO8601 の文字列か null。起動の失敗・0 以外の終了・壊れた出力は、型付きの失敗になる（呼び出し側が今の時刻へ切り替える）。

const processLayer = Effect.fnUntraced(function* (stdout: string, code: number) {
  const commands: ChildProcess.StandardCommand[] = [];
  const state = { closed: 0 };
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => Effect.gen(function* () {
    if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("問い合わせは単一のコマンドで実行する");
    commands.push(command);
    yield* Effect.addFinalizer(() => Effect.sync(() => { state.closed++; }));
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4243),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      isRunning: Effect.succeed(true), kill: () => Effect.void,
      stdin: Sink.drain, stdout: Stream.succeed(new TextEncoder().encode(stdout)),
      stderr: Stream.empty, all: Stream.empty,
      getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
    });
  })));
  const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "server-helper", args: ["existing-arg"] }).pipe(Layer.provide(layer))));
  return { helpers, commands, state };
});

describe("サーバーが起動するヘルパーの creation-date", () => {
  it.effect("既存引数の後に creation-date --file <path> を付け、JSON の作成日時を返しプロセスの Scope を閉じる", () => Effect.gen(function* () {
    const r = yield* processLayer(JSON.stringify({ creationDate: "2026-10-01T01:02:03Z" }) + "\n", 0);
    expect(yield* r.helpers.creationDate("/tmp/meeting.mov")).toBe("2026-10-01T01:02:03Z");
    expect(r.commands.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: "server-helper", args: ["existing-arg", "creation-date", "--file", "/tmp/meeting.mov"] },
    ]);
    expect(r.state.closed).toBe(1);
  }));

  it.effect("作成日時を持たないファイル（creationDate が null）は null で成功する", () => Effect.gen(function* () {
    const r = yield* processLayer(JSON.stringify({ creationDate: null }) + "\n", 0);
    expect(yield* r.helpers.creationDate("/tmp/meeting.wav")).toBeNull();
    expect(r.state.closed).toBe(1);
  }));

  it.effect.each([
    { stdout: "not-json", code: 0 },
    { stdout: JSON.stringify({ creationDate: 5 }), code: 0 },
    { stdout: JSON.stringify({}), code: 0 },
    { stdout: JSON.stringify({ creationDate: "2026-10-01T01:02:03Z" }), code: 1 },
  ])("不正出力または非ゼロ終了 $stdout / $code は型付き失敗になる", ({ stdout, code }) => Effect.gen(function* () {
    const r = yield* processLayer(stdout, code);
    expect(Result.isFailure(yield* Effect.result(r.helpers.creationDate("/tmp/meeting.mov")))).toBe(true);
    expect(r.commands).toHaveLength(1);
    expect(r.state.closed).toBe(1);
  }));

  it.effect("起動の失敗は型付き失敗になる（defect にならない）", () => Effect.gen(function* () {
    const error = PlatformError.systemError({ _tag: "NotFound", module: "ChildProcessSpawner", method: "spawn" });
    const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.fail(error)));
    const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "absent-helper", args: [] }).pipe(Layer.provide(spawner))));
    expect(Result.isFailure(yield* Effect.result(helpers.creationDate("/tmp/meeting.mov")))).toBe(true);
  }));
});
