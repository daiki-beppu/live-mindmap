import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { ManagedDeps } from "../src/managedDeps.ts";
import { checkManagedDeps } from "../src/managedDepsCheck.ts";

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
      })));
      expect(report.ready).toBe(ready);
    }));
});
