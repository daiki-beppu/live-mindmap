import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ManagedDeps } from "../src/managedDeps.ts";
import { NodeFileSystem } from "@effect/platform-node";
import { MapCapture } from "../src/capture.ts";
import { Playwright } from "../src/playwright.ts";
import { ReviewBuild } from "../src/review.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { realLayers } from "../src/server.ts";
import { temporaryDeps, installed, managedLayer } from "./fixtures/managedDeps.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { FAKE_TEMPLATE } from "./fixtures/exportServices.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";

describe("管理 Chromium の実導入", () => {
  it.live("開発用スクリプトは常駐サーバーなしで導入でき、再実行は ready の実体を保つ", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const pkg = JSON.parse(yield* Effect.tryPromise(() => readFile(join(import.meta.dirname, "../package.json"), "utf8"))) as { scripts: Record<string, string> };
    const script = Object.keys(pkg.scripts).find((name) => pkg.scripts[name]!.includes("scripts/install-managed-deps.ts"));
    expect(script, "開発用の直接導入スクリプト").toBeDefined();
    const run = () => Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
      execFile("pnpm", ["--filter", "@live-mindmap/server", script!, "chromium"], {
        cwd: join(import.meta.dirname, "../.."), timeout: 150_000,
        env: { ...process.env, LIVE_MINDMAP_DEPS: root, LIVE_MINDMAP_PORT: "0", LIVE_MINDMAP_CONFIG: join(root, "absent.json"), NO_COLOR: "1" },
      }, (error) => error ? reject(error) : resolve());
    }));
    yield* run();
    const first = yield* Effect.tryPromise(() => realpath(join(root, "chromium/current")));
    const items = yield* Effect.gen(function* () { return yield* (yield* ManagedDeps).check(["chromium"]); }).pipe(Effect.provide(managedLayer(root)));
    expect(items).toEqual([installed]);
    yield* run();
    expect(yield* Effect.tryPromise(() => realpath(join(root, "chromium/current")))).toBe(first);
  }).pipe(Effect.scoped), 180_000);

  it.live("本物の npm ci と Playwright で一時ルートに固定版と headless shell を入れ、同じサーバーの stop で PNG を撮る", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const options = { port: 0, sessionsDir: join(root, "sessions"), depsDir: root,
      helper: { command: process.execPath, args: [join(import.meta.dirname, "fixtures/fake-helper.ts"), join(root, "helper.json"), join(root, "helper.log")] }, prepareUpdater: () => Effect.succeed(updaterLayer(() => Effect.succeed({ ops: [] }))) };
    yield* Effect.tryPromise(() => writeFile(join(root, "helper.json"), JSON.stringify({ apps: [], events: [] })));
    const exportServices = Layer.mergeAll(
      MapCapture.layer.pipe(Layer.provide(Playwright.layer)),
      Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(FAKE_TEMPLATE) })),
      fakeAudioMix().layer,
    ).pipe(Layer.provideMerge(NodeFileSystem.layer));
    const server = yield* startedServer(options, realLayers(options, exportServices));
    const result = yield* Effect.tryPromise(() => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile("pnpm", ["cli", "install", "chromium"], {
        cwd: join(import.meta.dirname, "../.."), timeout: 150_000,
        env: { ...process.env, LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_DEPS: root,
          LIVE_MINDMAP_SESSIONS: options.sessionsDir, LIVE_MINDMAP_CONFIG: join(root, "absent.config.json"), LIVE_MINDMAP_MODEL: "", NO_COLOR: "1" },
      }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    }));
    expect(JSON.parse(result.stdout)).toEqual([installed]);
    expect(result.stderr).toContain("確認:");
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/deps/check?names=chromium`));
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toEqual([installed]);
    const current = yield* Effect.tryPromise(() => realpath(join(root, "chromium/current")));
    const manifest = JSON.parse(yield* Effect.tryPromise(() => readFile(join(import.meta.dirname, "../managed-deps/chromium/package.json"), "utf8")));
    const pkg = JSON.parse(yield* Effect.tryPromise(() => readFile(join(current, "node_modules/playwright-core/package.json"), "utf8")));
    expect(manifest.dependencies["playwright-core"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).toBe(manifest.dependencies["playwright-core"]);
    const browsers = JSON.parse(yield* Effect.tryPromise(() => readFile(join(current, "node_modules/playwright-core/browsers.json"), "utf8")));
    const shell = browsers.browsers.find((browser: { name: string }) => browser.name === "chromium-headless-shell");
    expect(shell).toBeDefined();
    const revision = shell.revisionOverrides?.[process.platform === "darwin" ? `mac${process.arch === "arm64" ? "-arm64" : ""}` : ""] ?? shell.revision;
    expect(yield* Effect.tryPromise(() => stat(join(root, `chromium/browsers/chromium_headless_shell-${revision}/INSTALLATION_COMPLETE`)))).toBeDefined();
    const started = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/session/start`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "test.app", audio: false, screen: false }),
    }));
    expect(started.status).toBe(200);
    const { dir } = yield* Effect.tryPromise(() => started.json() as Promise<{ dir: string }>);
    const stopped = yield* Effect.tryPromise(() => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile("pnpm", ["cli", "stop"], { cwd: join(import.meta.dirname, "../.."), timeout: 90_000,
        env: { ...process.env, LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_DEPS: root, LIVE_MINDMAP_SESSIONS: options.sessionsDir, LIVE_MINDMAP_CONFIG: join(root, "absent.config.json"), NO_COLOR: "1" },
      }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    }));
    const png = yield* Effect.tryPromise(() => readFile(join(dir, "map.png")));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(stopped.stdout).toContain(join(dir, "map.png"));
  }).pipe(Effect.scoped), 180_000);
});
