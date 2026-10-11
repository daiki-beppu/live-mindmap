import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue, Stream, type Cause } from "effect";
import type { Page } from "playwright-core";
import { createServer } from "vite";
import { vi } from "vitest";
import { DiffUpdater } from "../src/core/index.ts";
import { Helpers, type HelperExitInfo } from "../src/helpers.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { Playwright } from "../src/playwright.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { managedPlaywright } from "./fixtures/managedPlaywright.ts";
import { startedServer } from "./fixtures/startedServer.ts";

const LABEL = "ローカルモード・Apple Intelligence";
const TIMEOUT = 90_000;
const webRoot = join(import.meta.dirname, "../../web");

const helperLayer = Layer.succeed(Helpers, Helpers.of({
  apps: Effect.succeed([]),
  launch: () => Effect.gen(function* () {
    const events = yield* Queue.make<string, Cause.Done>();
    Queue.offerUnsafe(events, JSON.stringify({ type: "screen-off", start: 0, reason: "許可なし" }));
    const exit = yield* Deferred.make<HelperExitInfo>();
    const stop = Effect.asVoid(Effect.andThen(Queue.end(events), Deferred.succeed(exit, { code: null, signal: "SIGTERM" })));
    yield* Effect.addFinalizer(() => stop);
    return { events: Stream.fromQueue(events) as Stream.Stream<string>, stop, exit: Deferred.await(exit), stderrTail: Effect.succeed([]) };
  }),
}));
const realSinks = SessionSinks.layer({
  prepareUpdater: () => Effect.succeed(Layer.succeed(DiffUpdater, DiffUpdater.of({
    update: (input) => Effect.succeed({ ops: [], processedRemarks: input.fresh.length }),
  }))),
}).pipe(Layer.provide(fakeExportServices()));
const sessionSinks = Layer.effect(SessionSinks)(Effect.gen(function* () {
  const sinks = yield* SessionSinks;
  return SessionSinks.of({ ...sinks, open: (args) => sinks.open(args).pipe(
    Effect.tap(() => args.speak({ type: "speaking", track: "相手", text: "位置を確かめる字幕です。" })),
  ) });
})).pipe(Layer.provide(realSinks));

const bounds = async (page: Page) => ({
  map: await page.locator(".map").boundingBox(),
  captions: await page.locator(".captions").boundingBox(),
});
const hasTopGreenLine = () => [...document.querySelectorAll("*")].some((element) => {
  const rect = element.getBoundingClientRect();
  const css = getComputedStyle(element);
  const fill = rect.y === 0 && rect.height === 2 && rect.width === innerWidth;
  const border = rect.y === 0 && css.borderTopWidth === "2px" && rect.width === innerWidth;
  const color = (fill ? css.backgroundColor : css.borderTopColor).match(/\d+/g)?.map(Number);
  return (fill || border) && color !== undefined && color[1]! > color[0]! && color[1]! > color[2]!;
});

describe("開始したセッションのローカルモード表示", () => {
  it.live.each([1200, 480])("同じ画面で通常→local→終了→通常が反映され、線と文字の出し入れで字幕・マップを動かさない（幅 %s）", (width) => Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-local-view-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })));
    const server = yield* startedServer({ port: 0, sessionsDir: dir }, { helpers: helperLayer, sessionSinks, managedDeps: forbiddenManagedDeps });
    const web = yield* Effect.acquireRelease(Effect.tryPromise(async () => {
      const vite = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), server: {
        host: "127.0.0.1", port: 0, hmr: false,
        proxy: { "/ws": { target: `ws://127.0.0.1:${server.port}`, ws: true, rewrite: () => "/" } },
      } });
      try { await vite.listen(); return vite; } catch (error) { await vite.close(); throw error; }
    }), (vite) => Effect.promise(() => vite.close()));
    const address = web.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("web のポートを取得できません");
    const browser = yield* Effect.acquireRelease((yield* Playwright).launch(), (running) => Effect.promise(() => running.close()));
    const request = (path: string, body?: unknown) => Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const start = (local: boolean) => request("/session/start", { app: "us.zoom.xos", audio: false, screen: false,
      model: local ? { name: "apple", route: "apple", local: true } : defaultClaude,
    });
    const page = yield* Effect.tryPromise(() => browser.newPage({ viewport: { width, height: 800 } }));
    yield* Effect.tryPromise(() => page.addInitScript(() => {
      const state = window as unknown as { feedSockets: WebSocket[] };
      state.feedSockets = [];
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).endsWith("/ws")) state.feedSockets.push(this);
        }
      };
    }));
    yield* Effect.tryPromise(() => page.goto(`http://127.0.0.1:${address.port}/`));
    expect((yield* start(false)).status).toBe(200);
    yield* Effect.tryPromise(() => page.locator(".layout").waitFor());
    expect(yield* Effect.tryPromise(() => page.getByText(LABEL, { exact: true }).count())).toBe(0);
    expect(yield* Effect.tryPromise(() => page.evaluate(hasTopGreenLine))).toBe(false);
    const before = yield* Effect.tryPromise(() => bounds(page));
    expect(before.map).not.toBeNull();
    expect(before.captions).not.toBeNull();
    expect((yield* request("/session/stop")).status).toBe(200);
    expect((yield* start(true)).status).toBe(200);
    yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await page.getByText(LABEL, { exact: true }).count()).toBe(1)));
    expect(yield* Effect.tryPromise(() => bounds(page))).toEqual(before);
    yield* Effect.tryPromise(() => page.locator(".screen-notice").waitFor());
    const style = yield* Effect.tryPromise(() => page.getByText(LABEL, { exact: true }).evaluate((element) => {
      const text = element.getBoundingClientRect();
      let positioned: Element | null = element;
      while (positioned && getComputedStyle(positioned).position !== "absolute") positioned = positioned.parentElement;
      const notice = document.querySelector(".screen-notice")?.getBoundingClientRect();
      const css = getComputedStyle(element);
      return { absolute: positioned !== null, shadow: css.boxShadow,
        background: css.backgroundColor, border: css.borderTopWidth, radius: css.borderRadius,
        small: parseFloat(css.fontSize) <= parseFloat(getComputedStyle(document.documentElement).fontSize),
        noticePresent: notice !== undefined, x: text.x, y: text.y,
        overlaps: notice ? text.left < notice.right && text.right > notice.left && text.top < notice.bottom && text.bottom > notice.top : false,
      };
    }));
    expect(style.absolute).toBe(true);
    expect(style.shadow).toBe("none");
    expect(style.background).toBe("rgba(0, 0, 0, 0)");
    expect(style.border).toBe("0px");
    expect(style.radius).toBe("0px");
    expect(style.small).toBe(true);
    expect(yield* Effect.tryPromise(() => page.evaluate(hasTopGreenLine))).toBe(true);
    expect(style.x).toBeLessThan(width / 2);
    expect(style.y).toBeLessThan(50);
    expect(style.overlaps).toBe(false);
    expect(style.noticePresent).toBe(true);
    expect(yield* Effect.tryPromise(() => page.getByText("試験的", { exact: false }).count())).toBe(0);

    const socketCount = yield* Effect.tryPromise(() => page.evaluate(() => {
      const { feedSockets } = window as unknown as { feedSockets: WebSocket[] };
      feedSockets.at(-1)!.close();
      return feedSockets.length;
    }));
    yield* Effect.tryPromise(() => page.waitForFunction((count) => {
      const { feedSockets } = window as unknown as { feedSockets: WebSocket[] };
      return feedSockets.length > count && feedSockets.at(-1)!.readyState === WebSocket.OPEN;
    }, socketCount));
    yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await page.getByText(LABEL, { exact: true }).count()).toBe(1)));

    const late = yield* Effect.tryPromise(() => browser.newPage({ viewport: { width, height: 800 } }));
    yield* Effect.tryPromise(() => late.goto(`http://127.0.0.1:${address.port}/`));
    yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await late.getByText(LABEL, { exact: true }).count()).toBe(1)));
    expect((yield* request("/session/stop")).status).toBe(200);
    yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await page.getByText(LABEL, { exact: true }).count()).toBe(0)));
    expect(yield* Effect.tryPromise(() => page.evaluate(hasTopGreenLine))).toBe(false);
    expect(yield* Effect.tryPromise(() => page.locator(".map").boundingBox())).toEqual(before.map);
    yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await late.getByText(LABEL, { exact: true }).count()).toBe(0)));
    expect((yield* start(false)).status).toBe(200);
    expect(yield* Effect.tryPromise(() => page.getByText(LABEL, { exact: true }).count())).toBe(0);
    expect(yield* Effect.tryPromise(() => bounds(page))).toEqual(before);
    expect((yield* request("/session/stop")).status).toBe(200);
  }).pipe(Effect.provide(managedPlaywright)), TIMEOUT);
});
