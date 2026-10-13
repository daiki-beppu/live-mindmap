// ヘルパーの `mix`（セッションのフォルダの録音を 1 本の m4a にする）を呼ぶ Service。
// Helpers（apps・launch）とは別にする。中身は helpers.ts の apps と同じく、ChildProcessSpawner で 1 回ごとにヘルパーを起動して終わりを待つ。
// テストは Layer.succeed の偽物に差し替える（見返し用の HTML の書き出し review.ts が使う）
import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { runHelperCommand, stderrReason } from "./helpers.ts";
import type { HelperCommand } from "./helpers.ts";

// mix が成り立たなかった（起動できない・0 以外で終わる）。message は理由（ヘルパーの標準エラーの末尾）
export class AudioMixFailed extends Schema.TaggedError<AudioMixFailed>()("AudioMixFailed", { message: Schema.String }) {}

export class AudioMix extends Context.Service<AudioMix, {
  // session のフォルダの録音を混ぜて、out（まだ無いファイル。親のフォルダは有る）に書く
  // track を渡すと、その 1 本（`自分`）だけを混ぜる。省略すると全トラックを混ぜる
  readonly mix: (session: string, out: string, track?: "自分") => Effect.Effect<void, AudioMixFailed>;
}>()("live-mindmap/server/AudioMix") {
  static readonly layer = (helper: HelperCommand): Layer.Layer<AudioMix, never, ChildProcessSpawner.ChildProcessSpawner> =>
    Layer.effect(AudioMix)(make(helper));

  // ヘルパーが見つからないときの Layer。mix を呼ぶと、その理由で失敗する
  static readonly unavailable = (reason: string): Layer.Layer<AudioMix> =>
    Layer.succeed(AudioMix, AudioMix.of({ mix: () => Effect.fail(new AudioMixFailed({ message: reason })) }));
}

const make = Effect.fnUntraced(function* (helper: HelperCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const mix = (session: string, out: string, track?: "自分"): Effect.Effect<void, AudioMixFailed> =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stderr, code } = yield* runHelperCommand(
          spawner, helper, ["mix", "--session", session, "--out", out, ...(track === undefined ? [] : ["--track", track])], { stdout: "ignore" },
        );
        if (code === 0) return;
        return yield* new AudioMixFailed({ message: stderrReason(stderr, code) });
      }),
    ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new AudioMixFailed({ message: error.message }))));

  return AudioMix.of({ mix });
});
