import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer } from "effect";
import { vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { Playwright } from "../src/playwright.ts";
import { ReviewBuild } from "../src/review.ts";
import { realLayers } from "../src/server.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { collectingConsole, FAKE_TEMPLATE } from "./fixtures/exportServices.ts";
import { temporaryDeps } from "./fixtures/managedDeps.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";

const unmanaged = vi.hoisted(() => ({ launch: vi.fn(async () => { throw new Error("通常依存の Chromium は使用できません"); }) }));
vi.mock("playwright", () => ({ chromium: { launch: unmanaged.launch } }));

vi.mock("vite", () => ({ createServer: async () => ({
  listen: async () => {}, close: async () => {}, resolvedUrls: { local: ["http://127.0.0.1:1/"] },
}) }));

describe("未導入の管理 Chromium と stop", () => {
  it.live("サーバーは起動し、セッションの stop は PNG だけ省略して案内と他形式を返す", () => {
    const warnings = collectingConsole();
    return Effect.gen(function* () {
      const dir = yield* temporaryDeps;
      const root = join(dir, "deps");
      const script = join(dir, "helper.json");
      yield* Effect.tryPromise(() => writeFile(script, JSON.stringify({ apps: [], events: [] })));
      const options = { port: 0, sessionsDir: join(dir, "sessions"), depsDir: root,
        helper: { command: process.execPath, args: [join(import.meta.dirname, "fixtures/fake-helper.ts"), script, join(dir, "helper.log")] },
        prepareUpdater: () => Effect.succeed(updaterLayer(() => Effect.succeed({ ops: [] }))) };
      const exports = Layer.mergeAll(
        MapCapture.layer.pipe(Layer.provide(Playwright.layer)),
        Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(FAKE_TEMPLATE) })),
        fakeAudioMix().layer,
      ).pipe(Layer.provideMerge(NodeFileSystem.layer));
      const server = yield* startedServer(options, realLayers(options, exports));
      const started = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/session/start`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "test.app", title: "未導入", audio: false, screen: false }),
      }));
      expect(started.status).toBe(200);
      const { dir: sessionDir } = yield* Effect.tryPromise(() => started.json() as Promise<{ dir: string }>);
      const stopped = yield* Effect.tryPromise(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        execFile("pnpm", ["cli", "stop"], { cwd: join(import.meta.dirname, "../.."), timeout: 15_000,
          env: { ...process.env, LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_DEPS: root, LIVE_MINDMAP_SESSIONS: options.sessionsDir, LIVE_MINDMAP_CONFIG: join(dir, "absent.json"), NO_COLOR: "1" },
        }, (error, stdout, stderr) => {
          if (error && (error.killed || typeof error.code !== "number")) return reject(error);
          resolve({ code: error ? error.code as number : 0, stdout, stderr });
        });
      }));
      expect(stopped.code, stopped.stderr).toBe(0);
      const expected = ["map.md", "map.json", "map.drawnix", "map.html"];
      for (const file of expected) {
        expect(existsSync(join(sessionDir, file)), file).toBe(true);
        expect(stopped.stdout).toContain(join(sessionDir, file));
      }
      expect(existsSync(join(sessionDir, "map.png"))).toBe(false);
      expect(unmanaged.launch).not.toHaveBeenCalled();
      expect(warnings.errors.filter((message) => message.startsWith("map.png を書き出せませんでした:"))).toHaveLength(1);
      expect(warnings.errors.find((message) => message.startsWith("map.png を書き出せませんでした:"))).toContain("pnpm cli install chromium");
    }).pipe(Effect.provideService(Console.Console, warnings.service), Effect.scoped);
  });
});
