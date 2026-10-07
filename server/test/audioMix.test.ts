import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { AudioMix, AudioMixFailed } from "../src/audioMix.ts";
import type { HelperCommand } from "../src/helpers.ts";

// 本物の AudioMix の Layer が、effect/process の本物の spawner で `mix --session <dir> --out <path>` を 1 回起動して終わりを待つこと。
// ヘルパーは偽物（fixtures/fake-helper.ts の mix）。ヘルパーの音声処理そのものはここでは確かめない
const fakeHelper = join(import.meta.dirname, "fixtures/fake-helper.ts");

const workspace = Effect.fnUntraced(function* (script: object = {}) {
  const dir = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-audiomix-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const scriptPath = join(dir, "script.json");
  const recordPath = join(dir, "record.jsonl");
  writeFileSync(scriptPath, JSON.stringify({ apps: [], events: [], ...script }));
  writeFileSync(recordPath, "");
  const helper: HelperCommand = { command: process.execPath, args: [fakeHelper, scriptPath, recordPath] };
  const records = () => readFileSync(recordPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; argv: string[] });
  return { dir, helper, records, out: join(dir, "out.m4a") };
});

const mixWith = (helper: HelperCommand, session: string, out: string) =>
  Effect.gen(function* () {
    const audioMix = yield* AudioMix;
    return yield* audioMix.mix(session, out);
  }).pipe(Effect.provide(AudioMix.layer(helper).pipe(Layer.provide(NodeServices.layer))));

describe("AudioMix の実物の Layer", () => {
  it.live("ヘルパーを `mix --session <dir> --out <path>` で 1 回起動し、終了コード 0 なら成功する。出力はヘルパーが --out に書く", () =>
    Effect.gen(function* () {
      const { helper, records, out } = yield* workspace();

      yield* mixWith(helper, "/some/session", out);

      expect(records()).toEqual([{ type: "mix", argv: ["mix", "--session", "/some/session", "--out", out] }]);
      expect((yield* Effect.tryPromise(() => readFile(out, "utf8")))).toBe("fake-mix-output");
    }).pipe(Effect.scoped));

  it.live("ヘルパーが 0 以外で終わったら AudioMixFailed（defect ではない）で失敗し、message に標準エラーの末尾が入る", () =>
    Effect.gen(function* () {
      const stderr = ["1", "2", "3", "4", "5", "6", "録音が見つかりません"].join("\n") + "\n";
      const { helper, out } = yield* workspace({ failMix: { stderr, code: 3 } });

      const result = yield* Effect.result(mixWith(helper, "/some/session", out));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toBeInstanceOf(AudioMixFailed);
      expect(result.failure._tag).toBe("AudioMixFailed");
      expect(result.failure.message).toContain("録音が見つかりません");
      expect(result.failure.message).not.toContain("1\n2"); // 末尾だけ（先頭の行は含めない）
    }).pipe(Effect.scoped));

  it.live("ヘルパーを起動できなくても、AudioMixFailed で失敗する（defect ではない）", () =>
    Effect.gen(function* () {
      const { dir, out } = yield* workspace();

      const result = yield* Effect.result(mixWith({ command: join(dir, "存在しない実行ファイル"), args: [] }, "/some/session", out));

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure).toBeInstanceOf(AudioMixFailed);
      expect(result.failure.message).not.toBe("");
    }).pipe(Effect.scoped));
});

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
