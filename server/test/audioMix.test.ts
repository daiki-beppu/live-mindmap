import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { AudioMix, AudioMixFailed } from "../src/audioMix.ts";

// AudioMix.unavailable が、ヘルパーを起動せずに渡した理由の AudioMixFailed で失敗すること
describe("AudioMix.unavailable", () => {
  it.effect("mix を呼ぶと、渡した理由の AudioMixFailed で失敗する（ヘルパーを起動しない）", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Effect.gen(function* () {
          return yield* (yield* AudioMix).mix("/s", "/o");
        }).pipe(Effect.provide(AudioMix.unavailable("ヘルパーの実行ファイルがありません"))),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toBeInstanceOf(AudioMixFailed);
      expect(result.failure.message).toBe("ヘルパーの実行ファイルがありません");
    }));
});
