import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { createServer as createViteServer } from "vite";
import type { Page } from "playwright-core";
import { CAPTURE_OVERFLOW_ATTRIBUTE, CAPTURE_READY_ATTRIBUTE, CAPTURE_SNAPSHOT_GLOBAL } from "./core/capture.ts";
import type { Snapshot } from "./core/index.ts";
import { Playwright } from "./playwright.ts";

const WEB_ROOT = join(import.meta.dirname, "../../web");
const VIEWPORT = { width: 1600, height: 1000 };
const READY_TIMEOUT_MS = 30_000;
const CROP_MARGIN = 32;

export class CaptureFailed extends Schema.TaggedError<CaptureFailed>()("CaptureFailed", { message: Schema.String }) {}

const failed = (e: unknown) => new CaptureFailed({ message: e instanceof Error ? e.message : String(e) });

export const withCapturePage = Effect.fnUntraced(function* <A, E, R>(
  snapshot: Snapshot,
  fn: (page: Page) => Effect.Effect<A, E, R>,
) {
  const playwright = yield* Playwright;
  const vite = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createViteServer({
          root: WEB_ROOT,
          configFile: join(WEB_ROOT, "vite.config.ts"),
          logLevel: "silent",
          clearScreen: false,
          server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
        }),
      catch: failed,
    }),
    (server) => Effect.promise(() => server.close()),
  );
  yield* Effect.tryPromise({ try: () => vite.listen(), catch: failed });
  const url = vite.resolvedUrls?.local[0];
  if (!url) return yield* new CaptureFailed({ message: "撮影用の表示ページの URL を取得できません" });
  const browser = yield* Effect.acquireRelease(
    playwright.launch.pipe(
      Effect.mapError((e) =>
        new CaptureFailed({ message: e._tag === "ChromiumMissing" ? e.message : `Chromium を起動できません（${e.message}）` }),
      ),
    ),
    (browser) => Effect.promise(() => browser.close()),
  );
  const page = yield* Effect.tryPromise({ try: () => browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 }), catch: failed });
  yield* Effect.tryPromise({
    try: () =>
      page.addInitScript(
        ({ name, value }) => {
          (globalThis as Record<string, unknown>)[name] = value;
        },
        { name: CAPTURE_SNAPSHOT_GLOBAL, value: snapshot },
      ),
    catch: failed,
  });
  yield* Effect.tryPromise({ try: () => page.goto(url), catch: failed });
  yield* Effect.tryPromise({
    try: () => page.waitForSelector(`[${CAPTURE_READY_ATTRIBUTE}], [${CAPTURE_OVERFLOW_ATTRIBUTE}]`, { timeout: READY_TIMEOUT_MS }),
    catch: failed,
  });
  const overflow = yield* Effect.tryPromise({ try: () => page.locator(`[${CAPTURE_OVERFLOW_ATTRIBUTE}]`).count(), catch: failed });
  if (overflow > 0) {
    return yield* new CaptureFailed({
      message: `マップ全体を ${VIEWPORT.width}×${VIEWPORT.height} の撮影画面に収められません（ノード数: ${snapshot.nodes.length}）`,
    });
  }
  return yield* fn(page);
}, Effect.scoped);

const captureMap = (snapshot: Snapshot, path: string): Effect.Effect<void, CaptureFailed, Playwright> =>
  withCapturePage(snapshot, (page) =>
    Effect.tryPromise({
      try: async () => {
        const boxes = (await Promise.all((await page.locator(".map-node-slot").all()).map((node) => node.boundingBox()))).filter((b) => b !== null);
        if (boxes.length === 0) {
          await page.screenshot({ path, type: "png" });
          return;
        }
        const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - CROP_MARGIN);
        const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - CROP_MARGIN);
        const right = Math.min(VIEWPORT.width, Math.max(...boxes.map((b) => b.x + b.width)) + CROP_MARGIN);
        const bottom = Math.min(VIEWPORT.height, Math.max(...boxes.map((b) => b.y + b.height)) + CROP_MARGIN);
        await page.screenshot({ path, type: "png", clip: { x, y, width: right - x, height: bottom - y } });
      },
      catch: failed,
    }),
  );

export class MapCapture extends Context.Service<MapCapture, {
  readonly capture: (snapshot: Snapshot, path: string) => Effect.Effect<void, CaptureFailed>;
}>()("live-mindmap/server/MapCapture") {
  static readonly layer = Layer.effect(MapCapture)(
    Effect.gen(function* () {
      const playwright = yield* Playwright;
      return MapCapture.of({
        capture: (snapshot, path) => captureMap(snapshot, path).pipe(Effect.provideService(Playwright, playwright)),
      });
    }),
  );
}
