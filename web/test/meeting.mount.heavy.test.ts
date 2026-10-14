import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrollPanDelta } from "../src/camera.ts";
import { keyListRows } from "../src/app/keys/table.ts";
import { closeSocket, connectFrames, connectionCount, meetingFrames, NOTICE_FRAMES, openMeetingPage, readMeetingViewport, sendFrame, sendFrames, startMeetingServer, MEETING_TIMEOUT, waitForMeasuredNodes, type MeetingFrames, type MeetingServer } from "./meetingPage.ts";
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
    MEETING_TIMEOUT,
  );
});

// ユーティリティへ移した値は、素の CSS の文面では確かめられない。実ブラウザの computed style と位置で確かめる（Issue #1008: 替える前の CSS との照合は外し、今の値を期待値にする）。
// 字幕と知らせの位置は、窓の幅 1280 で幅 648px、字幕の左右 12px の外に知らせ。値は animation・transition が終わった後に読み（styleOf・rectOf が最後まで進める）、
// 配置が落ち着くのは決め打ちの待ちではなく、値に届くまで待つ
describe("会議中（Foldkit 版）の寸法", () => {
  const CAPTIONS_WIDTH = 648; // min(720px, 100vw − 2 × 316px) の 1280px での値

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
      expect(await styleOf(page, ".captions__block", ["box-shadow", "background-color", "border-top-width", "border-top-color", "border-radius", "padding-top", "padding-left", "font-size", "color"])).toEqual({
        "box-shadow": "none", "background-color": "rgba(255, 255, 255, 0.88)", "border-top-width": "1px", "border-top-color": "rgb(229, 231, 235)", "border-radius": "6px", "padding-top": "6px", "padding-left": "12px", "font-size": "16px", color: "rgb(55, 65, 81)",
      });
      expect(await styleOf(page, ".captions__track", ["color", "font-size"])).toEqual({ color: "rgb(156, 163, 175)", "font-size": "12px" });

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
});
