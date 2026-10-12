import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrollPanDelta } from "../src/camera.ts";
import { join } from "node:path";
import { mapPoint, openReviewPage, prepareReviewPages, readFoldkitViewport, TIMEOUT, type ReviewPages } from "./reviewPage.ts";
import { withBrowser, type Page } from "./screenCompare.ts";

// 見返し（Foldkit 版）の Mount の中身を、実ブラウザの 1 ページで 1 つずつ確かめる（Issue #826）。React 版が無くなった後も残す。
// ResizeObserver（画面の大きさ・ノードの高さ）・wheel・gesture（Safari のピンチ）・<audio> の時刻は、DOM が無い unit では確かめられない（偽の要素では実際の通知が起きない）。
// 時間がかかる。事前に `pnpm --filter @live-mindmap/server deps:install chromium` が要る。

let pages: ReviewPages;
// 点滅の再始動用の例（反映 3・4 で、論点 n2 と今の議題 n3 が続けて変わる）
let blinkPages: ReviewPages;
beforeAll(async () => {
  pages = await prepareReviewPages();
  blinkPages = await prepareReviewPages(join(import.meta.dirname, "fixtures/reviewBlink.log.jsonl"));
}, TIMEOUT);
afterAll(async () => {
  await pages.dispose();
  await blinkPages.dispose();
});

// 補間と測り直しが落ち着くまで待つ（ビューポートが続けて変わらなくなるまで）
async function settled(page: Page): Promise<void> {
  let last = JSON.stringify(await readFoldkitViewport(page));
  let stable = 0;
  const deadline = Date.now() + 8_000;
  while (stable < 4) {
    if (Date.now() > deadline) throw new Error("ビューポートが落ち着きません");
    await page.waitForTimeout(50);
    const now = JSON.stringify(await readFoldkitViewport(page));
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

// .review-bar__time の「経過 / 全体」の経過（h:mm:ss か mm:ss）を秒にする
const shownSeconds = async (page: Page): Promise<number> => {
  const text = (await page.locator(".review-bar__time").textContent()) ?? "";
  const elapsed = text.split("/")[0]!.trim();
  return elapsed.split(":").reduce((total, part) => total * 60 + Number(part), 0);
};
const audioTime = (page: Page): Promise<number> => page.evaluate(() => (document.querySelector("audio") as HTMLAudioElement).currentTime);
const nodeVisibilities = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-node-id]")].map((el) => el.style.visibility));

describe("見返し（Foldkit 版）の入口", () => {
  it(
    "録音つき・録音なしのどちらも Foldkit の画面が出て、React の root も React Flow も無い。録音つきだけ <audio> が 1 つある",
    () => withBrowser(async (browser) => {
      for (const [path, audio] of [[pages.audioPath, true], [pages.plainPath, false]] as const) {
        const page = await openReviewPage(browser, path, { audio });
        expect(await page.locator(".map-viewport").count()).toBe(1);
        expect(await page.locator(".react-flow").count()).toBe(0);
        // React 19 は root の要素に __reactContainer$… を付ける。付いていなければ createRoot をしていない
        expect(await page.evaluate(() => Object.keys(document.getElementById("root")!).filter((key) => key.startsWith("__reactContainer")))).toEqual([]);
        expect(await page.locator("audio").count()).toBe(audio ? 1 : 0);
        expect(await page.locator(".intake-notice").count()).toBe(0);
        await page.context().close();
      }
    }),
    TIMEOUT,
  );
});

describe("見返し（Foldkit 版）の Mount", () => {
  it(
    "ResizeObserver: 画面の大きさを変えるとビューポートが測り直されて変わり、ノードは測った後の見える状態のまま",
    () => withBrowser(async (browser) => {
      const page = await openReviewPage(browser, pages.plainPath, { audio: false });
      await settled(page);
      const before = await readFoldkitViewport(page);
      expect((await nodeVisibilities(page)).length).toBeGreaterThan(0);
      expect(new Set(await nodeVisibilities(page))).toEqual(new Set(["visible"]));
      await page.setViewportSize({ width: 800, height: 520 });
      await page.waitForFunction(
        (previous) => (document.querySelector(".map-viewport") as HTMLElement).style.transform !== previous,
        `translate(${before.x}px, ${before.y}px) scale(${before.zoom})`,
        { timeout: 10_000 },
      );
      await settled(page);
      expect(await readFoldkitViewport(page)).not.toEqual(before);
      expect(new Set(await nodeVisibilities(page))).toEqual(new Set(["visible"]));
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "wheel: 二本指スクロールの量だけ（scrollPanDelta の向きと大きさで）ビューポートが平行移動し、倍率は変わらない",
    () => withBrowser(async (browser) => {
      const page = await openReviewPage(browser, pages.plainPath, { audio: false });
      await settled(page);
      const before = await readFoldkitViewport(page);
      const { x, y } = await mapPoint(page, "center");
      await page.mouse.move(x, y);
      await page.mouse.wheel(40, 90);
      await settled(page);
      const after = await readFoldkitViewport(page);
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
    "gesture: .map-surface に合成した gesturestart・gesturechange（Safari のピンチ）で倍率が変わる。始まりからの累積の倍率で、前回との比だけ掛かる",
    () => withBrowser(async (browser) => {
      const page = await openReviewPage(browser, pages.plainPath, { audio: false });
      await settled(page);
      const before = await readFoldkitViewport(page);
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
      const first = await readFoldkitViewport(page);
      expect(first.zoom).toBeCloseTo(before.zoom * 1.1, 5);
      // 累積の 1.21 は、前回の 1.1 からは 1.1 倍
      await gesture("gesturechange", 1.21);
      await settled(page);
      expect((await readFoldkitViewport(page)).zoom).toBeCloseTo(before.zoom * 1.21, 5);
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "<audio> の時刻: 再生すると audio.currentTime と .review-bar__time が進み、止めると進まず、End で <audio> が会議の終わりに追従する",
    () => withBrowser(async (browser) => {
      const page = await openReviewPage(browser, pages.audioPath, { audio: true });
      await page.keyboard.press("Home");
      await page.waitForFunction(() => (document.querySelector("audio") as HTMLAudioElement).currentTime === 0);
      await page.keyboard.press("Space");
      await page.waitForFunction(() => (document.querySelector("audio") as HTMLAudioElement).currentTime > 0.3, undefined, { timeout: 10_000 });
      const playedAudio = await audioTime(page);
      expect(await page.evaluate(() => (document.querySelector("audio") as HTMLAudioElement).paused)).toBe(false);
      expect(playedAudio).toBeGreaterThan(0.3);
      // 表示の時刻は <audio> の時刻に追従する（1 秒未満は切り捨てで表示される）
      await page.waitForFunction(() => Number(document.querySelector(".review-bar__time")!.textContent!.split("/")[0]!.trim().split(":").reduce((t, p) => t * 60 + Number(p), 0)) >= 1, undefined, { timeout: 10_000 });
      expect(Math.abs((await shownSeconds(page)) - Math.floor(await audioTime(page)))).toBeLessThanOrEqual(1);
      await page.keyboard.press("Space");
      await page.waitForFunction(() => (document.querySelector("audio") as HTMLAudioElement).paused);
      const stoppedAt = await audioTime(page);
      await page.waitForTimeout(500);
      expect(await audioTime(page)).toBe(stoppedAt);
      await page.keyboard.press("End");
      const duration = await page.evaluate(() => Number(document.querySelector(".review-bar__time")!.textContent!.split("/")[1]!.trim().split(":").reduce((t, p) => t * 60 + Number(p), 0)));
      await page.waitForFunction((seconds) => Math.abs((document.querySelector("audio") as HTMLAudioElement).currentTime - seconds) < 0.5, duration, { timeout: 10_000 });
      expect(await shownSeconds(page)).toBe(duration);
      await page.context().close();
    }),
    TIMEOUT,
  );
});

// 反映をまたいで続けて変わるノードの点滅（Issue #826）。同じ key の要素に map-node--blink が付いたままだと CSS アニメーションは再生し直されないので、
// 反映番号が変わったら Command（RestartBlink）が作り直す。アニメーションを有効にしたまま（Playwright の既定）確かめる。
// 例の反映 3・4 では、直接変わるノード n2（論点）と n3（今の議題）が続けて変わる。
// 畳んだノード（shownAs）は、人が畳んだ議題 n1（Enter）の中の n2 が変わる反映 3・4 で、n1 の点滅として確かめる
describe("見返し（Foldkit 版）の点滅の再始動", () => {
  const BLINKING = ".map-node--blink";
  // 点滅の対象のノード id（data-node-id の要素の中の map-node--blink）
  const blinkingIds = (page: Page): Promise<string[]> =>
    page.evaluate((selector) => [...document.querySelectorAll(selector)].map((el) => el.closest("[data-node-id]")!.getAttribute("data-node-id")!).sort(), BLINKING);
  // 点滅の CSS アニメーションが動いているノードの id と、その経過時間（ms）
  const runningBlinks = (page: Page): Promise<Record<string, number>> =>
    page.evaluate((selector) => {
      const running: Record<string, number> = {};
      for (const el of document.querySelectorAll(selector)) {
        const animations = el.getAnimations().filter((a) => (a as CSSAnimation).animationName === "map-node-blink");
        if (animations.length > 0) running[el.closest("[data-node-id]")!.getAttribute("data-node-id")!] = Number(animations[0]!.currentTime);
      }
      return running;
    }, BLINKING);
  // 点滅を最後まで進めて終わらせる（終わると getAnimations() から外れる）
  const finishBlinks = (page: Page): Promise<void> =>
    page.evaluate((selector) => {
      for (const el of document.querySelectorAll(selector)) for (const a of el.getAnimations()) a.finish();
    }, BLINKING);
  // 反映 3（"," で戻る）。反映 3 の点滅が始まり、動いている最中に最後まで進めて終わらせる（終わった点滅は、同じ要素のまま次の反映へ持ち越す）
  const atRoundThree = async (page: Page): Promise<void> => {
    await page.keyboard.press(",");
    await page.waitForFunction((selector) => document.querySelectorAll(selector).length > 0, BLINKING);
    // RestartBlink が反映 3 の点滅を最初から再生し直し終わるのを待ってから終わらせる
    await page.waitForTimeout(500);
    await finishBlinks(page);
    expect(await runningBlinks(page)).toEqual({});
  };

  it(
    "反映 3 の点滅が終わった後に反映 4 へ移ると、直接変わったノード n2・n3 の点滅が最初から再生し直される",
    () => withBrowser(async (browser) => {
      const page = await openReviewPage(browser, blinkPages.plainPath, { audio: false });
      await settled(page);
      await atRoundThree(page);
      expect(await blinkingIds(page)).toEqual(["n2", "n3"]);
      await page.keyboard.press(".");
      const restarted = await page.waitForFunction(
        (selector) => {
          const running: Record<string, number> = {};
          for (const el of document.querySelectorAll(selector)) {
            const animations = el.getAnimations().filter((a) => (a as CSSAnimation).animationName === "map-node-blink");
            if (animations.length > 0) running[el.closest("[data-node-id]")!.getAttribute("data-node-id")!] = Number(animations[0]!.currentTime);
          }
          return Object.keys(running).length === 2 ? running : false;
        },
        BLINKING,
        { timeout: 10_000 },
      );
      const times = (await restarted.jsonValue()) as Record<string, number>;
      expect(Object.keys(times).sort()).toEqual(["n2", "n3"]);
      for (const time of Object.values(times)) expect(time).toBeLessThan(1000);
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "畳んだノード（shownAs）: 人が畳んだ議題 n1 の中の n2 が変わると、畳んだ n1 が点滅し、反映 3 の点滅が終わった後に反映 4 へ移ると同じ要素で最初から再生し直される",
    () => withBrowser(async (browser) => {
      const page = await openReviewPage(browser, blinkPages.plainPath, { audio: false });
      await settled(page);
      await page.keyboard.press(",");
      await page.waitForFunction((selector) => document.querySelectorAll(selector).length > 0, BLINKING);
      // n1 を選び、Enter で畳む（n2 は n1 の下に隠れる）
      await page.locator('[data-node-id="n1"] .map-node').click();
      await page.waitForSelector('[data-node-id="n1"] .map-node--selected');
      // 選択が反映され、キーの Subscription が選択ありで張り直されるのを待つ（直後の Enter は選択なしの設定で流れて開閉にならない）
      await page.waitForTimeout(500);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector('[data-node-id="n2"]') === null);
      // 隠れた n2 の変化は、n2 を隠している n1 の点滅として出る
      await page.waitForFunction((selector) => document.querySelectorAll(selector).length > 0, BLINKING);
      await page.waitForTimeout(500);
      await finishBlinks(page);
      expect(await runningBlinks(page)).toEqual({});
      expect(await blinkingIds(page)).toEqual(["n1", "n3"]);
      const folded = await page.evaluate(() => document.querySelector('[data-node-id="n1"] .map-node')!.classList.contains("map-node--folded"));
      expect(folded).toBe(true);
      // 同じ DOM 要素のまま持ち越されることの目印
      await page.evaluate(() => ((document.querySelector('[data-node-id="n1"] .map-node') as HTMLElement & { __same?: boolean }).__same = true));
      await page.keyboard.press(".");
      const restarted = await page.waitForFunction(
        (selector) => {
          const running: Record<string, number> = {};
          for (const el of document.querySelectorAll(selector)) {
            const animations = el.getAnimations().filter((a) => (a as CSSAnimation).animationName === "map-node-blink");
            if (animations.length > 0) running[el.closest("[data-node-id]")!.getAttribute("data-node-id")!] = Number(animations[0]!.currentTime);
          }
          return Object.keys(running).length === 2 ? running : false;
        },
        BLINKING,
        { timeout: 10_000 },
      );
      const times = (await restarted.jsonValue()) as Record<string, number>;
      expect(Object.keys(times).sort()).toEqual(["n1", "n3"]);
      for (const time of Object.values(times)) expect(time).toBeLessThan(1000);
      expect(await page.evaluate(() => (document.querySelector('[data-node-id="n1"] .map-node') as (HTMLElement & { __same?: boolean }) | null)?.__same)).toBe(true);
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "反映番号が変わらない操作（ズームのキー）では、終わった点滅は再生し直されない",
    () => withBrowser(async (browser) => {
      const page = await openReviewPage(browser, blinkPages.plainPath, { audio: false });
      await settled(page);
      await atRoundThree(page);
      await page.keyboard.press("=");
      await page.keyboard.press("-");
      await settled(page);
      await page.waitForTimeout(300);
      expect(await blinkingIds(page)).toEqual(["n2", "n3"]);
      expect(await runningBlinks(page)).toEqual({});
      await page.context().close();
    }),
    TIMEOUT,
  );
});
