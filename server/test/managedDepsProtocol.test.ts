import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { InstallBody, InstallEvent } from "../src/managedDepsProtocol.ts";
import { ManagedDepsFailed } from "../src/managedDeps.ts";

describe("管理依存の転送契約", () => {
  it.effect("Chromium の要求と導入結果を受理する", () => Effect.gen(function* () {
    expect(yield* Schema.decodeUnknownEffect(InstallBody)({ names: ["chromium"] })).toEqual({ names: ["chromium"] });
    const event = { type: "result", items: [{ name: "chromium", need: "optional", state: "ready" }] };
    expect(yield* Schema.decodeUnknownEffect(InstallEvent)(event)).toEqual(event);
    expect(new ManagedDepsFailed({ message: "導入中です" }).message).toBe("導入中です");
  }));
  it.effect.each([{ names: [] }, { names: ["unknown"] }, null])("契約外の要求 %s を拒否する", (body) => Effect.gen(function* () {
    expect(Result.isFailure(yield* Effect.result(Schema.decodeUnknownEffect(InstallBody)(body)))).toBe(true);
  }));
  it.effect.each([{ type: "unexpected" }, { type: "result", items: [{ name: "chromium", need: "optional", state: "installing" }] }])(
    "不正な転送イベント %s を拒否する", (event) => Effect.gen(function* () {
      expect(Result.isFailure(yield* Effect.result(Schema.decodeUnknownEffect(InstallEvent)(event)))).toBe(true);
    }),
  );
});
