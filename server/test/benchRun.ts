// bench のスクリプトを Command として走らせるテスト用の補助。stdout は Console を差し替えて集める。
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer, Predicate, Result } from "effect";
import { CliError, Command } from "effect/cli";

export const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-bench-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

// Console.log に渡された引数を、末尾の改行込みの 1 行として stdout に集める（本物の Console.log と同じ区切り）
export function consoleCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const service: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  return { layer: Layer.mergeAll(NodeServices.layer, Layer.succeed(Console.Console, service)), stdout, stderr };
}

// 走らせて、成功か失敗かを Result で返す（失敗は表示せず、タグ付きの失敗のまま観測する）
export function runCommand<Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  argv: string[],
  capture = consoleCapture(),
) {
  return Command.runWith(command, { version: "0.0.0" })(argv).pipe(
    Effect.provide(capture.layer),
    Effect.result,
    Effect.map((result) => ({ result, stdout: capture.stdout.join(""), stderr: capture.stderr.join("") })),
  );
}

// タグ付きの失敗（CliError ではない）の _tag と全体を取り出す
export function taggedFailure(result: Result.Result<unknown, unknown>): { _tag: string; [key: string]: unknown } | undefined {
  if (Result.isSuccess(result)) return undefined;
  const failure = result.failure;
  if (CliError.isCliError(failure)) return undefined;
  if (!Predicate.hasProperty(failure, "_tag") || !Predicate.isString(failure._tag)) return undefined;
  return failure as { _tag: string; [key: string]: unknown };
}

export function runScript(script: string, argv: string[]) {
  const path = join(import.meta.dirname, "../bench", script);
  return Effect.tryPromise(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [path, ...argv], { encoding: "utf8", timeout: 15_000, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error.code, stdout, stderr });
        return;
      }
      resolve({ code: 0, stdout, stderr });
    });
  }));
}
