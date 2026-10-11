import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { CheckReport, InstallBody, InstallEvent, StartupRefusal, UpdateBody } from "../src/managedDepsProtocol.ts";
import { ManagedDepsFailed } from "../src/managedDeps.ts";

describe("管理依存の転送契約", () => {
  it.effect("711-1・711-4: 更新要求は管理依存だけを受け取り、確認結果は導入版を保持する", () => Effect.gen(function* () {
    const body = { names: ["chromium", "claude"] };
    expect(yield* Schema.decodeUnknownEffect(UpdateBody)(body)).toEqual(body);
    for (const names of [[], ["speech-ja"], ["unknown"]]) {
      expect(Result.isFailure(yield* Effect.result(Schema.decodeUnknownEffect(UpdateBody)({ names })))).toBe(true);
    }
    const report = { ready: false, items: [{ name: "claude", need: "required", state: "outdated", version: "0.0.0" }] };
    expect(yield* Schema.decodeUnknownEffect(CheckReport)(report)).toEqual(report);
  }));
  it.effect("C3・C6: ビルドと許可は確認結果で転送できるが導入対象にはならない", () => Effect.gen(function* () {
    const report = { ready: true, items: [
      { name: "helper", need: "required", state: "ready", install: "swift build -c release --package-path helper" },
      { name: "microphone", need: "optional", state: "absent" },
      { name: "screen-capture", need: "optional", state: "ready" },
    ] };
    expect(yield* Schema.decodeUnknownEffect(CheckReport)(report)).toEqual(report);
    for (const name of ["helper", "microphone", "screen-capture"]) {
      expect(Result.isFailure(yield* Effect.result(Schema.decodeUnknownEffect(InstallBody)({ names: [name] })))).toBe(true);
    }
  }));
  it.effect("710-1・710-4: speech-ja の導入要求・結果・確認・開始拒否を転送できる", () => Effect.gen(function* () {
    const body = { names: ["speech-ja", "claude"] };
    expect(yield* Schema.decodeUnknownEffect(InstallBody)(body)).toEqual(body);
    const items = [{ name: "speech-ja", need: "required", state: "ready", install: "pnpm cli install speech-ja" }];
    expect(yield* Schema.decodeUnknownEffect(InstallEvent)({ type: "result", items })).toEqual({ type: "result", items });
    expect(yield* Schema.decodeUnknownEffect(CheckReport)({ ready: true, items })).toEqual({ ready: true, items });
    const refusal = { _tag: "StartupDepsMissing", items: [{ ...items[0], state: "missing" }] };
    expect(yield* Schema.decodeUnknownEffect(StartupRefusal)(refusal)).toEqual(refusal);
  }));
  it.effect("開始拒否の不足項目を転送し、空の不足項目は拒否する", () => Effect.gen(function* () {
    const refusal = { _tag: "StartupDepsMissing", items: [{ name: "claude", need: "required", state: "missing" }] };
    expect(yield* Schema.decodeUnknownEffect(StartupRefusal)(refusal)).toEqual(refusal);
    expect(Result.isFailure(yield* Effect.result(Schema.decodeUnknownEffect(StartupRefusal)({ ...refusal, items: [] })))).toBe(true);
  }));
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
