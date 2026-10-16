// bench が PATH 上の ffmpeg に音声フィルタをかけ、その出力と終了コードを受け取る共通処理（入口ではない）。
// ffmpeg は結果を stderr に出すので、stdout と stderr をまとめて返す。
// 終了コードの扱いと、起動できない（ffmpeg が無い）ときの扱いは、呼び出し側が決める
import { Effect, Stream, type PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const readText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Stream.mkString(Stream.decodeText(stream));

export const runFfmpegFilter = Effect.fnUntraced(function* (file: string, filter: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("ffmpeg", ["-nostats", "-i", file, "-af", filter, "-f", "null", "-"], { stdin: "ignore" }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all([readText(handle.stdout), readText(handle.stderr), handle.exitCode], { concurrency: "unbounded" });
      return { output: stdout + stderr, exitCode };
    }),
  );
});
