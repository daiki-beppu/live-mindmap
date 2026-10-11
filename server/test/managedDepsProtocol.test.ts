import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { CheckReport, InstallBody, InstallEvent } from "../src/managedDepsProtocol.ts";
import { ManagedDepsFailed } from "../src/managedDeps.ts";

describe("管理依存の転送契約", () => {
  it.effect("Claude を含む導入要求・導入結果・状態確認を転送できる", () => Effect.gen(function* () {
    const body = { names: ["chromium", "claude"] };
    expect(yield* Schema.decodeUnknownEffect(InstallBody)(body)).toEqual(body);
    const items = [{ name: "claude", need: "required", state: "ready", size: 224_000_000, install: "pnpm cli install claude" }];
    const event = { type: "result", items };
    expect(yield* Schema.decodeUnknownEffect(InstallEvent)(event)).toEqual(event);
    const report = { ready: true, items };
    expect(yield* Schema.decodeUnknownEffect(CheckReport)(report)).toEqual(report);
  }));
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
