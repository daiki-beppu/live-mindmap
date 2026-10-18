import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeFileSystem, NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Exit, Layer } from "effect";
import { beforeEach, vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { ManagedDeps } from "../src/managedDeps.ts";
import { Playwright } from "../src/playwright.ts";
import { ReviewBuild } from "../src/review.ts";
import { realLayers } from "../src/server.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { fakeReadings } from "./fixtures/readings.ts";
import { collectingConsole, FAKE_TEMPLATE } from "./fixtures/exportServices.ts";
import { temporaryDeps } from "./fixtures/managedDeps.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { readyManagedDeps, withFakeClaude } from "./fixtures/readyManagedDeps.ts";

const unmanaged = vi.hoisted(() => ({ launch: vi.fn(async () => { throw new Error("通常依存の Chromium は使用できません"); }) }));
vi.mock("playwright-core", () => ({ chromium: { launch: unmanaged.launch } }));

vi.mock("vite", () => ({ createServer: async () => ({
  listen: async () => {}, close: async () => {}, resolvedUrls: { local: ["http://127.0.0.1:1/"] },
}) }));

beforeEach(() => { unmanaged.launch.mockClear(); });

// 管理実体の絶対パス import は名前指定の vi.mock に届かないため、読込口だけをテスト用に接続する。
const loadChromium = Layer.effect(ManagedDeps, Effect.gen(function* () {
  const deps = yield* ManagedDeps;
  const load = ((name: "chromium" | "claude") => name === "chromium"
    ? Effect.promise(() => import("playwright-core"))
    : Effect.die("Claude SDK の読み込みは対象外")) as ManagedDeps["Service"]["load"];
  return ManagedDeps.of({ ...deps, load });
})).pipe(Layer.provide(readyManagedDeps));

describe("管理 Chromium と stop", () => {
  it.live.each([
    { available: false, title: "サーバーは起動し、セッションの stop は PNG だけ省略して案内と他形式を返す" },
    { available: true, title: "Chromium の launch に失敗しても stop は理由を警告し PNG 以外の形式を返す" },
  ])("$title", ({ available }) => {
    const warnings = collectingConsole();
    return Effect.gen(function* () {
      const dir = yield* temporaryDeps;
      const root = join(dir, "deps");
      const script = join(dir, "helper.json");
      yield* Effect.tryPromise(() => writeFile(script, JSON.stringify({ apps: [], events: [] })));
      const options = { port: 0, sessionsDir: join(dir, "sessions"), depsDir: root,
        helper: { command: process.execPath, args: [join(import.meta.dirname, "fixtures/fake-helper.ts"), script, join(dir, "helper.log")] },
        prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) };
      const capture = MapCapture.layer.pipe(Layer.provide(Playwright.layer));
      const exports = Layer.mergeAll(
        available ? capture.pipe(Layer.provide(loadChromium)) : capture,
        Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(FAKE_TEMPLATE) })),
        fakeAudioMix().layer,
        fakeReadings().layer,
      ).pipe(Layer.provideMerge(NodeFileSystem.layer));
      const layers = realLayers(options, exports);
      const server = yield* startedServer(options, { ...layers, managedDeps: withFakeClaude(layers.managedDeps) });
      const started = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/session/start`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: "test.app", title: "未導入", audio: false, screen: false }),
      }));
      expect(started.status).toBe(200);
      const { dir: sessionDir } = yield* Effect.tryPromise(() => started.json() as Promise<{ dir: string }>);
      // stop は CLI の HTTP クライアントだけを使う。標準出力は Console で集め、終了は Exit で見る（サーバーの警告を集める Console とは別）
      const stdout: string[] = [];
      const cliConsole: Console.Console = { ...console, log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); } };
      const stopExit = yield* runCli(["stop"]).pipe(
        Effect.provide(Layer.mergeAll(
          NodeServices.layer, unusedApple, readyManagedDeps, NodeHttpClient.layerUndici,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_DEPS: root, LIVE_MINDMAP_SESSIONS: options.sessionsDir, LIVE_MINDMAP_CONFIG: join(dir, "absent.json") })),
          Layer.succeed(Console.Console, cliConsole),
          Layer.succeed(MapCapture, MapCapture.of({ capture: () => Effect.void })),
          Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.succeed(FAKE_TEMPLATE) })),
          fakeAudioMix().layer,
          fakeScreenJpeg().layer,
        )),
        Effect.exit,
      );
      expect(Exit.isSuccess(stopExit), String(stopExit)).toBe(true);
      const stopped = { stdout: stdout.join("") };
      const expected = ["map.md", "map.json", "map.drawnix", "map.html"];
      for (const file of expected) {
        expect(existsSync(join(sessionDir, file)), file).toBe(true);
        expect(stopped.stdout).toContain(join(sessionDir, file));
      }
      expect(existsSync(join(sessionDir, "map.png"))).toBe(false);
      const captureWarnings = warnings.errors.filter((message) => message.startsWith("map.png を書き出せませんでした:"));
      expect(captureWarnings).toHaveLength(1);
      if (available) {
        expect(captureWarnings[0]).toContain("通常依存の Chromium は使用できません");
        expect(unmanaged.launch).toHaveBeenCalledTimes(1);
      } else {
        expect(unmanaged.launch).not.toHaveBeenCalled();
        // 入れ方は 1 回だけ出す
        expect(captureWarnings[0]?.split("pnpm cli install chromium")).toHaveLength(2);
      }
    }).pipe(Effect.provideService(Console.Console, warnings.service), Effect.scoped);
  });
});
