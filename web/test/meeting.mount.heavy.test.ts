import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrollPanDelta } from "../src/camera.ts";
import { keyListRows } from "../src/app/keys/table.ts";
import { closeSocket, connectFrames, connectionCount, meetingFrames, NOTICE_FRAMES, openMeetingPage, readMeetingViewport, sendFrame, sendFrames, startMeetingServer, TIMEOUT, waitForMeasuredNodes, type MeetingFrames, type MeetingServer } from "./meetingPage.ts";
import { mapPoint } from "./reviewPage.ts";
import { withBrowser, type Page } from "./screenCompare.ts";

// 会議中（Foldkit 版）の Mount と Subscription の中身を、実ブラウザの 1 ページで 1 つずつ確かめる（Issue #829）。React 版が無くなった後も残す。
// ResizeObserver（画面の大きさ・ノードの高さ）・wheel・gesture（Safari のピンチ）・WebSocket（`/ws`）・文書の keydown は、DOM が無い unit では確かめられない（偽の要素では実際の通知が起きない）。
// 会議中の画面に <audio> は無い（再生は見返しだけ）ので、<audio> の時刻は review.mount.heavy.test.ts が確かめ続け、ここでは無いことを確かめる。
// `/ws` は page.routeWebSocket で本物の server の代わりに frame を送る。時間がかかる。事前に `pnpm --filter @live-mindmap/server deps:install chromium` が要る。

let server: MeetingServer;
let frames: MeetingFrames;
beforeAll(async () => {
  server = await startMeetingServer();
  frames = await meetingFrames();
}, TIMEOUT);
afterAll(async () => {
  await server.close();
});

const nodeCount = (page: Page): Promise<number> => page.locator("[data-node-id]").count();
const open = (browser: Parameters<typeof openMeetingPage>[0]) => openMeetingPage(browser, server, { frames: frames.first });

// 補間と測り直しが落ち着くまで待つ（ビューポートが続けて変わらなくなるまで）
async function settled(page: Page): Promise<void> {
  let last = JSON.stringify(await readMeetingViewport(page));
  let stable = 0;
  const deadline = Date.now() + 8_000;
  while (stable < 4) {
    if (Date.now() > deadline) throw new Error("ビューポートが落ち着きません");
    await page.waitForTimeout(50);
    const now = JSON.stringify(await readMeetingViewport(page));
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

describe("会議中（Foldkit 版）の入口", () => {
  it(
    "起動すると Foldkit の画面が出て、React の root も React Flow も無く、<audio> も無い。スナップショットが届くまでは待ち表示だけ",
    () => withBrowser(async (browser) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 801 } });
      const page = await context.newPage();
      await connectFrames(page, []);
      await page.goto(server.url);
      await page.locator("p.waiting").waitFor({ timeout: 30_000 });
      expect(await page.locator("p.waiting").textContent()).toBe("サーバーを待っています");
      for (const css of [".layout", ".map", ".map-surface", ".captions", ".side"]) expect(await page.locator(css).count(), css).toBe(0);
      // frame を送ると（本物の WebSocket の Subscription を通って）画面になる
      await sendFrames(page, frames.first);
      await page.locator(".map-node").first().waitFor({ timeout: 30_000 });
      await waitForMeasuredNodes(page, await nodeCount(page));
      expect(await page.locator("p.waiting").count()).toBe(0);
      expect(await page.locator(".layout").count()).toBe(1);
      expect(await page.locator(".map-viewport").count()).toBe(1);
      expect(await page.locator(".react-flow").count()).toBe(0);
      // React 19 は root の要素に __reactContainer$… を付ける。付いていなければ createRoot をしていない
      expect(await page.evaluate(() => Object.keys(document.getElementById("root")!).filter((key) => key.startsWith("__reactContainer")))).toEqual([]);
      expect(await page.locator("audio").count()).toBe(0);
      expect(await page.locator(".intake-notice").count()).toBe(0);
      expect(await page.locator("[data-node-id]").count()).toBeGreaterThan(1);
      await context.close();
    }),
    TIMEOUT,
  );

  it(
    "届かない・壊れた frame（知らない type・形の合わない値）は無視され、画面はそのまま",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await settled(page);
      const before = await readMeetingViewport(page);
      const count = await nodeCount(page);
      await sendFrame(page, { type: "unknown-type", payload: 1 });
      await sendFrame(page, { type: "intake", status: "not-a-status" });
      await sendFrame(page, { nodes: "壊れたスナップショット" });
      // 続けて正しい frame を送ると、無視した後も受け続けている
      await sendFrame(page, NOTICE_FRAMES.screen);
      await page.locator(".screen-notice").waitFor();
      expect(await nodeCount(page)).toBe(count);
      expect(await readMeetingViewport(page)).toEqual(before);
      await page.context().close();
    }),
    TIMEOUT,
  );
});

describe("会議中（Foldkit 版）の Mount", () => {
  it(
    "ResizeObserver: 画面の大きさを変えるとビューポートが測り直されて変わり、ノードは測った後の見える状態のまま",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await waitForMeasuredNodes(page, await nodeCount(page));
      await settled(page);
      const before = await readMeetingViewport(page);
      await page.setViewportSize({ width: 800, height: 520 });
      await page.waitForFunction(
        (previous) => (document.querySelector(".map-viewport") as HTMLElement).style.transform !== previous,
        `translate(${before.x}px, ${before.y}px) scale(${before.zoom})`,
        { timeout: 10_000 },
      );
      await settled(page);
      expect(await readMeetingViewport(page)).not.toEqual(before);
      await waitForMeasuredNodes(page, await nodeCount(page));
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "ResizeObserver: 反映で増えたノードも測られて見える状態になる（同じページ・同じ表示面のまま）。変わったことの列も増える",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      const before = await nodeCount(page);
      await waitForMeasuredNodes(page, before);
      const changesBefore = await page.locator(".changes__item").count();
      // 表示面の要素そのものが、反映で作り直されないことの目印
      await page.evaluate(() => ((document.querySelector(".map-surface") as HTMLElement & { __same?: boolean }).__same = true));
      await sendFrames(page, frames.reflected);
      await page.waitForFunction((count) => document.querySelectorAll("[data-node-id]").length > count, before, { timeout: 10_000 });
      const after = await nodeCount(page);
      expect(after).toBeGreaterThan(before);
      await waitForMeasuredNodes(page, after);
      expect(await page.locator(".changes__item").count()).toBeGreaterThan(changesBefore);
      expect(await page.evaluate(() => (document.querySelector(".map-surface") as (HTMLElement & { __same?: boolean }) | null)?.__same)).toBe(true);
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "wheel: 二本指スクロールの量だけ（scrollPanDelta の向きと大きさで）ビューポートが平行移動し、倍率は変わらない",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await settled(page);
      const before = await readMeetingViewport(page);
      const { x, y } = await mapPoint(page, "center");
      await page.mouse.move(x, y);
      await page.mouse.wheel(40, 90);
      await settled(page);
      const after = await readMeetingViewport(page);
      const isMac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
      const moved = scrollPanDelta({ deltaX: 40, deltaY: 90, deltaMode: 0, shiftKey: false }, isMac);
      expect(after.x - before.x).toBeCloseTo(moved.x, 3);
      expect(after.y - before.y).toBeCloseTo(moved.y, 3);
      expect(after.zoom).toBe(before.zoom);
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "wheel: Ctrl＋ホイール（ピンチ）で倍率が変わる",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await settled(page);
      const before = await readMeetingViewport(page);
      const { x, y } = await mapPoint(page, "center");
      await page.mouse.move(x, y);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -120);
      await page.keyboard.up("Control");
      await settled(page);
      expect((await readMeetingViewport(page)).zoom).toBeGreaterThan(before.zoom);
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "ポインタ（文書全体の pointermove・pointerup）: 何も無い所のドラッグで、動かした分だけビューポートが平行移動する。離すと止まる",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await settled(page);
      const before = await readMeetingViewport(page);
      const { x, y } = await mapPoint(page, "corner");
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 120, y - 60, { steps: 8 });
      await page.mouse.up();
      await settled(page);
      const dragged = await readMeetingViewport(page);
      expect(dragged.x - before.x).toBeCloseTo(-120, 3);
      expect(dragged.y - before.y).toBeCloseTo(-60, 3);
      expect(dragged.zoom).toBe(before.zoom);
      // 離した後の移動では動かない
      await page.mouse.move(x - 300, y - 200, { steps: 4 });
      await settled(page);
      expect(await readMeetingViewport(page)).toEqual(dragged);
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "requestAnimationFrame: 反映でノードの位置が動く間は補間が進み、終わると、最初から同じスナップショットで開いたページと同じ位置に着く",
    () => withBrowser(async (browser) => {
      const positionsOf = (page: Page) =>
        page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-node-id]")].map((el) => [el.dataset.nodeId!, el.style.transform])));
      const moved = await open(browser);
      await waitForMeasuredNodes(moved, await nodeCount(moved));
      const before = await nodeCount(moved);
      await sendFrames(moved, frames.reflected);
      await moved.waitForFunction((count) => document.querySelectorAll("[data-node-id]").length > count, before, { timeout: 10_000 });
      await settled(moved);
      const fresh = await openMeetingPage(browser, server, { frames: frames.reflected });
      await settled(fresh);
      await waitForMeasuredNodes(fresh, await nodeCount(fresh));
      await waitForMeasuredNodes(moved, await nodeCount(fresh));
      expect(await positionsOf(moved)).toEqual(await positionsOf(fresh));
      await moved.context().close();
      await fresh.context().close();
    }),
    TIMEOUT,
  );

  it(
    "gesture: .map-surface に合成した gesturestart・gesturechange（Safari のピンチ）で倍率が変わる。始まりからの累積の倍率で、前回との比だけ掛かる",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await settled(page);
      const before = await readMeetingViewport(page);
      const point = await mapPoint(page, "center");
      const gesture = (type: string, scale: number) =>
        page.evaluate(
          ([name, s, clientX, clientY]) => {
            const event = new Event(name as string, { bubbles: true, cancelable: true });
            Object.assign(event, { scale: s, clientX, clientY });
            document.querySelector(".map-surface")!.dispatchEvent(event);
          },
          [type, scale, point.x, point.y] as const,
        );
      await gesture("gesturestart", 1);
      await gesture("gesturechange", 1.1);
      await settled(page);
      expect((await readMeetingViewport(page)).zoom).toBeCloseTo(before.zoom * 1.1, 5);
      // 累積の 1.21 は、前回の 1.1 からは 1.1 倍
      await gesture("gesturechange", 1.21);
      await settled(page);
      expect((await readMeetingViewport(page)).zoom).toBeCloseTo(before.zoom * 1.21, 5);
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "<audio>: 会議中の画面には <audio> が無い（再生を持たない）。キーで見返しの操作（Space・Home・M）を押しても何も起こらず、ビューポートも変わらない",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await settled(page);
      const before = await readMeetingViewport(page);
      expect(await page.locator("audio").count()).toBe(0);
      for (const key of ["Space", "Home", "End", "M", "J", "L", ",", ".", ">", "<"]) await page.keyboard.press(key);
      await settled(page);
      expect(await page.locator("audio").count()).toBe(0);
      expect(await readMeetingViewport(page)).toEqual(before);
      await page.context().close();
    }),
    TIMEOUT,
  );
});

describe("会議中（Foldkit 版）の Subscription", () => {
  it(
    "キー（文書の keydown）: ? で会議中の行だけの一覧が .map の中に開く。E で右の列、C で字幕を隠し、もう一度で戻す",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await settled(page);
      await page.keyboard.press("Shift+?");
      await page.locator(".map .key-list").waitFor();
      expect(await page.locator(".key-list__keys").allTextContents()).toEqual(keyListRows("live").map((row) => row.keys));
      await page.keyboard.press("Escape");
      await page.locator(".key-list").waitFor({ state: "detached" });
      expect(await page.locator(".side").count()).toBe(1);
      await page.keyboard.press("E");
      await page.locator(".side").waitFor({ state: "detached" });
      await page.keyboard.press("E");
      await page.locator(".side").waitFor();
      expect(await page.locator(".captions").count()).toBe(1);
      await page.keyboard.press("C");
      await page.locator(".captions").waitFor({ state: "detached" });
      await page.keyboard.press("C");
      await page.locator(".captions").waitFor();
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "WebSocket: 切れると共有画面・相手の音声の一文が消え、スナップショットと字幕は残る。1 秒後に自動でつなぎ直し、server が先に送る値で画面が最新になる",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await settled(page);
      await sendFrames(page, [NOTICE_FRAMES.screen, NOTICE_FRAMES.tap]);
      await page.locator(".screen-notice").waitFor();
      await page.locator(".tap-notice").waitFor();
      const count = await nodeCount(page);
      const captions = await page.locator(".captions__line").allTextContents();
      expect(captions.length).toBeGreaterThan(0);
      expect(connectionCount(page)).toBe(1);
      await closeSocket(page);
      await page.locator(".screen-notice").waitFor({ state: "detached" });
      await page.locator(".tap-notice").waitFor({ state: "detached" });
      expect(await nodeCount(page)).toBe(count);
      // 切れただけでは字幕は残る
      expect(await page.locator(".captions__line").allTextContents()).toEqual(captions);
      // つなぎ直す（RECONNECT_MS 後）。server が先に送る frame（字幕・スナップショット）で画面が最新になる
      await expect.poll(() => connectionCount(page), { timeout: 15_000 }).toBe(2);
      await expect.poll(() => page.locator(".captions__line").allTextContents(), { timeout: 15_000 }).toEqual(captions);
      expect(await nodeCount(page)).toBe(count);
      await sendFrame(page, NOTICE_FRAMES.screen);
      await page.locator(".screen-notice").waitFor();
      await page.context().close();
    }),
    TIMEOUT,
  );
});
