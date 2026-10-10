import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { DiffUpdatePaused, DiffUpdateState } from "../src/core/index.ts";

describe("差分更新の状態", () => {
  it.effect.each([
    { status: "running" }, { status: "restarting" },
    { status: "paused", reason: "ChatGPT の利用上限" }, { status: "stopped" },
  ] as const)("$status は保存・配信できる", (state) => Effect.gen(function* () {
    expect(yield* Schema.decodeUnknownEffect(DiffUpdateState)(JSON.parse(JSON.stringify(state)))).toEqual(state);
  }));

  it.effect("一時停止には理由が必要で、失敗タグから理由を取得できる", () => Effect.gen(function* () {
    const invalid = yield* Effect.result(Schema.decodeUnknownEffect(DiffUpdateState)({ status: "paused" }));
    expect(Result.isFailure(invalid)).toBe(true);
    const error = new DiffUpdatePaused({ reason: "ChatGPT の利用上限", message: "合成の失敗" });
    expect(yield* Schema.decodeUnknownEffect(DiffUpdatePaused)(JSON.parse(JSON.stringify(error)))).toMatchObject({ _tag: "DiffUpdatePaused", reason: "ChatGPT の利用上限" });
  }));
});
