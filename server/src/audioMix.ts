import { Context, Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { runHelperCommand, stderrReason } from "./helpers.ts";
import type { HelperCommand } from "./helpers.ts";

export class AudioMixFailed extends Schema.TaggedError<AudioMixFailed>()("AudioMixFailed", { message: Schema.String }) {}

export class AudioMix extends Context.Service<AudioMix, {
  readonly mix: (session: string, out: string, track?: "自分") => Effect.Effect<void, AudioMixFailed>;
}>()("live-mindmap/server/AudioMix") {
  static readonly layer = (helper: HelperCommand): Layer.Layer<AudioMix, never, ChildProcessSpawner.ChildProcessSpawner> =>
    Layer.effect(AudioMix)(make(helper));

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
