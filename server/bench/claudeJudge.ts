import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// 辺・兄弟のどちらもプロンプトと応答の文字列だけを受け渡す。ラベルの検証は各判定処理が所有する。
export type Judge<E, R> = (prompt: string) => Effect.Effect<string, E, R>;

class ClaudeJudgeFailed extends Schema.TaggedError<ClaudeJudgeFailed>()("ClaudeJudgeFailed", {
  message: Schema.String,
}) {}

export const claudeJudge = Effect.fnUntraced(function* (prompt: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("claude", ["-p", "--model", "claude-sonnet-5-5", prompt], {
        env, extendEnv: false, stdin: "ignore",
      }));
      const [stdout, , code] = yield* Effect.all([
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.runDrain(handle.stderr),
        handle.exitCode,
      ], { concurrency: "unbounded" });
      if (code !== 0) return yield* new ClaudeJudgeFailed({ message: `Claudeが終了コード ${code} で終了しました` });
      return stdout;
    }),
  ).pipe(Effect.catchTag("PlatformError", () => Effect.fail(new ClaudeJudgeFailed({ message: "Claudeの起動または出力の読込に失敗しました" }))));
});
