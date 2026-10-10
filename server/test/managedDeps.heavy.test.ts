import { readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { realLayers } from "../src/server.ts";
import { temporaryDeps, installed } from "./fixtures/managedDeps.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";

describe("管理 Chromium の実導入", () => {
  it.live("本物の npm ci と Playwright で一時ルートに固定版と headless shell を入れて ready にする", () => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    const options = { port: 0, sessionsDir: join(root, "sessions"), depsDir: root,
      helper: { command: process.execPath, args: [] }, updaterLayer: () => updaterLayer(() => Effect.succeed({ ops: [] })) };
    const server = yield* startedServer(options, realLayers(options, fakeExportServices()));
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
  }).pipe(Effect.scoped), 180_000);
});
