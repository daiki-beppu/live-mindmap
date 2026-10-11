import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { ManagedDeps } from "../src/managedDeps.ts";
import { checkManagedDeps, ClaudeRequired } from "../src/managedDepsCheck.ts";

describe("管理依存の必須項目の充足", () => {
  it.effect.each([
    { state: "ready", ready: true },
    { state: "missing", ready: false },
  ] as const)("任意の不足と必須の $state が共存すると ready は $ready", ({ state, ready }) =>
    Effect.gen(function* () {
      const report = yield* checkManagedDeps.pipe(Effect.provideService(ManagedDeps, ManagedDeps.of({
        check: () => Effect.succeed([
          { name: "chromium", need: "optional", state: "missing" },
          { name: "chromium", need: "required", state },
        ]),
        install: () => Stream.die("確認は導入しない"),
        load: () => Effect.die("確認は読み込まない"),
      })));
      expect(report.ready).toBe(ready);
    }));

  it.effect.each([
    { required: true, state: "missing", ready: false },
    { required: true, state: "ready", ready: true },
    { required: false, state: "missing", ready: true },
  ] as const)("Claude $state は必須判定 $required を表示と ready に反映する", ({ required, state, ready }) => Effect.gen(function* () {
    const report = yield* checkManagedDeps.pipe(
      Effect.provideService(ClaudeRequired, required),
      Effect.provideService(ManagedDeps, ManagedDeps.of({
        check: () => Effect.succeed([{ name: "claude", need: "optional", state }]),
        install: () => Stream.die("確認は導入しない"), load: () => Effect.die("確認は読み込まない"),
      })),
    );
    expect(report).toEqual({ ready, items: [{ name: "claude", need: required ? "required" : "optional", state, size: 224_000_000, install: "pnpm cli install claude" }] });
  }));
});
