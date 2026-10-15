import { mkdtemp, rm } from "node:fs/promises";
import { readyHelperChecks } from "./fixtures/helperCheck.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue, Stream, type Cause } from "effect";
import type { Page, WebSocketRoute } from "playwright-core";
import { createServer } from "vite";
import { vi } from "vitest";
import { DiffUpdater, type Snapshot } from "../src/core/index.ts";
import { Helpers, type HelperExitInfo } from "../src/helpers.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { Playwright } from "../src/playwright.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { managedPlaywright } from "./fixtures/managedPlaywright.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { appleLiveServer } from "./fixtures/appleLiveServer.ts";

const LABEL = "ローカルモード・Apple Intelligence";
const TIMEOUT = 90_000;
const webRoot = join(import.meta.dirname, "../../web");

const helperLayer = Layer.succeed(Helpers, Helpers.of({
  ...readyHelperChecks,
  apps: Effect.succeed([]),
  launch: () => Effect.gen(function* () {
    const events = yield* Queue.make<string, Cause.Done>();
    Queue.offerUnsafe(events, JSON.stringify({ type: "screen-off", start: 0, reason: "許可なし" }));
    const exit = yield* Deferred.make<HelperExitInfo>();
    const stop = Effect.asVoid(Effect.andThen(Queue.end(events), Deferred.succeed(exit, { code: null, signal: "SIGTERM" })));
    yield* Effect.addFinalizer(() => stop);
    return { events: Stream.fromQueue(events) as Stream.Stream<string>, stop, exit: Deferred.await(exit), stderrTail: Effect.succeed([]), send: () => Effect.void };
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
  it.live("ローカルモードの会議中の画面だけでも（server なし）、差分更新の状態ごとの線色と指定文言を描く", () => Effect.gen(function* () {
    const web = yield* Effect.acquireRelease(Effect.tryPromise(async () => {
      const vite = await createServer({ root: webRoot, configFile: join(webRoot, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false, ws: false } });
      try { await vite.listen(); return vite; } catch (error) { await vite.close(); throw error; }
    }), (vite) => Effect.promise(() => vite.close()));
    const address = web.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("web のポートを取得できません");
    const browser = yield* Effect.acquireRelease((yield* Playwright).launch(), (running) => Effect.promise(() => running.close()));
    const page = yield* Effect.tryPromise(() => browser.newPage());
    // 本物の server の代わりに、`/ws` へ frame を送る（スナップショット → ローカルモード → 差分更新の状態）
    let socket: WebSocketRoute | undefined;
    const snapshot: Snapshot = { nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }], round: 0, changes: [], remarks: [] };
    yield* Effect.tryPromise(() => page.routeWebSocket("**/ws", (ws) => {
      socket = ws;
      ws.send(JSON.stringify(snapshot));
      ws.send(JSON.stringify({ type: "session-mode", local: true }));
      ws.send(JSON.stringify({ type: "diff-update", state: { status: "running" } }));
    }));
    yield* Effect.tryPromise(() => page.goto(`http://127.0.0.1:${address.port}/`));
    const notice = page.locator(".layout--local .local-mode-notice");
    const line = page.locator(".layout--local .local-mode-line");
    for (const [status, text] of [["running", LABEL], ["restarting", `${LABEL}・マップの更新を再開しています`], ["stopped", `${LABEL}・マップの更新が止まっています`]] as const) {
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(socket).toBeDefined()));
      socket!.send(JSON.stringify({ type: "diff-update", state: { status } }));
      yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await notice.textContent()).toBe(text)));
      const color = yield* Effect.tryPromise(() => line.evaluate((element) => getComputedStyle(element).backgroundColor));
      const rgb = color.match(/\d+/g)!.map(Number);
      if (status === "running") expect(color).toBe("rgb(22, 101, 52)");
      else if (status === "restarting") {
        expect(rgb[0]!).toBeGreaterThan(rgb[1]! + 30);
        expect(rgb[1]!).toBeGreaterThan(rgb[2]!);
      } else {
        expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThanOrEqual(40);
        expect(color).not.toBe("rgb(22, 101, 52)");
      }
    }
    // 会議中の画面は React ではなく Foldkit で描いている
    expect(yield* Effect.tryPromise(() => page.locator(".react-flow").count())).toBe(0);
  }).pipe(Effect.provide(managedPlaywright)), TIMEOUT);

  it.live.each([1200, 480])("同じ画面の再起動・復帰・停止で線の色と文字を替え、既存のマップと字幕の位置を保つ（幅 %s）", (width) => Effect.gen(function* () {
    const server = yield* appleLiveServer();
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
    const page = yield* Effect.tryPromise(() => browser.newPage({ viewport: { width, height: 800 } }));
    yield* Effect.tryPromise(() => page.goto(`http://127.0.0.1:${address.port}/`));
    expect((yield* server.start).status).toBe(200);
    const waitText = (text: string) => Effect.tryPromise(() => vi.waitFor(async () => expect(await page.locator(".local-mode-notice").textContent()).toBe(text)));
    yield* waitText(LABEL);
    yield* server.emit({ type: "speaker-off", start: 0, reason: "モデルなし" }); // 相手の発言は話者の確定を待つので、話者分離を使えない helper にして待たせない（Issue #1021）
    yield* server.emit({ type: "remark", track: "相手", start: 1, end: 2, text: "採用を進めます。" }); // 発言 1 件ですぐ差分更新を呼ぶ
    yield* Effect.tryPromise(() => page.locator(".map-node__text").filter({ hasText: /^採用$/ }).waitFor());
    yield* server.speak({ type: "speaking", track: "自分", text: "状態が変わる前から表示している字幕です。" });
    // 既存 CSS は幅632px未満で字幕の幅が0になる。配置の保持はその状態でも測り、可視表示は広い画面で確かめる。
    yield* Effect.tryPromise(() => page.getByText("状態が変わる前から表示している字幕です。", { exact: true }).waitFor({ state: "attached" }));
    if (width === 1200) yield* Effect.tryPromise(() => page.locator(".captions").waitFor());
    const before = yield* Effect.tryPromise(() => bounds(page));
    expect(before.map).not.toBeNull();
    expect(before.captions).not.toBeNull();
    const color = () => page.locator(".local-mode-line").evaluate((element) => getComputedStyle(element).backgroundColor);
    const green = yield* Effect.tryPromise(color);
    expect(green).toBe("rgb(22, 101, 52)");
    const checkLayout = Effect.tryPromise(async () => {
      expect(await bounds(page)).toEqual(before);
      expect(await page.locator(".map-node__text").filter({ hasText: /^採用$/ }).count()).toBe(1);
      const css = await page.locator(".local-mode-notice").evaluate((element) => {
        const style = getComputedStyle(element);
        return { position: style.position, shadow: style.boxShadow, background: style.backgroundColor, border: style.borderTopWidth, radius: style.borderRadius };
      });
      expect(css).toEqual({ position: "absolute", shadow: "none", background: "rgba(0, 0, 0, 0)", border: "0px", radius: "0px" });
    });
    yield* server.fake.crash(0);
    yield* waitText(`${LABEL}・マップの更新を再開しています`);
    const orange = (yield* Effect.tryPromise(color)).match(/\d+/g)!.map(Number);
    expect(orange[0]!).toBeGreaterThan(orange[1]! + 30);
    expect(orange[1]!).toBeGreaterThan(orange[2]!);
    yield* checkLayout;
    yield* server.fake.releaseReady(1);
    yield* waitText(LABEL);
    expect(yield* Effect.tryPromise(color)).toBe(green);
    yield* checkLayout;
    for (let i = 1; i < 3; i++) {
      yield* server.fake.crash(i);
      yield* Effect.tryPromise(() => vi.waitFor(() => {
        expect(server.fake.processes).toHaveLength(i + 2);
        expect(server.fake.requests.some((request) => request.url === `${server.fake.processes[i + 1]!.url}/chat/completions`)).toBe(true);
      }));
      yield* waitText(LABEL);
    }
    yield* server.fake.crash(3);
    yield* waitText(`${LABEL}・マップの更新が止まっています`);
    const gray = (yield* Effect.tryPromise(color)).match(/\d+/g)!.map(Number);
    expect(Math.max(...gray) - Math.min(...gray)).toBeLessThanOrEqual(40);
    expect(yield* Effect.tryPromise(color)).not.toBe(green);
    yield* checkLayout;
    yield* server.emit({ type: "partial", track: "自分", start: 5, end: 6, text: "停止した後も字幕は続きます。" });
    yield* Effect.tryPromise(() => page.getByText("停止した後も字幕は続きます。", { exact: true }).waitFor({ state: "attached" }));
    if (width === 1200) yield* Effect.tryPromise(() => page.getByText("停止した後も字幕は続きます。", { exact: true }).waitFor());
    expect((yield* server.stop).status).toBe(200);
  }).pipe(Effect.provide(managedPlaywright)), TIMEOUT);

  it.live.each([1200, 480])("同じ画面で通常→local→終了→通常が反映され、線と文字の出し入れで字幕・マップを動かさない（幅 %s）", (width) => Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-local-view-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })));
    const server = yield* startedServer({ port: 0, sessionsDir: dir }, { helpers: helperLayer, sessionSinks, managedDeps: readyManagedDeps });
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
