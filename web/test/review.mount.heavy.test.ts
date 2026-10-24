import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { embedReviewLog } from "../../server/src/core/index.ts";
import { buildReviewTemplateHtml } from "../../server/test/fixtures/reviewTemplate.ts";
import { mapPoint, near, openReviewPage, PAGE_VIEWPORT, prepareReviewPages, rectOf, settled, styleOf, TIMEOUT, type ReviewPages } from "./reviewPage.ts";
import { launchBrowser, withContext, type Browser, type BrowserContext, type Page } from "./browser.ts";

// 見返し（Foldkit 版）の Mount の中身を、実ブラウザの 1 ページで 1 つずつ確かめる（Issue #826）。React 版が無くなった後も残す。
// 共有の ResizeObserver・wheel は meeting.mount.heavy.test.ts、合成 gesture は mapSurface.mount.dom.test.ts が見る。ここでは <audio> の時刻と見返しの表示・寸法を確かめる。
// 時間がかかる。事前に `pnpm --filter @live-mindmap/server deps:install chromium` が要る。

let pages: ReviewPages;
// 点滅の再始動用の例（反映 3・4 で、論点 n2 と今の議題 n3 が続けて変わる）
let blinkPages: ReviewPages;
let longReviewPath: string;
// Chromium はファイルで 1 つ。テストは withContext で自分の context を持ち、独立を保つ
let browser: Browser;
beforeAll(async () => {
  // single-file ビルドは 1 回。同じテンプレートから 2 つのログのページを書き出す
  const template = await buildReviewTemplateHtml();
  pages = await prepareReviewPages(template);
  blinkPages = await prepareReviewPages(template, join(import.meta.dirname, "fixtures/reviewBlink.log.jsonl"));
  longReviewPath = join(pages.plainPath, "..", "long-map.html");
  await writeFile(longReviewPath, embedReviewLog(template, [
    { type: "start", at: "2026-10-01T00:00:00.000Z", title: "長い会議" },
    { type: "remark", at: "2026-10-01T00:58:55.000Z", remark: { id: "r1", track: "相手", start: 3532, end: 3535, text: "次回の打ち合わせはオンラインで開きます" } },
    { type: "diff", at: "2026-10-01T00:58:55.000Z", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "次回の打ち合わせの日程と参加方法を決める", evidence: ["r1"] }], dropped: [] },
  ]));
  browser = await launchBrowser();
}, TIMEOUT);
afterAll(async () => {
  await browser?.close();
  await pages.dispose();
  await blinkPages.dispose();
});

// .review-bar__time の「経過 / 全体」の経過（h:mm:ss か mm:ss）を秒にする
const shownSeconds = async (page: Page): Promise<number> => {
  const text = (await page.locator(".review-bar__time").textContent()) ?? "";
  const elapsed = text.split("/")[0]!.trim();
  return elapsed.split(":").reduce((total, part) => total * 60 + Number(part), 0);
};
const audioTime = (page: Page): Promise<number> => page.evaluate(() => (document.querySelector("audio") as HTMLAudioElement).currentTime);

describe("見返し（Foldkit 版）の入口", () => {
  it(
    "録音つき・録音なしのどちらも Foldkit の画面が出て、React の root も React Flow も無い。録音つきだけ <audio> が 1 つある",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      for (const [path, audio] of [[pages.audioPath, true], [pages.plainPath, false]] as const) {
        const page = await openReviewPage(context, path, { audio });
        expect(await page.locator(".map-viewport").count()).toBe(1);
        expect(await page.locator(".react-flow").count()).toBe(0);
        // React 19 は root の要素に __reactContainer$… を付ける。付いていなければ createRoot をしていない
        expect(await page.evaluate(() => Object.keys(document.getElementById("root")!).filter((key) => key.startsWith("__reactContainer")))).toEqual([]);
        expect(await page.locator("audio").count()).toBe(audio ? 1 : 0);
        expect(await page.locator(".intake-notice").count()).toBe(0);
      }
    }),
    TIMEOUT,
  );
});

describe("見返し（Foldkit 版）の Mount", () => {
  it(
    "<audio> の時刻: 再生すると audio.currentTime と .review-bar__time が進み、止めると paused になり、End で <audio> が会議の終わりに追従する",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await openReviewPage(context, pages.audioPath, { audio: true });
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
      await page.keyboard.press("End");
      const duration = await page.evaluate(() => Number(document.querySelector(".review-bar__time")!.textContent!.split("/")[1]!.trim().split(":").reduce((t, p) => t * 60 + Number(p), 0)));
      await page.waitForFunction((seconds) => Math.abs((document.querySelector("audio") as HTMLAudioElement).currentTime - seconds) < 0.5, duration, { timeout: 10_000 });
      await expect.poll(() => shownSeconds(page), { timeout: 10_000 }).toBe(duration);
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
  // 反映 3（"," で戻る）。クラスは反映 4 と共通なので、操作前とは別の Animation の開始を待つ
  const atRoundThree = async (page: Page): Promise<void> => {
    const previous = await page.evaluateHandle(() => document.getAnimations());
    try {
      await page.keyboard.press(",");
      await page.waitForFunction(
        ({ selector, previous }) => {
          const elements = [...document.querySelectorAll(selector)];
          return elements.length === 2 && elements.every((el) => el.getAnimations().some(
            (animation) => animation instanceof CSSAnimation && animation.animationName === "map-node-blink"
              && !previous.includes(animation) && animation.playState === "running"
              && animation.startTime !== null && animation.currentTime !== null,
          ));
        },
        { selector: BLINKING, previous },
        { timeout: 10_000 },
      );
    } finally {
      await previous.dispose();
    }
  };

  it(
    "反映 3 の点滅が終わった後に反映 4 へ移ると、直接変わったノード n2・n3 の点滅が最初から再生し直される",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await openReviewPage(context, blinkPages.plainPath, { audio: false });
      await settled(page);
      await atRoundThree(page);
      await finishBlinks(page);
      expect(await runningBlinks(page)).toEqual({});
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
    }),
    TIMEOUT,
  );

  it(
    "畳んだノード（shownAs）: 人が畳んだ議題 n1 の中の n2 が変わると、畳んだ n1 が点滅し、反映 3 の点滅が終わった後に反映 4 へ移ると同じ要素で最初から再生し直される",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await openReviewPage(context, blinkPages.plainPath, { audio: false });
      await settled(page);
      await atRoundThree(page);
      // n1 を選び、Enter で畳む（n2 は n1 の下に隠れる）
      await page.locator('[data-node-id="n1"] .map-node').click();
      await page.waitForSelector('[data-node-id="n1"] .map-node--selected');
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector('[data-node-id="n2"]') === null);
      // 隠れた n2 の変化は、n2 を隠している n1 の点滅として出る
      await page.waitForFunction(() =>
        document.querySelector('[data-node-id="n1"] .map-node--blink')?.getAnimations().some(
          (animation) => animation instanceof CSSAnimation && animation.animationName === "map-node-blink"
            && animation.playState === "running" && animation.startTime !== null && animation.currentTime !== null,
        ), undefined, { timeout: 10_000 });
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
    }),
    TIMEOUT,
  );

  it(
    "反映番号が変わらない操作（ズームのキー）では、終わった点滅は再生し直されない",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await openReviewPage(context, blinkPages.plainPath, { audio: false });
      await settled(page);
      await atRoundThree(page);
      await finishBlinks(page);
      expect(await runningBlinks(page)).toEqual({});
      await page.keyboard.press("=");
      await page.keyboard.press("-");
      await settled(page);
      expect(await blinkingIds(page)).toEqual(["n2", "n3"]);
      expect(await runningBlinks(page)).toEqual({});
    }),
    TIMEOUT,
  );
});

// ユーティリティへ移した値は、素の CSS の文面では確かめられない。実ブラウザの computed style と位置で確かめる（Issue #1008: 替える前の CSS との照合は外し、今の値を期待値にする）。
// 値は animation・transition が終わった後に読む（styleOf・rectOf が最後まで進める）。操作の後に変わる値は、決め打ちの待ちではなく、値に届くまで待つ
describe("見返し（Foldkit 版）の寸法", () => {
  const open = (context: BrowserContext) => openReviewPage(context, pages.audioPath, { audio: true });

  it(
    "レイアウト・操作の行の部品: 重ね方と寸法・色・影なし。つまみは Slider の translateX(-50%) と二重にずれない（margin-left 0）。吹き出しは閉じている間は出ない",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await open(context);
      expect(await styleOf(page, ".layout", ["position", "display"])).toEqual({ position: "relative", display: "flex" });
      expect((await styleOf(page, ".map", ["position"])).position).toBe("relative");
      const hit = await rectOf(page, ".review-slider-hit");
      expect((await styleOf(page, ".review-slider-hit", ["position"])).position).toBe("absolute");
      const hitParent = await page.locator(".review-slider-hit").first().evaluate((el) => el.parentElement!.getBoundingClientRect().toJSON() as { left: number; top: number; width: number; height: number });
      near(hit.width, hitParent.width, "slider-hit の幅");
      near(hit.height, hitParent.height, "slider-hit の高さ");
      for (const selector of [".review-seek__thumb", ".review-volume__thumb"]) expect((await styleOf(page, selector, ["margin-left"]))["margin-left"], selector).toBe("0px");
      expect(await styleOf(page, ".review-seek__thumb", ["opacity", "width", "height", "border-radius", "background-color", "box-shadow"])).toEqual({ opacity: "0", width: "12px", height: "12px", "border-radius": "50%", "background-color": "rgb(249, 250, 251)", "box-shadow": "none" });
      expect(await styleOf(page, ".review-volume__slider", ["opacity", "width", "overflow"])).toEqual({ opacity: "0", width: "0px", overflow: "hidden" });
      expect(await styleOf(page, ".review-controls", ["background-color", "color", "box-shadow"])).toEqual({ "background-color": "rgb(55, 65, 81)", color: "rgb(249, 250, 251)", "box-shadow": "none" });
      expect((await styleOf(page, ".review-tip", ["display"])).display).toBe("none");
      expect(await styleOf(page, ".review-bar__button", ["width", "height", "border-radius"])).toEqual({ width: "32px", height: "32px", "border-radius": "6px" });
    }),
    TIMEOUT,
  );

  it(
    "速さのメニューを開く: 外側（backdrop）は画面いっぱいの fixed で z-index がある。メニューは濃い灰色で影が無く、位置は Floating UI の left/top",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await open(context);
      await page.locator(".review-rate__button").first().click();
      await page.locator(".review-rate__menu").waitFor({ timeout: 10_000 });
      const backdrop = await styleOf(page, ".review-rate__backdrop", ["position", "z-index"]);
      expect(backdrop.position).toBe("fixed");
      expect(Number(backdrop["z-index"])).toBeGreaterThan(0);
      const box = await rectOf(page, ".review-rate__backdrop");
      near(box.width, PAGE_VIEWPORT.width, "backdrop の幅");
      near(box.height, PAGE_VIEWPORT.height, "backdrop の高さ");
      expect(await styleOf(page, ".review-rate__menu", ["position", "background-color", "box-shadow", "min-width", "display"])).toEqual({ position: "absolute", "background-color": "rgb(55, 65, 81)", "box-shadow": "none", "min-width": "220px", display: "flex" });
    }),
    TIMEOUT,
  );

  it(
    "吹き出し: ボタンにポインタを乗せると出て、濃い灰色で影が無い。離すと消える",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await open(context);
      await page.locator(".review-bar__button").nth(1).hover();
      await page.waitForFunction(() => [...document.querySelectorAll(".review-tip")].some((tip) => getComputedStyle(tip).display !== "none"), undefined, { timeout: 10_000 });
      const tips = await page.locator(".review-tip").evaluateAll((all) => all.filter((tip) => getComputedStyle(tip).display !== "none").map((tip) => { const s = getComputedStyle(tip); return { background: s.backgroundColor, shadow: s.boxShadow, position: s.position, nowrap: s.whiteSpace }; }));
      expect(tips.length).toBeGreaterThan(0);
      for (const tip of tips) expect(tip).toEqual({ background: "rgb(55, 65, 81)", shadow: "none", position: "absolute", nowrap: "nowrap" });
      const { x, y } = await mapPoint(page, "corner");
      await page.mouse.move(x, y);
      await page.waitForFunction(() => [...document.querySelectorAll(".review-tip")].every((tip) => getComputedStyle(tip).display === "none"), undefined, { timeout: 10_000 });
    }),
    TIMEOUT,
  );

  it(
    "畳んだノードの隠れた数の丸（押せる）と、開いたノードの畳む丸: 寸法・位置・色・ボタンの既定の打ち消し。畳む丸は普段は透明",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await open(context);
      const count = 'button[aria-label="開く"]';
      const parentFont = await page.locator(count).first().evaluate((el) => getComputedStyle(el.closest(".map-node__button") ?? el.parentElement!).fontFamily);
      const c = await styleOf(page, count, ["position", "border-top-width", "margin-top", "margin-left", "font-family", "min-width", "height", "padding-left", "padding-right", "padding-top", "background-color", "color", "font-size", "line-height", "text-align", "pointer-events", "cursor", "border-radius", "box-sizing"]);
      expect(c).toMatchObject({
        position: "absolute", "border-top-width": "0px", "margin-top": "0px", "margin-left": "0px", "min-width": "18px", height: "18px",
        "padding-left": "4px", "padding-right": "4px", "padding-top": "0px", "background-color": "rgb(229, 231, 235)", color: "rgb(75, 85, 99)",
        "font-size": "11px", "line-height": "18px", "text-align": "center", "pointer-events": "all", cursor: "pointer", "border-radius": "9px", "box-sizing": "border-box",
      });
      expect(c["font-family"]).toBe(parentFont);
      const node = await page.locator(".map-node", { has: page.locator(count) }).first().evaluate((el) => el.getBoundingClientRect().toJSON() as { right: number; top: number; height: number });
      const dot = await rectOf(page, count);
      near(node.right - dot.right, 6 + 1.5, "数の丸の右端");
      near(dot.top + dot.height / 2, node.top + node.height / 2, "数の丸の縦の中心");

      await page.locator(count).first().click();
      const fold = 'button[aria-label="畳む"]';
      await page.locator(fold).first().waitFor({ timeout: 10_000 });
      const { x, y } = await mapPoint(page, "corner");
      await page.mouse.move(x, y);
      // ポインタが離れて透明に戻るのを、値に届くまで待つ（決め打ちの待ちにしない）
      await expect
        .poll(() => styleOf(page, fold, ["position", "opacity", "display", "width", "height", "padding-top", "margin-top", "border-top-width", "border-radius", "background-color", "pointer-events", "cursor", "transform", "right"]), { timeout: 10_000 })
        .toMatchObject({
          position: "absolute", opacity: "0", display: "block", width: "12px", height: "12px", "padding-top": "0px", "margin-top": "0px", "border-top-width": "1px", "border-radius": "50%",
          "background-color": "rgb(229, 231, 235)", "pointer-events": "all", cursor: "pointer", right: "6px", transform: "matrix(1, 0, 0, 1, 0, -6)",
        });
    }),
    TIMEOUT,
  );

  it(
    "キー一覧（?）: 細い枠だけで、影が無く、ポインタを奪わず、白地",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await open(context);
      await page.keyboard.press("?");
      await page.locator(".key-list").waitFor({ timeout: 10_000 });
      expect(await styleOf(page, ".key-list", ["position", "border-top-width", "border-top-style", "border-top-color", "pointer-events", "box-shadow", "background-color", "padding-top", "padding-left", "font-size", "color", "z-index"])).toEqual({
        position: "absolute", "border-top-width": "1px", "border-top-style": "solid", "border-top-color": "rgb(229, 231, 235)", "pointer-events": "none", "box-shadow": "none",
        "background-color": "rgb(255, 255, 255)", "padding-top": "8px", "padding-left": "12px", "font-size": "13px", color: "rgb(17, 24, 39)", "z-index": "5",
      });
    }),
    TIMEOUT,
  );
});

// 速さのメニューとツールチップの位置（Issue #1225・#1226）: パネルのクラスが位置（bottom・right）を持つと、anchor が書く left・top と上下・左右で重なり、
// メニューが画面幅に広がって外へはみ出したり、高さが潰れたりする。外側（backdrop）だけが見えて、どのボタンも押せなくなる。位置は anchor だけで決まることを、PC とスマホの幅で確かめる。
// 項目を選んだ後の速さの表示と、閉じた後に字幕・右の列のボタンが効くことは、E2E の見返しの流れ（e2e/tests/review/review.e2e.ts）が見る
describe("見返し（Foldkit 版）の速さのメニューとツールチップの位置", () => {
  type Box = Awaited<ReturnType<typeof rectOf>>;
  const inside = (box: Box, viewport: { width: number; height: number }, label: string) => {
    expect(box.left, `${label} の左端`).toBeGreaterThanOrEqual(0);
    expect(box.top, `${label} の上端`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${label} の右端`).toBeLessThanOrEqual(viewport.width);
    expect(box.bottom, `${label} の下端`).toBeLessThanOrEqual(viewport.height);
  };
  // ツールチップを出す相手と向き（controls.ts の placement）。音声なしの見返しにはミュートが無い
  const tipped = [
    { label: "反映 1 つ戻る", align: "start" },
    { label: "再生", align: "start" },
    { label: "反映 1 つ進む", align: "start" },
    { label: "ミュート", align: "start" },
    { label: "字幕", align: "end" },
    { label: "右の列", align: "end" },
  ] as const;
  const shownTip = '.review-tip[data-open]';
  const settledRects = async (page: Page, tipSelector: string, triggerSelector: string): Promise<{ tip: Box; button: Box }> => {
    const read = async () => ({ tip: await rectOf(page, tipSelector), button: await rectOf(page, triggerSelector) });
    let last = await read();
    const deadline = Date.now() + 5_000;
    for (let stable = 0; stable < 3; ) {
      if (Date.now() > deadline) throw new Error(`${triggerSelector} と吹き出しの位置が落ち着きません`);
      await page.waitForTimeout(50);
      const now = await read();
      stable = JSON.stringify(now) === JSON.stringify(last) ? stable + 1 : 0;
      last = now;
    }
    return last;
  };

  for (const viewport of [PAGE_VIEWPORT, { width: 390, height: 844 }]) {
    it(
      `${viewport.width}×${viewport.height}: 速さのメニューはボタンの上に右端を揃えて出て、項目が全部見え、各項目の点で一番上に来る`,
      () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
        const page = await openReviewPage(context, pages.audioPath, { audio: true });
        await page.setViewportSize(viewport);
        await page.locator(".review-rate__button").first().click();
        // anchor の位置が付く（visibility が外れる）まで待つ
        await page.waitForFunction(() => { const menu = document.querySelector(".review-rate__menu"); return menu !== null && getComputedStyle(menu).visibility === "visible"; }, undefined, { timeout: 10_000 });
        const menu = await rectOf(page, ".review-rate__menu");
        const button = await rectOf(page, ".review-rate__button");
        inside(menu, viewport, "メニュー");
        expect(menu.width, "最小幅").toBeGreaterThanOrEqual(220);
        expect(menu.bottom, "メニューはボタンの上").toBeLessThanOrEqual(button.top + 1);
        near(menu.right, button.right, "メニューの右端はボタンの右端");
        const items = await page.locator(".review-rate__item").evaluateAll((all) => all.map((el) => el.getBoundingClientRect().height));
        // 項目の数 × 1 項目の高さ ＋ 上下の余白（p-[4px]）
        near(menu.height, items.reduce((sum, height) => sum + height, 0) + 8, "メニューの高さ");
        const hits = await page.locator(".review-rate__item").evaluateAll((all) =>
          all.map((el) => {
            const r = el.getBoundingClientRect();
            return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".review-rate__item") === el;
          }),
        );
        expect(hits, "各項目の中心で一番上に来るのは、外側（backdrop）でなくその項目").toEqual(items.map(() => true));
      }),
      TIMEOUT,
    );

    it(
      `${viewport.width}×${viewport.height}: ボタンのツールチップはボタンの上に指定の向きで出て、文字が 1 行すべて見える`,
      () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
        const page = await openReviewPage(context, pages.audioPath, { audio: true });
        await page.setViewportSize(viewport);
        const targets = [...tipped.map(({ label, align }) => ({ label, align, trigger: `button[aria-label="${label}"]` })), { label: "速さ", align: "end" as const, trigger: ".review-rate__button" }];
        for (const { label, align, trigger } of targets) {
          await page.locator(trigger).first().hover();
          await page.waitForFunction((selector) => { const tip = document.querySelector(selector); return tip !== null && getComputedStyle(tip).visibility === "visible"; }, shownTip, { timeout: 10_000 });
          // ミュートにポインタを乗せると音量のスライダーが transition で広がり、帯の中のボタンが動く。ボタンと吹き出しの位置が止まってから測る
          const { tip, button } = await settledRects(page, shownTip, trigger);
          const clipped = await page.locator(shownTip).evaluate((el) => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth);
          // 1 行（leading-[16px]）＋ 上下の余白（py-[4px]）
          near(tip.height, 24, `${label} のツールチップの高さ`);
          expect(clipped, `${label} のツールチップの文字が見切れない`).toBe(false);
          inside(tip, viewport, `${label} のツールチップ`);
          expect(tip.bottom, `${label} のツールチップはボタンの上`).toBeLessThanOrEqual(button.top + 1);
          if (align === "start") near(tip.left, button.left, `${label} のツールチップの左端はボタンの左端`);
          else near(tip.right, button.right, `${label} のツールチップの右端はボタンの右端`);
          const { x, y } = await mapPoint(page, "corner");
          await page.mouse.move(x, y);
          await page.locator(shownTip).waitFor({ state: "detached", timeout: 10_000 });
        }
      }),
      TIMEOUT,
    );
  }
});

// 狭い幅で開いたときの最初の状態（Issue #1236 の一部）: 幅 768px 以下（styles.css の狭い幅の境目）で開くと、右の列と字幕を隠して始める。
// ボタンで今までどおり出せる。広い幅では今までどおり両方出ている。開いた後に幅を変えても、隠す・出すは変えない（人の操作を上書きしない）
describe("見返し（Foldkit 版）の開いたときの右の列と字幕", () => {
  const pressed = (page: Page, label: string) => page.locator(`button[aria-label="${label}"]`).first().getAttribute("aria-pressed");
  const shown = async (page: Page) => ({ side: await page.locator(".side").count(), captions: await page.locator(".captions").count(), sideButton: await pressed(page, "右の列"), captionsButton: await pressed(page, "字幕") });
  const HIDDEN = { side: 0, captions: 0, sideButton: "false", captionsButton: "false" };
  const SHOWN = { side: 1, captions: 1, sideButton: "true", captionsButton: "true" };

  it(
    "390×844 ではマップが全幅で、右の列を開くと下のシートで根拠と変わったことが読める",
    () => withContext(browser, { viewport: { width: 390, height: 844 } }, async (context) => {
      const page = await openReviewPage(context, pages.plainPath, { audio: false });
      expect(await shown(page)).toEqual(HIDDEN);
      near((await rectOf(page, ".map")).width, 390, "閉じたときのマップ幅");
      await page.locator('button[aria-label="字幕"]').first().click();
      await settled(page);
      await page.locator('[data-node-id="n4"] .map-node').click();
      await page.locator('button[aria-label="右の列"]').first().click();
      await expect.poll(() => shown(page), { timeout: 10_000 }).toEqual(SHOWN);
      const layout = await rectOf(page, ".layout");
      const sheet = await rectOf(page, ".side");
      expect.soft((await rectOf(page, ".map")).width, "開いたときのマップ幅").toBe(390);
      expect.soft(sheet.left, "シートの左端").toBe(0);
      expect.soft(sheet.right, "シートの右端").toBe(390);
      expect.soft(Math.abs(sheet.bottom - layout.bottom), "シートは操作帯の上に出る").toBeLessThanOrEqual(1);
      expect(sheet.height).toBeGreaterThan(0);
      expect.soft(sheet.height).toBeLessThan(layout.height);
      const evidence = page.locator(".evidence__remark-text").filter({ hasText: "次に日程の話をします" });
      await evidence.scrollIntoViewIfNeeded();
      expect(await evidence.innerText()).toBe("次に日程の話をします");
      const evidenceBox = await evidence.boundingBox();
      expect(evidenceBox).not.toBeNull();
      expect(evidenceBox!.y).toBeGreaterThanOrEqual(sheet.top);
      expect(evidenceBox!.y + evidenceBox!.height).toBeLessThanOrEqual(sheet.bottom + 1);
      const change = page.getByRole("button", { name: "00:11 追加 要点 オンラインで開く", exact: true });
      await change.scrollIntoViewIfNeeded();
      expect(await change.isVisible()).toBe(true);
      const changeBox = await change.boundingBox();
      expect(changeBox).not.toBeNull();
      expect(changeBox!.y).toBeGreaterThanOrEqual(sheet.top);
      expect(changeBox!.y + changeBox!.height).toBeLessThanOrEqual(sheet.bottom + 1);
      await page.getByRole("button", { name: "右の列", exact: true }).click();
      await expect.poll(() => pressed(page, "右の列")).toBe("false");
      expect(await page.locator(".side").isVisible()).toBe(false);
      near((await rectOf(page, ".map")).width, 390, "閉じ直したマップ幅");
    }),
    TIMEOUT,
  );

  it(
    "1280×800 で開くと、右の列と字幕は今までどおり出ている。開いた後に 390 へ狭めても隠れない",
    () => withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
      const page = await openReviewPage(context, pages.audioPath, { audio: true });
      expect(await shown(page)).toEqual(SHOWN);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      expect(await shown(page)).toEqual(SHOWN);
    }),
    TIMEOUT,
  );
});


describe("見返し（Foldkit 版）のスマホ表示", () => {
  it(
    "390×844 の字幕は左右の余白内に広がり、本文が横に並び、操作帯には重ならない",
    () => withContext(browser, { viewport: { width: 390, height: 844 } }, async (context) => {
      const page = await openReviewPage(context, longReviewPath, { audio: false });
      await page.getByRole("button", { name: "字幕", exact: true }).click();
      await page.locator(".captions__bubble").waitFor();
      const captions = await rectOf(page, ".captions");
      const bubble = await rectOf(page, ".captions__bubble");
      expect.soft(Math.abs(captions.left - 12), "字幕の左余白").toBeLessThanOrEqual(1);
      expect.soft(Math.abs(captions.right - 378), "字幕の右余白").toBeLessThanOrEqual(1);
      expect.soft(Math.abs(bubble.width - captions.width), "吹き出しは字幕領域の幅を使う").toBeLessThanOrEqual(1);
      expect.soft(bubble.left).toBeGreaterThanOrEqual(captions.left - 1);
      expect.soft(bubble.right).toBeLessThanOrEqual(captions.right + 1);
      const text = await page.locator(".captions__bubble").evaluate((element) => {
        const node = element.firstChild!;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 2);
        return { content: element.textContent, lines: range.getClientRects().length, width: range.getBoundingClientRect().width };
      });
      expect(text.content).toBe("次回の打ち合わせはオンラインで開きます");
      expect.soft(text.lines, "最初の2文字は同じ行に並ぶ").toBe(1);
      expect.soft(text.width).toBeGreaterThan(16);
      expect(captions.bottom).toBeLessThanOrEqual((await rectOf(page, ".review-controls")).top);
      for (const name of await page.locator(".captions__name").all()) {
        const box = await name.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      }
    }),
    TIMEOUT,
  );

  for (const audio of [false, true]) {
    it(
      `390×844・録音${audio ? "つき" : "なし"}: 現在時刻だけを1行に出し、主操作は32pxで帯の中に収まる`,
      () => withContext(browser, { viewport: { width: 390, height: 844 } }, async (context) => {
        const page = await openReviewPage(context, audio ? pages.audioPath : longReviewPath, { audio });
        const checkBar = async () => {
          const time = await page.locator(".review-bar__time").innerText();
          expect.soft(time.trim(), "現在時刻だけを表示").toBe(audio ? "0:00:11" : "0:58:55");
          const timeBox = await rectOf(page, ".review-bar__time");
          const textLayout = await page.locator(".review-bar__time").evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            const rects: DOMRect[] = [];
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              for (let offset = 0; offset < node.textContent!.length; offset++) {
                if (node.textContent![offset]!.trim() === "") continue;
                const range = document.createRange();
                range.setStart(node, offset);
                range.setEnd(node, offset + 1);
                rects.push(...[...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
              }
            }
            return {
              lines: new Set(rects.map((r) => Math.round(r.top))).size,
              clipped: rects.some((r) => r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1),
            };
          });
          expect.soft(textLayout.lines, "時刻は1行").toBe(1);
          expect.soft(textLayout.clipped, "時刻を切り詰めない").toBe(false);
          const bar = await rectOf(page, ".review-bar");
          near(bar.left, 0, "操作帯の左端");
          near(bar.right, 390, "操作帯の右端");
          const labels = ["反映 1 つ戻る", "再生", "反映 1 つ進む", "字幕", "再生の速さ", "右の列", ...(audio ? ["ミュート"] : [])];
          const play = await page.getByRole("button", { name: "再生", exact: true }).boundingBox();
          for (const label of labels) {
            const box = await page.getByRole("button", { name: label, exact: true }).boundingBox();
            expect(box, label).not.toBeNull();
            if (["反映 1 つ戻る", "再生", "反映 1 つ進む"].includes(label)) expect.soft(box!.width, `${label}の幅`).toBe(32);
            expect.soft(box!.x, `${label}の左端`).toBeGreaterThanOrEqual(0);
            expect.soft(box!.x + box!.width, `${label}の右端`).toBeLessThanOrEqual(390);
            expect.soft(Math.abs(box!.y - play!.y), `${label}は同じ行`).toBeLessThanOrEqual(1);
          }
          expect.soft(timeBox.top).toBeGreaterThanOrEqual(bar.top);
          expect.soft(timeBox.bottom).toBeLessThanOrEqual(bar.bottom);
          expect.soft(timeBox.left).toBeGreaterThanOrEqual(play!.x + play!.width);
          expect.soft(timeBox.right).toBeLessThanOrEqual(390);
          expect.soft(await page.locator(".review-bar").evaluate((element) => element.scrollWidth <= element.clientWidth), "帯の横スクロールを要しない").toBe(true);
        };
        await checkBar();
        if (audio) {
          await page.getByRole("button", { name: "右の列", exact: true }).click();
          await page.getByRole("button", { name: "ミュート", exact: true }).hover();
          await expect.poll(async () => (await rectOf(page, ".review-volume__slider")).width).toBeGreaterThan(0);
          await checkBar();
          const slider = await rectOf(page, ".review-volume__slider");
          await page.mouse.click(slider.left + slider.width / 2, slider.top + slider.height / 2);
          await expect.poll(() => page.getByRole("slider", { name: "音量", exact: true }).getAttribute("aria-valuenow")).toBe("0.5");
        }
      }),
      TIMEOUT,
    );
  }

  for (const width of [600, 1280]) {
    it(
      `${width}px の見返しでは右の列は300pxで横に並び、現在時刻と全長を表示する`,
      () => withContext(browser, { viewport: { width, height: 844 } }, async (context) => {
        const page = await openReviewPage(context, longReviewPath, { audio: false });
        if (width === 600) await page.getByRole("button", { name: "右の列", exact: true }).click();
        const layout = await rectOf(page, ".layout");
        const side = await rectOf(page, ".side");
        const map = await rectOf(page, ".map");
        near(side.width, 300, "右の列の幅");
        near(side.top, layout.top, "右の列の上端");
        near(side.bottom, layout.bottom, "右の列の下端");
        near(map.right, side.left, "マップの隣に右の列が並ぶ");
        expect((await page.locator(".review-bar__time").innerText()).replace(/\s+/g, " ").trim()).toBe("0:58:55 / 0:58:55");
        if (width === 1280) {
          near((await rectOf(page, ".captions")).width, 648, "従来の字幕幅");
          const bubble = await rectOf(page, ".captions__bubble");
          near(bubble.width, 0.8 * (648 - 72 - 8), "従来の吹き出し幅");
          expect(await page.locator(".review-bar__topic").innerText()).toBe("次回の打ち合わせの日程と参加方法を決める");
          expect(await page.locator(".review-bar__topic").isVisible()).toBe(true);
        }
      }),
      TIMEOUT,
    );
  }
});
