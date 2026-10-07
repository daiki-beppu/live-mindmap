// ヘルパーの `mix`（セッションのフォルダの録音を 1 本の m4a にする）を呼ぶ Service。
// Helpers（apps・launch）とは別にする。中身は helpers.ts の apps と同じく、ChildProcessSpawner で 1 回ごとにヘルパーを起動して終わりを待つ。
// テストは Layer.succeed の偽物に差し替える（見返し用の HTML の書き出し review.ts が使う）
import { Context, Effect, Layer, Schema, Stream } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { STDERR_TAIL_LINES, tailLines } from "./core/index.ts";
import type { HelperCommand } from "./helpers.ts";

// mix が成り立たなかった（起動できない・0 以外で終わる）。message は理由（ヘルパーの標準エラーの末尾）
export class AudioMixFailed extends Schema.TaggedError<AudioMixFailed>()("AudioMixFailed", { message: Schema.String }) {}

export class AudioMix extends Context.Service<AudioMix, {
  // session のフォルダの録音を混ぜて、out（まだ無いファイル。親のフォルダは有る）に書く
  readonly mix: (session: string, out: string) => Effect.Effect<void, AudioMixFailed>;
}>()("live-mindmap/server/AudioMix") {
  static readonly layer = (helper: HelperCommand): Layer.Layer<AudioMix, never, ChildProcessSpawner.ChildProcessSpawner> =>
    Layer.effect(AudioMix)(make(helper));

  // ヘルパーが見つからないときの Layer。mix を呼ぶと、その理由で失敗する
  static readonly unavailable = (reason: string): Layer.Layer<AudioMix> =>
    Layer.succeed(AudioMix, AudioMix.of({ mix: () => Effect.fail(new AudioMixFailed({ message: reason })) }));
}

const make = Effect.fnUntraced(function* (helper: HelperCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Stream.mkString(Stream.decodeText(stream));

  const mix = (session: string, out: string): Effect.Effect<void, AudioMixFailed> =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(helper.command, [...helper.args, "mix", "--session", session, "--out", out], { stdin: "ignore", stdout: "ignore" }),
        );
        const [stderr, code] = yield* Effect.all([readText(handle.stderr), handle.exitCode], { concurrency: "unbounded" });
        if (code === 0) return;
        const reason = tailLines(stderr, STDERR_TAIL_LINES).join("\n").trim();
        return yield* new AudioMixFailed({ message: reason || `終了コード ${code}` });
      }),
    ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new AudioMixFailed({ message: error.message }))));

  return AudioMix.of({ mix });
});
