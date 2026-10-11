import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, PlatformError, Result, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { afterEach, vi } from "vitest";
import { claudeJudge } from "../bench/claudeJudge.ts";

afterEach(() => vi.unstubAllEnvs());

function fakeProcess(stdout: string, stderr: string, code: number, exitWait: Effect.Effect<void>) {
  const commands: ChildProcess.StandardCommand[] = [];
  const state = { closed: 0 };
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => Effect.gen(function* () {
    if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("単一コマンドとしてClaudeを起動する");
    commands.push(command);
    yield* Effect.addFinalizer(() => Effect.sync(() => { state.closed++; }));
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.andThen(exitWait, Effect.succeed(ChildProcessSpawner.ExitCode(code))),
      isRunning: Effect.succeed(false), kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.fromIterable([new TextEncoder().encode(stdout.slice(0, 4)), new TextEncoder().encode(stdout.slice(4))]),
      stderr: Stream.succeed(new TextEncoder().encode(stderr)), all: Stream.empty,
      getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
    });
  })));
  return { commands, state, layer };
}

describe("既定のClaude判定器（実プロセスは起動しない）", () => {
  it.effect("C2・C4: 指定モデルとプロンプトをargvに渡し、APIキーを子へ継承せず応答を返す", () => Effect.gen(function* () {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-must-not-transfer");
    vi.stubEnv("PATH", "/synthetic/bin");
    const prompt = '親の本文\n子の本文 "quoted" $(must-stay-literal)';
    const response = '["具体化","なし"]';
    const fake = fakeProcess(response, "", 0, Effect.void);
    const result = yield* claudeJudge(prompt).pipe(Effect.provide(fake.layer));
    expect(result).toBe(response);
    expect(fake.commands).toHaveLength(1);
    const command = fake.commands[0]!;
    expect(command.command).toBe("claude");
    expect(command.args).toEqual(["-p", "--model", "claude-sonnet-5-5", prompt]);
    expect(command.options.shell === undefined || command.options.shell === false).toBe(true);
    const env = command.options.extendEnv ? { ...process.env, ...command.options.env } : command.options.env;
    expect(env?.PATH).toBe("/synthetic/bin");
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe("test-key-must-not-transfer");
    expect(fake.state.closed).toBe(1);
  }));

  it.effect("C3: 非ゼロ終了を失敗とし、入力・stdout・stderrをエラーへ残さずScopeを閉じる", () => Effect.gen(function* () {
    const secrets = ["SYNTHETIC_PROMPT_BODY", "SYNTHETIC_STDOUT_BODY", "SYNTHETIC_STDERR_BODY"];
    const fake = fakeProcess(secrets[1]!, secrets[2]!, 7, Effect.void);
    const result = yield* claudeJudge(secrets[0]!).pipe(Effect.provide(fake.layer), Effect.result);
    expect(fake.commands).toHaveLength(1);
    expect(Result.isFailure(result)).toBe(true);
    expect(fake.state.closed).toBe(1);
    if (Result.isFailure(result)) {
      for (const secret of secrets) {
        expect(String(result.failure)).not.toContain(secret);
        expect(JSON.stringify(result.failure)).not.toContain(secret);
      }
    }
  }));

  it.effect("C3: 起動エラーに本文が混じっても、生のエラーを呼出し側へ渡さない", () => Effect.gen(function* () {
    let calls = 0;
    const secret = "SYNTHETIC_SPAWN_BODY";
    const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => {
      calls++;
      return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcessSpawner", method: "spawn", description: secret }));
    }));
    const result = yield* claudeJudge(secret).pipe(Effect.provide(layer), Effect.result);
    expect(calls).toBe(1);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(String(result.failure)).not.toContain(secret);
      expect(JSON.stringify(result.failure)).not.toContain(secret);
    }
  }));

  it.effect("C2: 終了待ちの判定を中断すると開始済みプロセスのScopeを閉じる", () => Effect.gen(function* () {
    const fake = fakeProcess('["なし"]', "", 0, Effect.never);
    const fiber = yield* Effect.forkChild(claudeJudge("合成本文").pipe(Effect.provide(fake.layer)));
    while (fake.commands.length === 0) yield* Effect.yieldNow;
    expect(fake.commands).toHaveLength(1);
    expect(fake.state.closed).toBe(0);
    yield* Fiber.interrupt(fiber);
    expect(fake.state.closed).toBe(1);
  }));
});
