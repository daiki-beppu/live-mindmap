import { createHash } from "node:crypto";
import { readFile, readlink, realpath, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { ManagedDeps } from "../src/managedDeps.ts";
import { fakeInstaller, install, leftovers, oldCurrent, ready } from "./fixtures/managedClaudeInstall.ts";
import { managedLayer, temporaryDeps } from "./fixtures/managedDeps.ts";

describe("管理 Claude SDK の導入と公開", () => {
  it.live("未導入から固定版を導入し、ready の管理 SDK を読める", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeInstaller(dir);
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      expect(yield* deps.check(["claude"])).toMatchObject([{ name: "claude", state: "missing" }]);
      const events = yield* install(["claude"]);
      expect(events.filter((event) => event.type === "result")).toMatchObject([{ type: "result", items: [ready] }]);
      expect(yield* deps.check(["claude"])).toMatchObject([ready]);
      const record = JSON.parse(yield* Effect.tryPromise(() => readFile(join(root, "claude/current/.ready.json"), "utf8"))) as { hashes: Record<string, string> };
      const entity = basename(yield* Effect.tryPromise(() => realpath(join(root, "claude/current"))));
      const binary = join(root, "claude", entity, "node_modules", `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === "win32" ? "claude.exe" : "claude");
      expect(record.hashes).toEqual({ [binary]: createHash("sha256").update("synthetic CLI binary").digest("hex") });
      expect(yield* Effect.tryPromise(() => readFile(binary, "utf8"))).toBe("synthetic CLI binary");
      const module = yield* deps.load("claude");
      expect((module as unknown as { query: unknown }).query).toBeTypeOf("function");
      expect(yield* Effect.tryPromise(() => leftovers(root))).toEqual([]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("Chromium と Claude の同時要求は最終 result を一度だけ返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const npm = yield* fakeInstaller(dir);
    const events = yield* install(["chromium", "claude"]).pipe(Effect.provide(managedLayer(join(dir, "deps"), npm)));
    const results = events.filter((event) => event.type === "result");
    expect(results).toHaveLength(1);
    expect(events.at(-1)).toEqual(results[0]);
    expect(results[0]).toMatchObject({ items: [{ name: "chromium", state: "ready" }, ready] });
  }).pipe(Effect.scoped));

  it.live("npm 失敗後は旧 current を保持して後片付けし、同じルートで再導入できる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeInstaller(dir);
    yield* Effect.tryPromise(async () => { await oldCurrent(root); await writeFile(join(dir, "fail-sdk"), "fail"); });
    yield* Effect.gen(function* () {
      const result = yield* Effect.result(install(["claude"]));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain("synthetic npm failure");
      expect(yield* Effect.tryPromise(() => readFile(join(dir, "sdk-calls"), "utf8"))).not.toBe("");
      expect(yield* Effect.tryPromise(() => readlink(join(root, "claude/current")))).toBe("old");
      expect(yield* Effect.tryPromise(() => leftovers(root))).toEqual([]);
      yield* Effect.tryPromise(() => rm(join(dir, "fail-sdk")));
      yield* install(["claude"]);
      expect(yield* (yield* ManagedDeps).check(["claude"])).toMatchObject([ready]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));
});
