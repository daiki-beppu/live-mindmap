import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAGE_VIEWPORT, settled, TIMEOUT } from "./reviewPage.ts";
import { launchBrowser, withContext, type Browser, type Page } from "./browser.ts";

// 2 つの mount の heavy IT が共有する settled()（ビューポートが落ち着くまで待つ道具）の振る舞いを、実ブラウザの最小のページで確かめる（Issue #1164）。
// 補間は requestAnimationFrame で進むので、安定は「フレームが続けて同じ値」で見る。壁時計の待ち（50ms 間隔の読み）に戻っていないことを、ページの中で数えたフレーム数で確かめる。
// 時間がかかる。事前に `pnpm --filter @live-mindmap/server deps:install chromium` が要る。

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, TIMEOUT);
afterAll(async () => {
  await browser?.close();
});

type Counted = { __frames: number; __settledFrames: number };

// .map-viewport の transform を、ページ自身の rAF ごとに script で決める。frames は数えたフレーム数
// transformAt(frame) は frame 番目のフレームで入れる transform を返す
const openAnimated = async (page: Page, transformAt: string): Promise<void> => {
  await page.setContent(`<div class="map-viewport" style="transform: translate(0px, 0px) scale(1)"></div>
<script>
  window.__frames = 0;
  // settled の読みのループが発行した rAF の数。ページ自身の tick（下の raf 経由）は数えない。Playwright の通信待ちを計測に含めないため、ページの中で数える
  window.__settledFrames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => { window.__settledFrames += 1; return raf(callback); };
  const target = document.querySelector(".map-viewport");
  const transformAt = ${transformAt};
  const tick = () => {
    window.__frames += 1;
    target.style.transform = transformAt(window.__frames);
    raf(tick);
  };
  raf(tick);
</script>`);
};
const frames = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Counted).__frames);
const settledFrames = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Counted).__settledFrames);
const transform = (page: Page): Promise<string> => page.evaluate(() => (document.querySelector(".map-viewport") as HTMLElement).style.transform);
const at = (x: number) => `translate(${x}px, 0px) scale(1)`;

describe("settled（ビューポートが落ち着くまで待つ）", () => {
  it(
    "動いている間は返らず、止まってから返る。返った時点のビューポートは最終の値",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await context.newPage();
      // 40 フレームの間、毎フレーム動き、その後は止まる
      await openAnimated(page, `(f) => "translate(" + Math.min(f, 40) + "px, 0px) scale(1)"`);
      await settled(page);
      expect(await frames(page)).toBeGreaterThanOrEqual(40);
      expect(await transform(page)).toBe(at(40));
    }),
    TIMEOUT,
  );

  it(
    "1 フレームだけ値が同じになってもまだ動いている間は返らない（続けて同じになるまで待つ）",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await context.newPage();
      // 3 フレームに 1 回だけ前のフレームと同じ値になる。60 フレームまで動き、その後は止まる
      await openAnimated(page, `(f) => { const g = Math.min(f, 60); return "translate(" + (g - Math.floor(g / 3)) + "px, 0px) scale(1)"; }`);
      await settled(page);
      expect(await frames(page)).toBeGreaterThanOrEqual(60);
      expect(await transform(page)).toBe(at(40));
    }),
    TIMEOUT,
  );

  it(
    "止まっているページは、数フレーム（2〜3 フレームの安定に少し余裕）で返る。50ms 間隔で 4 回読む待ち（約 12 フレーム以上）ではない",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await context.newPage();
      await openAnimated(page, `() => "translate(7px, 0px) scale(1)"`);
      await settled(page);
      const elapsed = await settledFrames(page);
      expect(elapsed, "settled の読みのループが回ったフレーム数").toBeLessThanOrEqual(8);
      // 読んだ値が 2 回以上続けて同じと確かめるまでは返らない（1 フレームで返る実装を拒否する）
      expect(elapsed, "settled の読みのループが回ったフレーム数").toBeGreaterThanOrEqual(2);
    }),
    TIMEOUT,
  );

  it(
    "いつまでも動き続けるなら、黙って返らず「ビューポートが落ち着きません」で失敗する",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await context.newPage();
      await openAnimated(page, `(f) => "translate(" + f + "px, 0px) scale(1)"`);
      await expect(settled(page)).rejects.toThrow("ビューポートが落ち着きません");
    }),
    TIMEOUT,
  );

  it(
    ".map-viewport が無い・transform を読めないページでは、落ち着いたことにせず失敗する",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await context.newPage();
      await page.setContent("<div></div>");
      await expect(settled(page)).rejects.toThrow("transform を読めません");
    }),
    TIMEOUT,
  );
});
