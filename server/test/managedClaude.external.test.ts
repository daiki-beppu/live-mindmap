import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ManagedDeps } from "../src/managedDeps.ts";
import { managedLayer, temporaryDeps } from "./fixtures/managedDeps.ts";

describe("管理 Claude SDK の実導入", () => {
  it.live("開発用入口で一時ルートへ導入し、管理実体の SDK を解決して読み込める（モデルは呼ばない）", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    yield* Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
      execFile("pnpm", ["--filter", "@live-mindmap/server", "deps:install", "claude"], {
        cwd: join(import.meta.dirname, "../.."), timeout: 150_000,
        env: { ...process.env, HOME: join(root, "home"), LIVE_MINDMAP_DEPS: root, LIVE_MINDMAP_CONFIG: join(root, "absent.json"), NO_COLOR: "1" },
      }, (error, stdout, stderr) => error ? reject(new Error(stdout + stderr, { cause: error })) : resolve());
    }));
    const entity = yield* Effect.tryPromise(() => realpath(join(root, "claude/current")));
    const resolved = yield* Effect.tryPromise(() => realpath(createRequire(join(entity, "package.json")).resolve("@anthropic-ai/claude-agent-sdk")));
    const path = relative(join(entity, "node_modules"), resolved);
    expect(isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)).toBe(false);
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const module = yield* deps.load("claude");
      expect((module as unknown as { query: unknown }).query).toBeTypeOf("function");
    }).pipe(Effect.provide(managedLayer(root)));
  }).pipe(Effect.scoped), 180_000);
});
