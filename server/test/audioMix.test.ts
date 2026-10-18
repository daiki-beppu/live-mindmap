import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { AudioMix, AudioMixFailed } from "../src/audioMix.ts";
import { fakeSpawner } from "./fixtures/fakeSpawner.ts";

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

// 本物の AudioMix の Layer が、偽の ChildProcessSpawner に渡す argv と、失敗の写像（子プロセスは起動しない）
describe("AudioMix.layer（偽の ChildProcessSpawner）", () => {
  const helper = { command: "server-helper", args: ["existing-arg"] };
  const mixWith = (spawner: ReturnType<typeof fakeSpawner>, track?: "自分") =>
    Effect.gen(function* () {
      return yield* (yield* AudioMix).mix("/some/session", "/out/mix.m4a", track);
    }).pipe(Effect.provide(AudioMix.layer(helper).pipe(Layer.provide(spawner.layer))));
  const base = ["existing-arg", "mix", "--session", "/some/session", "--out", "/out/mix.m4a"];

  it.effect("track に `自分` を渡すと、argv の末尾に `--track 自分` が付き、省くと付かない", () =>
    Effect.gen(function* () {
      const withTrack = fakeSpawner({ code: 0 });
      yield* mixWith(withTrack, "自分");
      expect(withTrack.commands.map(({ command, args }) => ({ command, args }))).toEqual([
        { command: "server-helper", args: [...base, "--track", "自分"] },
      ]);

      const withoutTrack = fakeSpawner({ code: 0 });
      yield* mixWith(withoutTrack);
      expect(withoutTrack.commands.map(({ args }) => args)).toEqual([base]);
    }));

  it.effect("ヘルパーが 0 以外で終わったら AudioMixFailed（defect ではない）で失敗し、message に標準エラーの末尾が入る", () =>
    Effect.gen(function* () {
      const stderr = ["1", "2", "3", "4", "5", "6", "録音が見つかりません"].join("\n") + "\n";
      const result = yield* Effect.result(mixWith(fakeSpawner({ code: 3, stderr })));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toBeInstanceOf(AudioMixFailed);
      expect(result.failure._tag).toBe("AudioMixFailed");
      expect(result.failure.message).toContain("録音が見つかりません");
      expect(result.failure.message).not.toContain("1\n2"); // 末尾だけ（先頭の行は含めない）
    }));

  it.effect("ヘルパーを起動できなくても、AudioMixFailed で失敗する（defect ではない）", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(mixWith(fakeSpawner({ spawnFailure: "NotFound" })));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toBeInstanceOf(AudioMixFailed);
      expect(result.failure.message).not.toBe("");
    }));
});
