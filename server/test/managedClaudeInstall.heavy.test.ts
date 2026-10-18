import { readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { vi } from "vitest";
import { ManagedDeps } from "../src/managedDeps.ts";
import { fakeInstaller, install, leftovers, oldCurrent, ready } from "./fixtures/managedClaudeInstall.ts";
import { managedLayer, temporaryDeps } from "./fixtures/managedDeps.ts";

// 子プロセスの終了（kill(pid, 0) で生存を見る）で結果が決まる契約
describe("管理 Claude SDK の導入の中断", () => {
  it.live("導入中断は子プロセスを終了し、旧 current を保持して再導入できる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeInstaller(dir);
    yield* Effect.tryPromise(async () => { await oldCurrent(root); await writeFile(join(dir, "hold-sdk"), "hold"); });
    yield* Effect.gen(function* () {
      expect(yield* (yield* ManagedDeps).check(["claude"])).toMatchObject([{ name: "claude", state: "outdated" }]);
      const fiber = yield* install(["claude"]).pipe(Effect.forkChild);
      try {
        yield* Effect.tryPromise(() => vi.waitFor(async () => expect(Number(await readFile(join(dir, "sdk-started"), "utf8"))).toBeGreaterThan(0)));
        const pid = Number(yield* Effect.tryPromise(() => readFile(join(dir, "sdk-started"), "utf8")));
        yield* Fiber.interrupt(fiber);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(yield* Effect.tryPromise(() => readlink(join(root, "claude/current")))).toBe("old");
        expect(yield* Effect.tryPromise(() => leftovers(root))).toEqual([]);
      } finally {
        yield* Fiber.interrupt(fiber);
        yield* Effect.tryPromise(() => rm(join(dir, "hold-sdk"), { force: true }));
      }
      yield* install(["claude"]);
      expect(yield* (yield* ManagedDeps).check(["claude"])).toMatchObject([ready]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));
});
