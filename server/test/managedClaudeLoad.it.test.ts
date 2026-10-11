import { existsSync } from "node:fs";
import { mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import { managedLayer, temporaryDeps } from "./fixtures/managedDeps.ts";

const sdkVersion = "0.3.288";
const entity = async (root: string, version: string, outside: boolean) => {
  const dir = join(root, "claude", "entity");
  const pkg = join(dir, "node_modules/@anthropic-ai/claude-agent-sdk");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version, type: "module", exports: { ".": "./sdk.mjs" } }));
  const module = outside ? join(root, "outside.mjs") : join(pkg, "sdk.mjs");
  await writeFile(module, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, "imported"))}, 'imported');
export const location = import.meta.url;
export const query = () => { throw new Error('読込確認は query を呼ばない'); };
`);
  if (outside) await symlink(module, join(pkg, "sdk.mjs"));
  await symlink("entity", join(root, "claude/current"));
  return module;
};

describe("管理 Claude SDK の読み込み", () => {
  it.live("固定版を管理実体から読み込み、query を利用可能にする", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const path = yield* Effect.tryPromise(() => entity(root, sdkVersion, false));
    const module = (yield* Effect.gen(function* () {
      return yield* (yield* ManagedDeps).load("claude");
    }).pipe(Effect.provide(managedLayer(root)))) as unknown as { query: unknown; location: string };
    expect(module.query).toBeTypeOf("function");
    expect(yield* Effect.tryPromise(() => realpath(new URL(module.location)))).toBe(yield* Effect.tryPromise(() => realpath(path)));
    expect(existsSync(join(root, "imported"))).toBe(true);
  }).pipe(Effect.scoped));

  it.live.each(["missing", "wrong-version", "outside-symlink", "outside-current"] as const)(
    "%s は管理モジュールを評価せず、通常依存へ戻らずに失敗する", (condition) => Effect.gen(function* () {
      const root = yield* temporaryDeps;
      if (condition !== "missing") yield* Effect.tryPromise(() => entity(root, condition === "wrong-version" ? "0.0.0" : sdkVersion, condition === "outside-symlink"));
      if (condition === "outside-current") yield* Effect.tryPromise(async () => {
        await rename(join(root, "claude/entity"), join(root, "outside-entity"));
        await rm(join(root, "claude/current"));
        await symlink("../outside-entity", join(root, "claude/current"));
      });
      const result = yield* Effect.gen(function* () {
        return yield* (yield* ManagedDeps).load("claude");
      }).pipe(Effect.provide(managedLayer(root)), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ManagedDepsFailed);
      expect(existsSync(join(root, "imported"))).toBe(false);
    }).pipe(Effect.scoped),
  );
});
