import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTION_SLIDE_MS } from "../src/captions.ts";
import { scrollPanDelta } from "../src/camera.ts";
import { keyListRows } from "../src/app/keys/table.ts";
import { closeSocket, connectFrames, connectionCount, meetingFrames, NOTICE_FRAMES, openMeetingPage, readMeetingViewport, sendFrame, sendFrames, startMeetingServer, MEETING_TIMEOUT, waitForMeasuredNodes, type MeetingFrames, type MeetingServer } from "./meetingPage.ts";
import { spokenBubble, spokenFrame } from "./fixtures/captions.ts";
import { mapPoint, near, rectOf, styleOf } from "./reviewPage.ts";
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
}, MEETING_TIMEOUT);
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
    MEETING_TIMEOUT,
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
      const captions = await page.locator(".captions__bubble").allTextContents();
      expect(captions.length).toBeGreaterThan(0);
      expect(connectionCount(page)).toBe(1);
      await closeSocket(page);
      await page.locator(".screen-notice").waitFor({ state: "detached" });
      await page.locator(".tap-notice").waitFor({ state: "detached" });
      expect(await nodeCount(page)).toBe(count);
      // 切れただけでは字幕は残る
      expect(await page.locator(".captions__bubble").allTextContents()).toEqual(captions);
      // つなぎ直す（RECONNECT_MS 後）。server が先に送る frame（字幕・スナップショット）で画面が最新になる
      await expect.poll(() => connectionCount(page), { timeout: 15_000 }).toBe(2);
      await expect.poll(() => page.locator(".captions__bubble").allTextContents(), { timeout: 15_000 }).toEqual(captions);
      expect(await nodeCount(page)).toBe(count);
      await sendFrame(page, NOTICE_FRAMES.screen);
      await page.locator(".screen-notice").waitFor();
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );
});

// ユーティリティへ移した値は、素の CSS の文面では確かめられない。実ブラウザの computed style と位置で確かめる（Issue #1008: 替える前の CSS との照合は外し、今の値を期待値にする）。
// 字幕と知らせの位置は、窓の幅 1280 で幅 648px、字幕の左右 12px の外に知らせ。値は animation・transition が終わった後に読み（styleOf・rectOf が最後まで進める）、
// 配置が落ち着くのは決め打ちの待ちではなく、値に届くまで待つ
describe("会議中（Foldkit 版）の寸法", () => {
  const CAPTIONS_WIDTH = 648; // min(720px, 100vw − 2 × 316px) の 1280px での値

  it(
    "字幕の吹き出し: 幅は文字の量で変わらない。吹き出しが増えて位置が変わる動きは、終われば止まる（揺れ続けない）",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      const bubble = (id: string, start: number, text: string) => ({ id, track: "相手", speaker: "相手 A", label: "確定", start, end: start + 1, text, settledLength: text.length });
      await sendFrame(page, { type: "captions", bubbles: [bubble("short", 1, "はい"), bubble("long", 2, "これはとても長い文章です。".repeat(8))] });
      await expect.poll(() => page.locator(".captions__bubble").count(), { timeout: 10_000 }).toBe(2);
      const bubbleWidths = () => page.evaluate(() => Array.from(document.querySelectorAll(".captions__bubble")).map((b) => b.getBoundingClientRect().width));
      await expect.poll(async () => (await bubbleWidths()).every((w) => w > 0), { timeout: 5_000 }).toBe(true);
      const [shortWidth, longWidth] = await bubbleWidths();
      near(shortWidth!, longWidth!, "短い文と長い文の吹き出しの幅");
      await page.waitForTimeout(500); // Mount（動きの監視）が張られるのを待つ
      // 動きが付いた呼び出しを記録する（動きは 250ms で終わるので、終わった後に探しても見つからない）
      await page.evaluate(() => {
        const slides: { id: string | null; transform: boolean }[] = [];
        (window as unknown as { __slides: typeof slides }).__slides = slides;
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (this: Element, keyframes, options) {
          slides.push({ id: this.getAttribute("data-caption-id"), transform: JSON.stringify(keyframes).includes("translateY") });
          return animate.call(this, keyframes, options);
        };
      });
      await sendFrame(page, { type: "captions", bubbles: [bubble("short", 1, "はい"), bubble("long", 2, "これはとても長い文章です。".repeat(8)), bubble("next", 3, "次の発言です")] });
      // 末尾に足すと既存の行が上へ動く。その行に滑りの動き（transform）が付く
      await expect.poll(() => page.evaluate(() => (window as unknown as { __slides: { id: string | null; transform: boolean }[] }).__slides.filter((r) => r.transform).map((r) => r.id)), { timeout: 5_000 }).toEqual(expect.arrayContaining(["short"]));
      await expect.poll(() => page.locator(".captions__bubble").count(), { timeout: 10_000 }).toBe(3);
      // 動きは CAPTION_SLIDE_MS で終わる。終わった後は、動きが残らず、位置（変形を含まない offsetTop）が動かない
      await expect.poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 5_000 }).toBe(0);
      const tops = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".captions__row")).map((row) => row.offsetTop));
      const before = await tops();
      await page.waitForTimeout(400);
      expect(await tops()).toEqual(before);
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  const captionBubble = (id: string, start: number, text: string) => ({ id, track: "相手", speaker: "相手 A", label: "確定", start, end: start + 1, text, settledLength: text.length });

  it(
    "字幕: 途中の分とカーソルがあっても、同じ行が確定に変わっても、吹き出しの幅・高さ・行の位置は変わらない",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      const text = "これはとても長い文章です。".repeat(8);
      const pending = (settledLength: number) => ({ id: "p", track: "相手", speaker: "相手 A", label: "確定", start: 1, end: 2, text, settledLength });
      await sendFrame(page, { type: "captions", bubbles: [pending(10)] });
      await expect.poll(() => page.locator(".captions__cursor").count(), { timeout: 10_000 }).toBe(1);
      const measure = () => page.evaluate(() => {
        const bubble = document.querySelector<HTMLElement>(".captions__bubble")!;
        const row = document.querySelector<HTMLElement>(".captions__row")!;
        const rect = bubble.getBoundingClientRect();
        return { width: rect.width, height: rect.height, top: row.offsetTop, rowHeight: row.offsetHeight };
      });
      const withCursor = await measure();
      await sendFrame(page, { type: "captions", bubbles: [pending(text.length)] });
      await expect.poll(() => page.locator(".captions__cursor").count(), { timeout: 10_000 }).toBe(0);
      expect(await page.locator(".captions__row").count()).toBe(1);
      expect(await measure()).toEqual(withCursor);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );
  // animate の呼び出しを記録する。滑り（translateY）の動きは、作った時点で途中（半分）に止める
  const recordAnimations = (page: Page) =>
    page.evaluate((halfway) => {
      const records: { id: string | null; kind: "slide" | "fade"; dy: number }[] = [];
      (window as unknown as { __animations: typeof records }).__animations = records;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, keyframes, options) {
        const json = JSON.stringify(keyframes);
        const animation = animate.call(this, keyframes, options);
        const slide = /translateY\((-?[\d.]+)px\)/.exec(json);
        records.push({ id: this.getAttribute("data-caption-id"), kind: slide === null ? "fade" : "slide", dy: slide === null ? 0 : Number(slide[1]) });
        if (slide !== null) {
          animation.pause();
          animation.currentTime = halfway;
        }
        return animation;
      };
    }, CAPTION_SLIDE_MS / 2);
  const recorded = (page: Page) => page.evaluate(() => (window as unknown as { __animations: { id: string | null; kind: "slide" | "fade"; dy: number }[] }).__animations.slice());

  it(
    "字幕: 空の字幕から最初の吹き出しが出るときにも、透明度のフェードが付く",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      await sendFrame(page, { type: "captions", bubbles: [] });
      await expect.poll(() => page.locator(".captions").count(), { timeout: 10_000 }).toBe(0);
      await recordAnimations(page);
      await sendFrame(page, { type: "captions", bubbles: [captionBubble("first", 1, "はじめまして")] });
      await expect.poll(() => page.locator(".captions__bubble").count(), { timeout: 10_000 }).toBe(1);
      await expect.poll(async () => (await recorded(page)).filter((r) => r.kind === "fade").map((r) => r.id), { timeout: 5_000 }).toEqual(["first"]);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "字幕: 滑りのアニメーションの途中に行が増えても、次の移動量は変形を除いた位置（offsetTop）の差だけで決まる。終わった後は動きが残らず位置が止まる",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      const wait = (count: number) => expect.poll(() => page.locator(".captions__bubble").count(), { timeout: 10_000 }).toBe(count);
      const send = (ids: readonly string[]) => sendFrame(page, { type: "captions", bubbles: ids.map((id, i) => captionBubble(id, i + 1, `${id} の発言です。`.repeat(3))) });
      const tops = () =>
        page.evaluate(() => {
          const container = document.querySelector<HTMLElement>(".captions")!;
          return Object.fromEntries(Array.from(container.children).map((row) => [row.getAttribute("data-caption-id"), container.offsetTop + (row as HTMLElement).offsetTop]));
        });
      await send(["a", "b"]);
      await wait(2);
      await page.waitForTimeout(500); // Mount（動きの監視）が張られ、最初のフェードが終わるのを待つ
      await recordAnimations(page);

      await send(["a", "b", "c"]);
      await wait(3);
      await expect.poll(async () => (await recorded(page)).filter((r) => r.kind === "slide").length, { timeout: 5_000 }).toBeGreaterThan(0);
      // 最初の滑りが途中（半分）で止まっている間に、さらに行を足す。止まっている行の見かけの位置は、offsetTop に入らない
      const before = await tops();
      const firstCount = (await recorded(page)).length;
      await send(["a", "b", "c", "d"]);
      await expect.poll(() => page.locator(".captions__bubble").last().textContent(), { timeout: 10_000 }).toContain("d の発言");
      await expect.poll(async () => (await recorded(page)).length, { timeout: 5_000 }).toBeGreaterThan(firstCount);
      const after = await tops();
      const second = (await recorded(page)).slice(firstCount).filter((r) => r.kind === "slide");
      expect(second.length).toBeGreaterThan(0);
      for (const { id, dy } of second) expect(dy, `${id} の移動量`).toBe(before[id!]! - after[id!]!);

      // 途中で止めた動きを終わらせる。終わった後は、動きが残らず、位置が動かない
      await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
      await expect.poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 5_000 }).toBe(0);
      const settledTops = await tops();
      await page.waitForTimeout(400);
      expect(await tops()).toEqual(settledTops);
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "字幕・取り込みの一言・相手の音声の一文・共有画面の一文・ローカルモードの表示",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      await sendFrame(page, { type: "intake", status: "interrupted" });
      await sendFrames(page, [NOTICE_FRAMES.screen, NOTICE_FRAMES.tap]);
      for (const selector of [".intake-notice", ".tap-notice", ".screen-notice", ".captions"]) await page.locator(selector).first().waitFor({ timeout: 10_000 });
      await expect.poll(async () => Math.abs((await rectOf(page, ".captions")).width - CAPTIONS_WIDTH) <= 1, { timeout: 10_000 }).toBe(true);
      const layout = await rectOf(page, ".layout");
      const captions = await rectOf(page, ".captions");
      near(captions.width, CAPTIONS_WIDTH, "字幕の幅");
      near((captions.left + captions.right) / 2, (layout.left + layout.right) / 2, "字幕の中央");
      near(captions.bottom, layout.bottom - 24, "字幕の下端");
      expect(await styleOf(page, ".captions", ["position", "pointer-events", "display", "flex-direction", "gap"])).toEqual({ position: "absolute", "pointer-events": "none", display: "flex", "flex-direction": "column", gap: "4px" });
      // 吹き出しは白の半透明の塗りと細い線の枠を持ち、話し手の側の下の角だけ小さい。影は付けない。名前の欄は小さい文字で、固定幅
      expect(await styleOf(page, ".captions__bubble", ["box-shadow", "background-color", "border-top-width", "border-top-left-radius", "border-bottom-left-radius", "font-size"])).toEqual({
        "box-shadow": "none", "background-color": "rgba(255, 255, 255, 0.92)", "border-top-width": "1px", "border-top-left-radius": "12px", "border-bottom-left-radius": "4px", "font-size": "16px",
      });
      expect(await styleOf(page, ".captions__name", ["font-size"])).toEqual({ "font-size": "12px" });

      const intake = await rectOf(page, ".intake-notice");
      near(intake.left, captions.right + 12, "取り込みの一言の左端");
      near(intake.bottom, layout.bottom - 24, "取り込みの一言の下端");
      expect(await styleOf(page, ".intake-notice", ["position", "pointer-events", "white-space", "font-size", "color", "z-index"])).toEqual({ position: "absolute", "pointer-events": "none", "white-space": "nowrap", "font-size": "13px", color: "rgb(107, 114, 128)", "z-index": "5" });

      const tap = await rectOf(page, ".tap-notice");
      near(tap.right, captions.left - 12, "相手の音声の一文の右端");
      near(tap.width, 260, "相手の音声の一文の幅");
      near(tap.bottom, layout.bottom - 24, "相手の音声の一文の下端");
      expect(await styleOf(page, ".tap-notice", ["position", "pointer-events", "text-align", "background-color", "border-top-width", "box-shadow"])).toEqual({ position: "absolute", "pointer-events": "none", "text-align": "right", "background-color": "rgba(0, 0, 0, 0)", "border-top-width": "0px", "box-shadow": "none" });

      const screen = await rectOf(page, ".screen-notice");
      near(screen.top, layout.top + 12, "共有画面の一文の上端");
      near((screen.left + screen.right) / 2, (layout.left + layout.right) / 2, "共有画面の一文の中央");
      near(screen.width, CAPTIONS_WIDTH, "共有画面の一文の幅");
      expect(await styleOf(page, ".screen-notice", ["position", "pointer-events", "text-align", "box-shadow", "line-height"])).toEqual({ position: "absolute", "pointer-events": "none", "text-align": "center", "box-shadow": "none", "line-height": "19.5px" });

      // ローカルモード: 線は上端 2px の帯、知らせは左上。共有画面の一文は 36px 下へ、幅は layout − 24px（上限 720px）。線の色は server/test/localModeView.heavy.test.ts が running を見る
      await sendFrames(page, [{ type: "session-mode", local: true }, { type: "diff-update", state: { status: "running" } }]);
      await page.locator(".layout--local .local-mode-line").waitFor({ timeout: 10_000 });
      await expect.poll(async () => Math.abs((await rectOf(page, ".local-mode-line")).height - 2) <= 1, { timeout: 10_000 }).toBe(true);
      const line = await rectOf(page, ".local-mode-line");
      near(line.height, 2, "ローカルモードの線の高さ");
      near(line.width, layout.right - layout.left, "ローカルモードの線の幅");
      expect(await styleOf(page, ".local-mode-line", ["position", "pointer-events", "z-index"])).toEqual({ position: "absolute", "pointer-events": "none", "z-index": "6" });
      await expect.poll(async () => Math.abs((await rectOf(page, ".layout--local > .screen-notice")).top - (layout.top + 36)) <= 1, { timeout: 10_000 }).toBe(true);
      const localScreen = await rectOf(page, ".layout--local > .screen-notice");
      near(localScreen.top, layout.top + 36, "ローカルモードの共有画面の一文の上端");
      near(localScreen.width, Math.min(720, layout.right - layout.left - 24), "ローカルモードの共有画面の一文の幅");
      await sendFrame(page, { type: "diff-update", state: { status: "restarting" } });
      await expect.poll(async () => (await styleOf(page, ".local-mode-line", ["background-color"]))["background-color"], { timeout: 10_000 }).toBe("rgb(194, 65, 12)");
      await sendFrame(page, { type: "diff-update", state: { status: "stopped" } });
      await expect.poll(async () => (await styleOf(page, ".local-mode-line", ["background-color"]))["background-color"], { timeout: 10_000 }).toBe("rgb(107, 114, 128)");
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  // Issue #1069: 休止中の一言は取り込みの一言と同じ場所・同じ灰色の文字で字幕の右に出る。取り込みの一言と同時に出るときはその下。字幕・マップは動かさない
  it(
    "自分の休止の一言: 字幕の右（左端は字幕の右 +12px・下端は layout −24px）に取り込みの一言と同じ文字で出て、字幕・マップの位置は動かない。取り込みの一言と同時なら重ならず下に並ぶ",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      await sendFrames(page, [spokenFrame("字幕です。")]);
      await page.locator(".captions").first().waitFor({ timeout: 10_000 });
      await expect.poll(async () => Math.abs((await rectOf(page, ".captions")).width - CAPTIONS_WIDTH) <= 1, { timeout: 10_000 }).toBe(true);
      await settled(page);
      const layout = await rectOf(page, ".layout");
      const captionsBefore = await rectOf(page, ".captions");
      const mapBefore = await rectOf(page, ".map");
      const viewportBefore = await readMeetingViewport(page);

      await sendFrame(page, { type: "self-pause", paused: true, reason: "手動" });
      await page.locator(".self-pause-notice").waitFor({ timeout: 10_000 });
      expect((await page.locator(".self-pause-notice").textContent())?.trim()).toBe("自分を休止中（M で再開）");
      const pause = await rectOf(page, ".self-pause-notice");
      near(pause.left, captionsBefore.right + 12, "休止の一言の左端");
      near(pause.bottom, layout.bottom - 24, "休止の一言の下端");
      expect(await styleOf(page, ".self-pause-notice", ["position", "pointer-events", "white-space", "font-size", "color", "z-index"])).toEqual({ position: "absolute", "pointer-events": "none", "white-space": "normal", "font-size": "13px", color: "rgb(107, 114, 128)", "z-index": "5" });
      // 出ても動かない
      for (const [name, before] of [["字幕", captionsBefore], ["マップ", mapBefore]] as const) {
        const now = await rectOf(page, name === "字幕" ? ".captions" : ".map");
        for (const key of ["left", "top", "right", "bottom"] as const) near(now[key], before[key], `${name}の${key}`);
      }
      expect(await readMeetingViewport(page)).toEqual(viewportBefore);

      // 自動の文言は長く折り返す。全文が .layout の右端の内側に収まり、上端は固定（layout −24px −1 行分）、字幕の右 +12px に置く
      await sendFrame(page, { type: "self-pause", paused: true, reason: "自動" });
      await expect.poll(async () => (await page.locator(".self-pause-notice").textContent())?.trim(), { timeout: 10_000 }).toBe("自分を休止中（会議アプリがマイクを使っていない）");
      const auto = await rectOf(page, ".self-pause-notice");
      expect(auto.right, "自動の文言の右端は layout の右端の内側").toBeLessThanOrEqual(layout.right + 1);
      near(auto.left, captionsBefore.right + 12, "自動の文言の左端");
      near(auto.top, layout.bottom - 43.5, "自動の文言の上端");
      expect(await page.locator(".self-pause-notice").evaluate((el) => el.scrollWidth <= el.clientWidth), "自動の文言は横にあふれない").toBe(true);
      for (const [name, before] of [["字幕", captionsBefore], ["マップ", mapBefore]] as const) {
        const now = await rectOf(page, name === "字幕" ? ".captions" : ".map");
        for (const key of ["left", "top", "right", "bottom"] as const) near(now[key], before[key], `自動の文言のとき、${name}の${key}`);
      }
      await sendFrame(page, { type: "self-pause", paused: true, reason: "手動" });
      await expect.poll(async () => (await page.locator(".self-pause-notice").textContent())?.trim(), { timeout: 10_000 }).toBe("自分を休止中（M で再開）");

      // 取り込みの一言と同時: 取り込みの一言は上、休止の一言はその下で、重ならない。どちらが出入りしても字幕は動かない
      await sendFrame(page, { type: "intake", status: "interrupted" });
      await page.locator(".intake-notice").waitFor({ timeout: 10_000 });
      const intake = await rectOf(page, ".intake-notice");
      const pauseWithIntake = await rectOf(page, ".self-pause-notice");
      expect(intake.bottom, "取り込みの一言の下端は休止の一言の上端より上").toBeLessThanOrEqual(pauseWithIntake.top + 1);
      near(pauseWithIntake.bottom, layout.bottom - 24, "同時に出ているときの休止の一言の下端");
      near(intake.left, captionsBefore.right + 12, "同時に出ているときの取り込みの一言の左端");
      near(pauseWithIntake.left, captionsBefore.right + 12, "同時に出ているときの休止の一言の左端");
      const captionsWith = await rectOf(page, ".captions");
      for (const key of ["left", "top", "right", "bottom"] as const) near(captionsWith[key], captionsBefore[key], `同時に出ているときの字幕の${key}`);

      // 再開で休止の一言だけ消え、取り込みの一言は残る。取り込みの一言が 1 つだけのときは今の位置（下端 layout −24）
      await sendFrame(page, { type: "self-pause", paused: false });
      await expect.poll(async () => page.locator(".self-pause-notice").count(), { timeout: 10_000 }).toBe(0);
      await expect.poll(async () => Math.abs((await rectOf(page, ".intake-notice")).bottom - (layout.bottom - 24)) <= 1, { timeout: 10_000 }).toBe(true);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "畳んだノード・選んだノード・変わったノードの見た目: 選んだ塗り #f3f4f6、畳んだ文字 #6b7280、変わったノードの outline-offset 2px（点滅は終わらせてから読む）",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      expect(await page.locator(".map-node--folded").count()).toBe(1);
      expect(await styleOf(page, ".map-node--folded", ["color"])).toEqual({ color: "rgb(107, 114, 128)" });
      await sendFrames(page, frames.reflected);
      await page.locator(".map-node--blink").first().waitFor({ timeout: 10_000 });
      // クラスが付いた直後は、CI で規則がまだ効いていない値（0px）を読むことがある。点滅が終わって落ち着いた値を待つ
      await page.waitForFunction(() => document.querySelector(".map-node--blink")!.getAnimations().every((a) => a.playState === "finished"), undefined, { timeout: 10_000 });
      await expect.poll(async () => styleOf(page, ".map-node--blink", ["outline-offset"]), { timeout: 10_000 }).toEqual({ "outline-offset": "2px" });
      await page.locator(".map-node__button").first().click();
      await page.waitForFunction(() => document.querySelector(".map-node--selected") !== null, undefined, { timeout: 10_000 });
      expect((await styleOf(page, ".map-node--selected", ["background-color"]))["background-color"]).toBe("rgb(243, 244, 246)");
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  // Issue #1026: 名前の欄を押して名前を入れる。欄は固定幅で、押す前・入力中・名前が付いた後で、欄の幅と吹き出しの位置が動かない（実ブラウザで測る）。
  // pointer-events: none の字幕の中でも、押せる欄と入力だけがクリックを受ける。入力中のキー（M など）は文書のキーとして働かない
  it(
    "名前の欄: 押すと同じ固定幅の欄の中で入力でき、吹き出しの位置が動かない。確定で POST /session/speaker-name を送り、名前が付くと（長い名前でも）欄の幅は同じ。自分の欄は押せない",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      const posted: unknown[] = [];
      const selfPaused: unknown[] = [];
      await page.route("**/session/speaker-name", async (route) => {
        posted.push(JSON.parse(route.request().postData() ?? "null"));
        await route.fulfill({ status: 204 });
      });
      await page.route("**/session/self-pause", async (route) => {
        selfPaused.push(route.request().postData());
        await route.fulfill({ status: 204 });
      });
      await sendFrame(page, { type: "captions", bubbles: [spokenBubble("こんにちは", "相手", 1), spokenBubble("はい", "自分", 2)] });
      await expect.poll(() => page.locator(".captions__bubble").count(), { timeout: 10_000 }).toBe(2);
      await page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
      const geometry = async () => ({ name: await rectOf(page, ".captions__name", 0), bubble: await rectOf(page, ".captions__bubble", 0), mineName: await rectOf(page, ".captions__name", 1), mineBubble: await rectOf(page, ".captions__bubble", 1) });
      const before = await geometry();
      near(before.name.width, 72, "名前の欄の幅");
      // 1px 以内で同じ（欄の幅・高さと、吹き出しの位置・大きさが動かない）
      const expectSame = async (label: string) => {
        const now = await geometry();
        for (const part of ["name", "bubble", "mineName", "mineBubble"] as const) {
          for (const side of ["left", "top", "width", "height"] as const) near(now[part][side], before[part][side], `${label}: ${part}.${side}`);
        }
      };

      // 押せるのは確定した相手のラベルの欄だけ
      expect(await page.locator("button.captions__name").count()).toBe(1);
      expect(await page.locator(".captions__name").nth(1).evaluate((element) => element.tagName)).not.toBe("BUTTON");

      await page.locator("button.captions__name").click();
      const input = page.locator(".captions__name input");
      await input.waitFor({ timeout: 10_000 });
      await expect.poll(() => input.evaluate((element) => document.activeElement === element), { timeout: 5_000 }).toBe(true); // 押したら、そのまま打てる
      await expectSame("入力中");

      // 長い名前を打っても欄は伸びない。M・E のキーは文書のキー（休止・右の列）として働かない
      await page.keyboard.type("MEとても長い名前のひと");
      expect(await input.inputValue()).toBe("MEとても長い名前のひと");
      await expectSame("長い入力");
      expect(selfPaused).toEqual([]);

      // Esc で取り消すと何も送らずに閉じ、元の欄に戻る
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator(".captions__name input").count(), { timeout: 5_000 }).toBe(0);
      expect(posted).toEqual([]);
      await expectSame("取り消した後");

      // もう一度押して確定する
      await page.locator("button.captions__name").click();
      await input.waitFor({ timeout: 10_000 });
      await page.keyboard.type("田中");
      await page.keyboard.press("Enter");
      await expect.poll(() => posted.length, { timeout: 10_000 }).toBe(1);
      expect(posted).toEqual([{ label: "相手 A", name: "田中" }]);
      await expect.poll(() => page.locator(".captions__name input").count(), { timeout: 5_000 }).toBe(0);
      expect(await page.locator(".captions__name").first().textContent()).toBe("相手 A"); // 名前が付いた表示は、サーバーの frame が届いてから

      // 名前が付く。長い名前でも欄は同じ固定幅で、吹き出しは動かない
      await sendFrame(page, { type: "speaker-names", names: [{ label: "相手 A", name: "とても長い名前の田中さん" }] });
      await expect.poll(() => page.locator(".captions__name").first().textContent(), { timeout: 10_000 }).toBe("とても長い名前の田中さん");
      await expectSame("名前が付いた後");
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );
});

// Issue #969: 幅 768px 以下（スマホ・縦向きの iPad）の並べ方。CSS の @media で切り替え、会議中の画面（.meeting）だけに効く。
// 狭い幅では右の列とキーの一覧を隠し、ノードを選んでいる間だけ根拠を画面下のシートとして出す。字幕は左右 12px の余白を除いた幅いっぱい、知らせは字幕の上に 1 行で重ねる。
// 狭い幅で開くと字幕と右の列を隠して始める（Issue #1236 の一部）ので、字幕の並べ方を見るときは C で出してから測る。
// 769px 以上（Mac の幅）の並べ方は変えない
const NARROW_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
] as const;
const MARGIN = 12;

// 狭い幅で開いた直後は字幕を隠している。C で出して、.captions が描かれるまで待つ
const showCaptions = async (page: Page): Promise<void> => {
  await page.keyboard.press("C");
  await page.locator(".captions").waitFor({ timeout: 10_000 });
};

const selectFirstNode = async (page: Page): Promise<void> => {
  // 自動のカメラは今の議題を追うので、狭い幅では先頭のノードが画面の外にあることがある。画面の中にある最初のノードを押す
  const index = await page.evaluate(() =>
    [...document.querySelectorAll(".map-node__button")].findIndex((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
    }),
  );
  expect(index, "画面の中にあるノードがある").toBeGreaterThanOrEqual(0);
  await page.locator(".map-node__button").nth(index).click();
  await page.waitForFunction(() => document.querySelector(".map-node--selected") !== null, undefined, { timeout: 10_000 });
};

describe.each(NARROW_VIEWPORTS)("会議中（Foldkit 版）の狭い幅: $width×$height", (viewport) => {
  it(
    "字幕は画面の下に左右 12px の余白を除いた幅いっぱいで、幅は 0 より大きく画面に収まる。マップは画面全体を覆う",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first, viewport });
      await showCaptions(page);
      await expect.poll(async () => Math.abs((await rectOf(page, ".captions")).width - (viewport.width - 2 * MARGIN)) <= 1, { timeout: 10_000 }).toBe(true);
      const layout = await rectOf(page, ".layout");
      const captions = await rectOf(page, ".captions");
      expect(captions.width).toBeGreaterThan(0);
      expect(captions.left).toBeGreaterThanOrEqual(0);
      expect(captions.right).toBeLessThanOrEqual(viewport.width);
      near(captions.left, MARGIN, "字幕の左の余白");
      near(viewport.width - captions.right, MARGIN, "字幕の右の余白");
      expect(captions.bottom).toBeLessThanOrEqual(layout.bottom);
      expect(captions.top).toBeGreaterThan(layout.top + layout.height / 2);
      // カメラは測った画面の大きさから計算するので、.map が画面全体なら狭い幅でもマップは画面に合う
      const map = await rectOf(page, ".map");
      near(map.left, layout.left, "マップの左端");
      near(map.right, layout.right, "マップの右端");
      near(map.top, layout.top, "マップの上端");
      near(map.bottom, layout.bottom, "マップの下端");
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "右の列（根拠・変わったこと）とキーの一覧は出ない",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first, viewport });
      await settled(page);
      expect(await page.locator(".side").isVisible()).toBe(false);
      expect(await page.locator(".changes").isVisible()).toBe(false);
      await page.keyboard.press("Shift+?");
      await settled(page);
      expect(await page.locator(".key-list__keys").first().isVisible()).toBe(false);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "ノードを選ぶと根拠のシートが画面の下に出る（変わったことは出ない）。閉じるボタンと Esc のどちらでも選びが外れて閉じる",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first, viewport });
      await settled(page);
      expect(await page.locator(".side").isVisible()).toBe(false);
      await selectFirstNode(page);
      await page.locator(".side").waitFor({ state: "visible", timeout: 10_000 });
      const sheet = await rectOf(page, ".side");
      near(sheet.left, 0, "シートの左端");
      near(sheet.right, viewport.width, "シートの右端");
      near(sheet.bottom, viewport.height, "シートの下端");
      expect(sheet.height).toBeLessThanOrEqual(viewport.height / 2 + 1);
      expect(sheet.height).toBeGreaterThan(0);
      expect(await page.locator(".changes").isVisible()).toBe(false);
      expect((await page.locator(".evidence__text").first().textContent())?.length ?? 0).toBeGreaterThan(0);
      // 影は付けない（淡い塗り・枠・角丸だけ）
      expect((await styleOf(page, ".side", ["box-shadow"]))["box-shadow"]).toBe("none");
      // 開いても .map の大きさは変わらない（カメラが動き直さない）
      const layout = await rectOf(page, ".layout");
      const map = await rectOf(page, ".map");
      near(map.width, layout.width, "シートを開いたときのマップの幅");
      near(map.height, layout.height, "シートを開いたときのマップの高さ");

      // 閉じるボタンで選びを外す
      await page.locator(".side__close").click();
      await page.locator(".side").waitFor({ state: "hidden", timeout: 10_000 });
      expect(await page.locator(".map-node--selected").count()).toBe(0);

      // Esc でも外れる
      await selectFirstNode(page);
      await page.locator(".side").waitFor({ state: "visible", timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.locator(".side").waitFor({ state: "hidden", timeout: 10_000 });
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "自分の休止の一言は、字幕・取り込みの一言・共有画面の一言のどれとも重ならず、画面に収まり、1 行で、字幕の位置を動かさない",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first, viewport });
      await sendFrame(page, { type: "intake", status: "interrupted" });
      await sendFrame(page, NOTICE_FRAMES.screen);
      await showCaptions(page);
      for (const selector of [".intake-notice", ".screen-notice", ".captions"]) await page.locator(selector).first().waitFor({ timeout: 10_000 });
      await expect.poll(async () => Math.abs((await rectOf(page, ".captions")).width - (viewport.width - 2 * MARGIN)) <= 1, { timeout: 10_000 }).toBe(true);
      const captionsBefore = await rectOf(page, ".captions");
      await sendFrame(page, { type: "self-pause", paused: true, reason: "手動" });
      await page.locator(".self-pause-notice").waitFor({ timeout: 10_000 });
      const captions = await rectOf(page, ".captions");
      for (const key of ["left", "top", "right", "bottom"] as const) near(captions[key], captionsBefore[key], `字幕の${key}`);
      const pause = await rectOf(page, ".self-pause-notice");
      expect(pause.bottom, "休止の一言の下端は字幕の上端より上").toBeLessThanOrEqual(captions.top + 1);
      expect(pause.left, "休止の一言の左端").toBeGreaterThanOrEqual(0);
      expect(pause.right, "休止の一言の右端").toBeLessThanOrEqual(viewport.width);
      const lineHeight = Number.parseFloat((await styleOf(page, ".self-pause-notice", ["line-height"]))["line-height"]);
      expect(pause.height, "休止の一言の高さ").toBeLessThanOrEqual(lineHeight + 1);
      for (const selector of [".intake-notice", ".screen-notice"]) {
        const other = await rectOf(page, selector);
        const overlap = other.left < pause.right && pause.left < other.right && other.top < pause.bottom && pause.top < other.bottom;
        expect(overlap, `${selector} と重ならない`).toBe(false);
      }
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "E で右の列を隠していても、ノードを選ぶと根拠のシートが出て、閉じるボタンで選びが外れて閉じる",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first, viewport });
      await settled(page);
      // 狭い幅は右の列を隠して始めるので、E で 1 回出してから、もう 1 回で隠す
      await page.keyboard.press("E");
      await page.keyboard.press("E");
      await settled(page);
      expect(await page.locator(".side").isVisible()).toBe(false);
      await selectFirstNode(page);
      await page.locator(".side").waitFor({ state: "visible", timeout: 10_000 });
      const sheet = await rectOf(page, ".side");
      near(sheet.left, 0, "シートの左端");
      near(sheet.right, viewport.width, "シートの右端");
      near(sheet.bottom, viewport.height, "シートの下端");
      expect(sheet.height).toBeLessThanOrEqual(viewport.height / 2 + 1);
      expect(sheet.height).toBeGreaterThan(0);
      expect((await page.locator(".evidence__text").first().textContent())?.length ?? 0).toBeGreaterThan(0);
      await page.locator(".side__close").click();
      await page.locator(".side").waitFor({ state: "hidden", timeout: 10_000 });
      expect(await page.locator(".map-node--selected").count()).toBe(0);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "取り込みの知らせと共有画面の知らせは、字幕の上に 1 行で重なる",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first, viewport });
      await sendFrame(page, { type: "intake", status: "interrupted" });
      await sendFrame(page, NOTICE_FRAMES.screen);
      await showCaptions(page);
      for (const selector of [".intake-notice", ".screen-notice", ".captions"]) await page.locator(selector).first().waitFor({ timeout: 10_000 });
      await expect.poll(async () => Math.abs((await rectOf(page, ".captions")).width - (viewport.width - 2 * MARGIN)) <= 1, { timeout: 10_000 }).toBe(true);
      const captions = await rectOf(page, ".captions");
      for (const selector of [".intake-notice", ".screen-notice"]) {
        const notice = await rectOf(page, selector);
        expect(notice.bottom, `${selector} の下端は字幕の上端より上`).toBeLessThanOrEqual(captions.top + 1);
        expect(notice.left, `${selector} の左端`).toBeGreaterThanOrEqual(0);
        expect(notice.right, `${selector} の右端`).toBeLessThanOrEqual(viewport.width);
        // 1 行分の高さ（折り返さない）
        const lineHeight = Number.parseFloat((await styleOf(page, selector, ["line-height"]))["line-height"]);
        expect(notice.height, `${selector} の高さ`).toBeLessThanOrEqual(lineHeight + 1);
      }
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );
});

describe("会議中（Foldkit 版）の開いたときの字幕と右の列", () => {
  it(
    "390×844 で開くと字幕を隠して始め、C で出せる（右の列は狭い幅の CSS が隠すので、隠して始めることは meeting.story.test.ts が見る）",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first, viewport: NARROW_VIEWPORTS[0] });
      await settled(page);
      expect(await page.locator(".captions").count()).toBe(0);
      await showCaptions(page);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "1280×801 で開くと字幕と右の列が出ていて、開いた後に 390 へ狭めても字幕は隠れない",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      await page.locator(".captions").waitFor({ timeout: 10_000 });
      expect(await page.locator(".side").isVisible()).toBe(true);
      await page.setViewportSize(NARROW_VIEWPORTS[0]);
      await settled(page);
      expect(await page.locator(".captions").count()).toBe(1);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );
});

describe("会議中（Foldkit 版）の広い幅: 769px 以上は今の並べ方のまま", () => {
  it(
    "1280×801（Mac の幅）: 何も選ばなくても右の列が幅 300px で見え、ノードを選んでも右の列のまま。閉じるボタンは出ない。字幕は幅 648px。? でキーの一覧が出る",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      await settled(page);
      await page.locator(".captions").waitFor({ timeout: 10_000 });
      const layout = await rectOf(page, ".layout");
      expect(await page.locator(".side").isVisible()).toBe(true);
      expect(await page.locator(".changes").isVisible()).toBe(true);
      near((await rectOf(page, ".side")).width, 300, "右の列の幅");
      near((await rectOf(page, ".captions")).width, 648, "字幕の幅");
      await selectFirstNode(page);
      await page.locator(".evidence__text").first().waitFor({ timeout: 10_000 });
      const side = await rectOf(page, ".side");
      near(side.width, 300, "ノードを選んだときの右の列の幅");
      near(side.top, layout.top, "ノードを選んだときの右の列の上端");
      near(side.right, layout.right, "ノードを選んだときの右の列の右端");
      expect(await page.locator(".changes").isVisible()).toBe(true);
      expect(await page.locator(".side__close").isVisible()).toBe(false);
      await page.keyboard.press("Shift+?");
      await page.locator(".key-list__keys").first().waitFor({ state: "visible", timeout: 10_000 });
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "1280×801: ノードを選んでから E で右の列を隠すと .side は見えず、.map は .layout と同じ幅。もう一度 E で幅 300px の右の列が戻る",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first });
      await settled(page);
      await selectFirstNode(page);
      await page.locator(".evidence__text").first().waitFor({ timeout: 10_000 });
      await page.keyboard.press("E");
      await settled(page);
      expect(await page.locator(".side").isVisible()).toBe(false);
      expect(await page.locator(".side__close").isVisible()).toBe(false);
      near((await rectOf(page, ".map")).width, (await rectOf(page, ".layout")).width, "マップの幅");
      await page.keyboard.press("E");
      await page.locator(".side").waitFor({ state: "visible", timeout: 10_000 });
      near((await rectOf(page, ".side")).width, 300, "戻した右の列の幅");
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );

  it(
    "769×1024（狭い幅の境界のすぐ上）: 右の列は幅 300px で見え、字幕の幅は今の式 min(720, 100vw − 632) = 137px",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, server, { frames: frames.first, viewport: { width: 769, height: 1024 } });
      await settled(page);
      await page.locator(".captions").waitFor({ timeout: 10_000 });
      expect(await page.locator(".side").isVisible()).toBe(true);
      near((await rectOf(page, ".side")).width, 300, "右の列の幅");
      await expect.poll(async () => Math.abs((await rectOf(page, ".captions")).width - 137) <= 1, { timeout: 10_000 }).toBe(true);
      await page.context().close();
    }),
    MEETING_TIMEOUT,
  );
});
