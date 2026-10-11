import { existsSync } from "node:fs";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { afterEach, vi } from "vitest";
import manifest from "../managed-deps/chromium/package.json" with { type: "json" };
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import { Playwright } from "../src/playwright.ts";
import { managedLayer, temporaryDeps } from "./fixtures/managedDeps.ts";

afterEach(() => vi.unstubAllEnvs());

const entity = async (root: string, name: string, version: string) => {
  const dir = join(root, "chromium", name);
  const pkg = join(dir, "node_modules/playwright-core");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", version, type: "module", main: "index.js" }));
  await writeFile(join(pkg, "index.js"), `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, "imported"))}, 'imported');
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
export const chromium = {
  launch: async () => ({ version: () => JSON.stringify({ entity: ${JSON.stringify(name)}, browsers }), close: async () => {} }),
};
`);
  return dir;
};

const publish = async (root: string, name: string) => {
  const candidate = join(root, "chromium/next");
  await symlink(name, candidate);
  await rename(candidate, join(root, "chromium/current"));
};

describe("管理 Chromium の読み込み", () => {
  it.live("固定版の管理モジュールを読み、import 前に管理ブラウザの場所を渡す", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "unmanaged-browser-path");
    yield* Effect.tryPromise(async () => {
      await entity(root, "a", manifest.dependencies["playwright-core"]);
      await publish(root, "a");
    });
    yield* Effect.gen(function* () {
      const module = yield* (yield* ManagedDeps).load("chromium");
      const browser = yield* Effect.tryPromise(() => module.chromium.launch());
      expect(JSON.parse(browser.version())).toEqual({ entity: "a", browsers: join(root, "chromium/browsers") });
      yield* Effect.promise(() => browser.close());
    }).pipe(Effect.provide(managedLayer(root)));
  }).pipe(Effect.scoped));

  it.live("同じ ManagedDeps と Playwright を保持したまま current の変更後の起動が新しい実体を使う", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "unmanaged-browser-path");
    yield* Effect.tryPromise(async () => {
      await entity(root, "a", manifest.dependencies["playwright-core"]);
      await entity(root, "b", manifest.dependencies["playwright-core"]);
      await publish(root, "a");
    });
    yield* Effect.gen(function* () {
      yield* (yield* ManagedDeps).load("chromium");
      const playwright = yield* Playwright;
      const first = yield* Effect.acquireRelease(playwright.launch(), (browser) => Effect.promise(() => browser.close()));
      expect(JSON.parse(first.version()).entity).toBe("a");
      yield* Effect.tryPromise(() => publish(root, "b"));
      const second = yield* Effect.acquireRelease(playwright.launch(), (browser) => Effect.promise(() => browser.close()));
      expect(JSON.parse(second.version())).toEqual({ entity: "b", browsers: join(root, "chromium/browsers") });
      expect(JSON.parse(first.version()).entity).toBe("a");
    }).pipe(Effect.provide(Playwright.layer.pipe(Layer.provideMerge(managedLayer(root)))));
  }).pipe(Effect.scoped));

  it.live.each(["missing", "wrong-version", "outside-node-modules", "outside-symlink", "broken-module"] as const)(
    "%s は通常依存へ戻らず ManagedDepsFailed を返す",
    (condition) => Effect.gen(function* () {
      const root = yield* temporaryDeps;
      vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "unmanaged-browser-path");
      yield* Effect.tryPromise(async () => {
        if (condition === "missing") return;
        const dir = await entity(root, "a", condition === "wrong-version" ? "0.0.0" : manifest.dependencies["playwright-core"]);
        if (condition === "outside-node-modules" || condition === "outside-symlink") {
          const outside = join(dir, "node_modules-other");
          await mkdir(outside);
          await writeFile(join(outside, "index.js"), `require('node:fs').writeFileSync(${JSON.stringify(join(root, "outside-imported"))}, 'imported'); module.exports = { chromium: {} };`);
          if (condition === "outside-symlink") await symlink(join(outside, "index.js"), join(dir, "node_modules/playwright-core/linked.js"));
          await writeFile(join(dir, "node_modules/playwright-core/package.json"), JSON.stringify({ name: "playwright-core", version: manifest.dependencies["playwright-core"], main: condition === "outside-symlink" ? "linked.js" : "../../node_modules-other/index.js" }));
        }
        if (condition === "broken-module") await writeFile(join(dir, "node_modules/playwright-core/index.js"), "throw new Error('module evaluation failed');");
        await publish(root, "a");
      });
      const result = yield* Effect.gen(function* () {
        return yield* (yield* ManagedDeps).load("chromium");
      }).pipe(Effect.provide(managedLayer(root)), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ManagedDepsFailed);
      if (condition === "outside-node-modules" || condition === "outside-symlink") expect(existsSync(join(root, "outside-imported"))).toBe(false);
      if (condition === "wrong-version") expect(existsSync(join(root, "chromium/a/imported"))).toBe(false);
    }).pipe(Effect.scoped),
  );
});
