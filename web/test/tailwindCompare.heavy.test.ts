import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTURE_SNAPSHOT_GLOBAL } from "../../server/src/core/capture.ts";
import { embedReviewAudio, embedReviewLog } from "../../server/src/core/index.ts";
import { buildReviewTemplateHtml } from "../../server/test/fixtures/reviewTemplate.ts";
import { connectFrames, meetingFrames, NOTICE_FRAMES, openMeetingPage, readMeetingViewport, sendFrame, sendFrames, startMeetingServer, type MeetingFrames, type MeetingServer } from "./meetingPage.ts";
import { FULL_STEPS, LOG_PATH, PAGE_VIEWPORT, foldkitSide, keys, mapPoint, openReviewPage, readFoldkitViewport, silentWav, TIMEOUT } from "./reviewPage.ts";
import { compareScreens, withBrowser, type Browser, type Page, type Side, type Step } from "./screenCompare.ts";

// Issue #830: CSS を Tailwind v4 に替える前後の画面の照合と、置き場に依らない寸法の確認。時間がかかる。
// 事前に `pnpm --filter @live-mindmap/server deps:install chromium` が要る。
//
// 照合: Foldkit 版どうしで、替える前の CSS（fixtures/preTailwind.css。替える前のソースから見返しをビルドした <style> の中身をそのまま保存したもの）と、
// 今の CSS を、同じ DOM に当てて、同じ操作の後のスクリーンショットを比べる（違うピクセルが 0.05% 以下）。「替える前」の CSS は意味のクラス名（.map-node など）で当たるので、
// view の h.Class は意味のクラス名を残したまま、ユーティリティを足す。
// 寸法の確認: ユーティリティへ移した値は、素の CSS の文面では確かめられない。実ブラウザの computed style と位置で、替える前と同じ値になっていることを確かめる。

const PRE_TAILWIND_CSS_PATH = join(import.meta.dirname, "fixtures/preTailwind.css");
const STYLE_TAG = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g;

let preTailwindCss: string;
let afterCss: string;
let dir: string;
let pagePaths: { after: { audio: string; plain: string }; before: { audio: string; plain: string } };
let meetingServer: MeetingServer;
let frames: MeetingFrames;

beforeAll(async () => {
  preTailwindCss = await readFile(PRE_TAILWIND_CSS_PATH, "utf8");
  const template = await buildReviewTemplateHtml();
  const styles = [...template.matchAll(STYLE_TAG)];
  expect(styles, "見返しのテンプレートの <style> は 1 つ（CSS は single-file で 1 つに入る）").toHaveLength(1);
  afterCss = styles[0]![2]!;
  // 替える前: テンプレートの <style> の中身だけを、替える前の CSS に差し替える（関数で渡す: CSS の `$` を置換の記法に読ませない）
  const before = template.replace(STYLE_TAG, (_whole, open: string, _css: string, close: string) => `${open}${preTailwindCss}${close}`);
  dir = await mkdtemp(join(tmpdir(), "live-mindmap-tailwind-compare-"));
  const events = (await readFile(LOG_PATH, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const write = async (name: string, html: string) => {
    const audio = join(dir, `${name}-audio.html`);
    const plain = join(dir, `${name}.html`);
    await writeFile(audio, embedReviewAudio(embedReviewLog(html, events), silentWav(13).toString("base64")));
    await writeFile(plain, embedReviewLog(html, events));
    return { audio, plain };
  };
  pagePaths = { after: await write("after", template), before: await write("before", before) };
  meetingServer = await startMeetingServer();
  frames = await meetingFrames();
}, TIMEOUT);
afterAll(async () => {
  await meetingServer?.close();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe("照合の前提（何も替えていなくても通る比較にしない）", () => {
  it("替える前の CSS は、意味のクラス名で書かれた今の見た目の全体を持つ（点滅・ホバー・見返しの操作の行）", () => {
    for (const selector of ["@keyframes map-node-blink", ".map-node--blink", ".map-node:hover .map-node__fold-dot", ".review-seek", ".review-rate__menu", ".key-list", ".captions"]) {
      expect(preTailwindCss, selector).toContain(selector);
    }
  });

  it("ビルドした見返しの CSS は、Tailwind が生成したもの（替える前の CSS そのものではない）で、自前の token・ユーティリティ・残した点滅を持つ", () => {
    expect(afterCss).not.toBe(preTailwindCss);
    expect(afterCss).toMatch(/--color-yellow-400\s*:\s*#facc15/i);
    expect(afterCss).toMatch(/\.(?:absolute|relative|flex)\s*\{/);
    expect(afterCss).toMatch(/@keyframes map-node-blink/);
  });
});

// ---- 見返し ----
const reviewSide = (name: string, which: "after" | "before", kind: "audio" | "plain"): Side =>
  foldkitSide(name, { htmlPath: pagePaths[which][kind], audio: kind === "audio" });

const settle = (page: Page) => page.waitForTimeout(350); // Floating UI の位置・吹き出し・音量の幅の 0.15s の transition が終わるまで
const hover = (name: string, selector: string, nth = 0): Step => ({
  name,
  run: async (page) => {
    await page.locator(selector).nth(nth).hover();
    await settle(page);
  },
});
const clickOn = (name: string, selector: string): Step => ({
  name,
  run: async (page) => {
    await page.locator(selector).first().click();
    await settle(page);
  },
});
const away: Step = {
  name: "ポインタを離す",
  run: async (page) => {
    const { x, y } = await mapPoint(page, "corner");
    await page.mouse.move(x, y);
    await settle(page);
  },
};

// 操作の列（FULL_STEPS）が通らない、状態を保ったままの見た目: ホバー・開いたメニュー・フォーカスの輪・キー一覧
const REVIEW_STATE_STEPS: Step[] = [
  hover("畳んだノードにホバー（数の丸）", ".map-node--folded"),
  clickOn("畳まれた議題を開く（畳む丸ができる）", 'button[aria-label="開く"]'),
  hover("ノードにホバー（畳む丸が出る）", '.map-node:has(button[aria-label="畳む"])'),
  away,
  hover("シークバーにホバー（つまみと吹き出し）", ".review-seek"),
  away,
  hover("音量のボタンにホバー（スライダーが出る）", ".review-volume .review-bar__button"),
  hover("音量のスライダーにホバー", ".review-volume__slider"),
  away,
  hover("操作のボタンにホバー（吹き出し）", ".review-bar__button", 1),
  away,
  keys("キーの一覧を開く（?）", ["?"]),
  hover("キーの一覧を開いたままノードにホバー", ".map-node"),
  keys("キーの一覧を閉じる（Escape）", ["Escape"]),
  clickOn("速さのメニューを開く", ".review-rate__button"),
  hover("速さのメニューの項目にホバー", ".review-rate__item", 1),
  keys("速さのメニューの項目を矢印で選ぶ", ["ArrowDown", "ArrowDown"]),
  keys("速さのメニューを閉じる（Escape）", ["Escape"]),
  { name: "Tab でフォーカスを送る（フォーカスの輪）", run: async (page) => { for (let i = 0; i < 6; i++) await page.keyboard.press("Tab"); await settle(page); } },
];

// 録音なしの操作の行には音量が無い
const PLAIN_STATE_STEPS = REVIEW_STATE_STEPS.filter((step) => !step.name.includes("音量"));

describe("見返しの照合: 替える前の CSS と今の CSS で、同じ操作の後のスクリーンショットが一致する（違うピクセル 0.05% 以下）", () => {
  it(
    "録音つき（map-audio.html）: 全ステップの操作の列",
    () => withBrowser((browser) => compareScreens(browser, [reviewSide("替える前", "before", "audio"), reviewSide("替えた後", "after", "audio")], FULL_STEPS)),
    TIMEOUT,
  );

  it(
    "録音なし（map.html）: 全ステップの操作の列",
    () => withBrowser((browser) => compareScreens(browser, [reviewSide("替える前", "before", "plain"), reviewSide("替えた後", "after", "plain")], FULL_STEPS)),
    TIMEOUT,
  );

  it(
    "録音つき: ホバー・開いたメニュー・フォーカスの輪・キー一覧の状態（子孫と状態のセレクタの見た目）",
    () => withBrowser(async (browser) => {
      const result = await compareScreens(browser, [reviewSide("替える前", "before", "audio"), reviewSide("替えた後", "after", "audio")], REVIEW_STATE_STEPS);
      // 撮ったスクリーンショットの比較が、全ステップで行われている
      expect(result.steps.filter((step) => step.differingPixelPercent === null)).toEqual([]);
    }),
    TIMEOUT,
  );

  it(
    "録音なし: 同じ状態の列（音量の無い操作の行）",
    () => withBrowser((browser) => compareScreens(browser, [reviewSide("替える前", "before", "plain"), reviewSide("替えた後", "after", "plain")], PLAIN_STATE_STEPS)),
    TIMEOUT,
  );
});

// ---- 会議中・撮影（dev サーバー） ----
// dev サーバーは CSS を <style data-vite-dev-id> として入れる。替える前の側は、それを全部外して、替える前の CSS を当てる
const swapToPreTailwind = async (page: Page): Promise<void> => {
  const removed = await page.evaluate(() => {
    const styles = [...document.querySelectorAll("style[data-vite-dev-id]")];
    for (const style of styles) style.remove();
    return styles.length;
  });
  expect(removed, "dev サーバーが入れた <style data-vite-dev-id>").toBeGreaterThan(0);
  await page.addStyleTag({ content: preTailwindCss });
};

const meetingSide = (name: string, which: "after" | "before"): Side => ({
  name,
  viewport: readMeetingViewport,
  open: async (browser) => {
    const page = await openMeetingPage(browser, meetingServer, { frames: frames.first });
    if (which === "before") await swapToPreTailwind(page);
    return page;
  },
});

// frame は beforeAll で入るので、ステップの実行時に取り出す
const send = (name: string, waitFor: string | null, toSend: () => unknown[]): Step => ({
  name,
  run: async (page) => {
    await sendFrames(page, toSend());
    if (waitFor !== null) await page.locator(waitFor).first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(150);
  },
});

const MEETING_STEPS: Step[] = [
  send("取り込みが途切れた（intake interrupted）", ".intake-notice", () => [{ type: "intake", status: "interrupted" }]),
  send("共有画面と相手の音声の知らせ", ".tap-notice", () => [NOTICE_FRAMES.screen, NOTICE_FRAMES.tap]),
  send("差分更新が止まった（paused）", ".diff-update-notice", () => [{ type: "diff-update", state: { status: "paused", reason: "ChatGPT の利用上限" } }]),
  send("反映（変わったノードの点滅）", null, () => frames.reflected),
  send("ローカルモード（running）", ".local-mode-line", () => [{ type: "session-mode", local: true }, { type: "diff-update", state: { status: "running" } }]),
  send("ローカルモード（restarting）", ".local-mode-notice", () => [{ type: "diff-update", state: { status: "restarting" } }]),
  send("ローカルモード（stopped）", ".local-mode-notice", () => [{ type: "diff-update", state: { status: "stopped" } }]),
  { name: "ノードにホバー（畳む丸・数の丸）", run: async (page) => { await page.locator(".map-node").first().hover(); await page.waitForTimeout(250); } },
  { name: "ノードを選ぶ", run: async (page) => { await page.locator(".map-node__button").first().click(); await page.waitForTimeout(250); } },
  keys("キーの一覧を開く（?）", ["?"]),
];

describe("会議中の照合: 替える前の CSS と今の CSS で、同じ frame を受けた後のスクリーンショットが一致する", () => {
  it(
    "字幕とマップ、知らせ、点滅、ローカルモードの各状態、ホバーと選択、キー一覧",
    () => withBrowser((browser) => compareScreens(browser, [meetingSide("替える前", "before"), meetingSide("替えた後", "after")], MEETING_STEPS)),
    TIMEOUT,
  );
});

describe("撮影の照合: 替える前の CSS と今の CSS で、撮影用の画面のスクリーンショットが一致する", () => {
  const captureSide = (name: string, which: "after" | "before"): Side => ({
    name,
    viewport: readFoldkitViewport,
    open: async (browser) => {
      const snapshot = frames.first.at(-1);
      const context = await browser.newContext({ viewport: PAGE_VIEWPORT });
      const page = await context.newPage();
      await page.addInitScript(({ name, value }) => { (globalThis as Record<string, unknown>)[name] = value; }, { name: CAPTURE_SNAPSHOT_GLOBAL, value: snapshot });
      await page.goto(meetingServer.url);
      await page.locator("[data-capture-ready], [data-capture-overflow]").first().waitFor({ state: "attached", timeout: 30_000 });
      if (which === "before") await swapToPreTailwind(page);
      return page;
    },
  });

  it(
    "スナップショットを渡して開いた直後",
    () => withBrowser((browser) => compareScreens(browser, [captureSide("替える前", "before"), captureSide("替えた後", "after")], [])),
    TIMEOUT,
  );
});

describe("会議の待機画面の照合: スナップショットを受け取る前、ルートの文字サイズが 16px 以外でも余白が替える前と同じ（rem のまま）", () => {
  it(
    "p.waiting の余白・margin・色が、替える前の CSS と一致する（ルートの文字サイズ 20px で余白 40px）",
    () => withBrowser(async (browser) => {
      const read = async (which: "after" | "before") => {
        const context = await browser.newContext({ viewport: PAGE_VIEWPORT });
        const page = await context.newPage();
        await connectFrames(page, []);
        await page.goto(meetingServer.url);
        await page.locator("p.waiting").waitFor({ timeout: 30_000 });
        if (which === "before") await swapToPreTailwind(page);
        await page.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
        const style = await styleOf(page, "p.waiting", ["padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "color"]);
        await context.close();
        return style;
      };
      const before = await read("before");
      const after = await read("after");
      expect(after).toEqual(before);
      expect(after).toEqual({ "padding-top": "40px", "padding-right": "40px", "padding-bottom": "40px", "padding-left": "40px", "margin-top": "0px", color: "rgb(107, 114, 128)" });
    }),
    TIMEOUT,
  );
});

// ---- 寸法の確認（置き場に依らない） ----
const styleOf = <K extends string>(page: Page, selector: string, props: readonly K[], nth = 0): Promise<Record<K, string>> =>
  page.locator(selector).nth(nth).evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
  }, props) as Promise<Record<K, string>>;
const rectOf = (page: Page, selector: string, nth = 0) =>
  page.locator(selector).nth(nth).evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
const near = (actual: number, expected: number, label: string) => expect(Math.abs(actual - expected), `${label}: ${actual} / ${expected}`).toBeLessThanOrEqual(1);

describe("見返しの寸法: ユーティリティへ移した値が、替える前と同じ", () => {
  const open = (browser: Browser) => openReviewPage(browser, pagePaths.after.audio, { audio: true });

  it(
    "レイアウト・操作の行の部品: 重ね方と寸法・色・影なし。つまみは Slider の translateX(-50%) と二重にずれない（margin-left 0）。吹き出しは閉じている間は出ない",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
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
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "速さのメニューを開く: 外側（backdrop）は画面いっぱいの fixed で z-index がある。メニューは濃い灰色で影が無く、位置は Floating UI の left/top（right・bottom は auto）",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await page.locator(".review-rate__button").first().click();
      await page.locator(".review-rate__menu").waitFor({ timeout: 10_000 });
      const backdrop = await styleOf(page, ".review-rate__backdrop", ["position", "z-index"]);
      expect(backdrop.position).toBe("fixed");
      expect(Number(backdrop["z-index"])).toBeGreaterThan(0);
      const box = await rectOf(page, ".review-rate__backdrop");
      near(box.width, PAGE_VIEWPORT.width, "backdrop の幅");
      near(box.height, PAGE_VIEWPORT.height, "backdrop の高さ");
      expect(await styleOf(page, ".review-rate__menu", ["position", "right", "bottom", "background-color", "box-shadow", "min-width", "display"])).toMatchObject({ position: "absolute", "background-color": "rgb(55, 65, 81)", "box-shadow": "none", "min-width": "220px", display: "flex" });
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "吹き出し: ボタンにポインタを乗せると出て、濃い灰色で影が無い。閉じると消える",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await page.locator(".review-bar__button").nth(1).hover();
      await page.waitForFunction(() => [...document.querySelectorAll(".review-tip")].some((tip) => getComputedStyle(tip).display !== "none"), undefined, { timeout: 10_000 });
      const tips = await page.locator(".review-tip").evaluateAll((all) => all.filter((tip) => getComputedStyle(tip).display !== "none").map((tip) => { const s = getComputedStyle(tip); return { background: s.backgroundColor, shadow: s.boxShadow, position: s.position, nowrap: s.whiteSpace }; }));
      expect(tips.length).toBeGreaterThan(0);
      for (const tip of tips) expect(tip).toEqual({ background: "rgb(55, 65, 81)", shadow: "none", position: "absolute", nowrap: "nowrap" });
      const { x, y } = await mapPoint(page, "corner");
      await page.mouse.move(x, y);
      await page.waitForFunction(() => [...document.querySelectorAll(".review-tip")].every((tip) => getComputedStyle(tip).display === "none"), undefined, { timeout: 10_000 });
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "畳んだノードの隠れた数の丸（押せる）と、開いたノードの畳む丸: 寸法・位置・色・ボタンの既定の打ち消し。畳む丸は普段は透明で、ホバーで出る",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
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
      await page.waitForTimeout(250);
      const f = await styleOf(page, fold, ["position", "opacity", "display", "width", "height", "padding-top", "margin-top", "border-top-width", "border-radius", "background-color", "pointer-events", "cursor", "transform", "right"]);
      expect(f).toMatchObject({ position: "absolute", opacity: "0", display: "block", width: "12px", height: "12px", "padding-top": "0px", "margin-top": "0px", "border-top-width": "1px", "border-radius": "50%", "background-color": "rgb(229, 231, 235)", "pointer-events": "all", cursor: "pointer", right: "6px" });
      expect(f.transform).toMatch(/^matrix\(1, 0, 0, 1, 0, -6\)$/);
      await page.locator(".map-node", { has: page.locator(fold) }).first().hover();
      await page.waitForTimeout(250);
      expect((await styleOf(page, fold, ["opacity"])).opacity).toBe("1");
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "キー一覧（?）: 細い枠だけで、影が無く、ポインタを奪わず、白地",
    () => withBrowser(async (browser) => {
      const page = await open(browser);
      await page.keyboard.press("?");
      await page.locator(".key-list").waitFor({ timeout: 10_000 });
      expect(await styleOf(page, ".key-list", ["position", "border-top-width", "border-top-style", "border-top-color", "pointer-events", "box-shadow", "background-color", "padding-top", "padding-left", "font-size", "color", "z-index"])).toEqual({
        position: "absolute", "border-top-width": "1px", "border-top-style": "solid", "border-top-color": "rgb(229, 231, 235)", "pointer-events": "none", "box-shadow": "none",
        "background-color": "rgb(255, 255, 255)", "padding-top": "8px", "padding-left": "12px", "font-size": "13px", color: "rgb(17, 24, 39)", "z-index": "5",
      });
      await page.context().close();
    }),
    TIMEOUT,
  );
});

describe("会議中の寸法: 字幕と知らせの位置は替える前と同じ式（窓の幅 1280 で幅 648px、字幕の左右 12px の外に知らせ）", () => {
  it(
    "字幕・取り込みの一言・相手の音声の一文・共有画面の一文・ローカルモードの表示",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, meetingServer, { frames: frames.first });
      await sendFrame(page, { type: "intake", status: "interrupted" });
      await sendFrames(page, [NOTICE_FRAMES.screen, NOTICE_FRAMES.tap]);
      for (const selector of [".intake-notice", ".tap-notice", ".screen-notice", ".captions"]) await page.locator(selector).first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(250);
      const layout = await rectOf(page, ".layout");
      const captions = await rectOf(page, ".captions");
      const WIDTH = 648; // min(720px, 100vw − 2 × 316px) の 1280px での値
      near(captions.width, WIDTH, "字幕の幅");
      near((captions.left + captions.right) / 2, (layout.left + layout.right) / 2, "字幕の中央");
      near(captions.bottom, layout.bottom - 24, "字幕の下端");
      expect(await styleOf(page, ".captions", ["position", "pointer-events", "display", "flex-direction", "gap"])).toEqual({ position: "absolute", "pointer-events": "none", display: "flex", "flex-direction": "column", gap: "4px" });
      expect(await styleOf(page, ".captions__block", ["box-shadow", "background-color", "border-top-width", "border-top-color", "border-radius", "padding-top", "padding-left", "font-size", "color"])).toEqual({
        "box-shadow": "none", "background-color": "rgba(255, 255, 255, 0.88)", "border-top-width": "1px", "border-top-color": "rgb(229, 231, 235)", "border-radius": "6px", "padding-top": "6px", "padding-left": "12px", "font-size": "16px", color: "rgb(55, 65, 81)",
      });
      expect((await styleOf(page, ".captions__track", ["color", "font-size"]))).toEqual({ color: "rgb(156, 163, 175)", "font-size": "12px" });

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
      near(screen.width, WIDTH, "共有画面の一文の幅");
      expect(await styleOf(page, ".screen-notice", ["position", "pointer-events", "text-align", "box-shadow", "line-height"])).toEqual({ position: "absolute", "pointer-events": "none", "text-align": "center", "box-shadow": "none", "line-height": "19.5px" });

      // ローカルモード: 線は上端 2px の帯、知らせは左上。共有画面の一文は 36px 下へ、幅は layout − 24px（上限 720px）
      await sendFrames(page, [{ type: "session-mode", local: true }, { type: "diff-update", state: { status: "running" } }]);
      await page.locator(".layout--local .local-mode-line").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(250);
      const line = await rectOf(page, ".local-mode-line");
      near(line.height, 2, "ローカルモードの線の高さ");
      near(line.width, layout.right - layout.left, "ローカルモードの線の幅");
      expect(await styleOf(page, ".local-mode-line", ["position", "background-color", "pointer-events", "z-index"])).toEqual({ position: "absolute", "background-color": "rgb(22, 101, 52)", "pointer-events": "none", "z-index": "6" });
      const localScreen = await rectOf(page, ".layout--local > .screen-notice");
      near(localScreen.top, layout.top + 36, "ローカルモードの共有画面の一文の上端");
      near(localScreen.width, Math.min(720, layout.right - layout.left - 24), "ローカルモードの共有画面の一文の幅");
      await sendFrame(page, { type: "diff-update", state: { status: "restarting" } });
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".local-mode-line")!).backgroundColor === "rgb(194, 65, 12)", undefined, { timeout: 10_000 });
      await sendFrame(page, { type: "diff-update", state: { status: "stopped" } });
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".local-mode-line")!).backgroundColor === "rgb(107, 114, 128)", undefined, { timeout: 10_000 });
      await page.context().close();
    }),
    TIMEOUT,
  );

  it(
    "畳んだノード・選んだノード・変わったノードの見た目: 選んだ塗り #f3f4f6、畳んだ文字 #6b7280、変わったノードの outline 1.5px #facc15 を 1 秒周期で 3 回（影なし）",
    () => withBrowser(async (browser) => {
      const page = await openMeetingPage(browser, meetingServer, { frames: frames.first });
      const folded = page.locator(".map-node--folded").first();
      expect(await folded.count()).toBe(1);
      expect(await styleOf(page, ".map-node--folded", ["color"])).toEqual({ color: "rgb(107, 114, 128)" });
      await sendFrames(page, frames.reflected);
      await page.locator(".map-node--blink").first().waitFor({ timeout: 10_000 });
      const blink = await styleOf(page, ".map-node--blink", ["outline-width", "outline-style", "outline-color", "outline-offset", "animation-duration", "animation-iteration-count", "box-shadow"]);
      // outline の太さは描画の画素（この画面の倍率 1）に丸められ、1.5px は 1px で読める（2px なら 2px）
      expect(blink).toEqual({ "outline-width": "1px", "outline-style": "solid", "outline-color": "rgb(250, 204, 21)", "outline-offset": "2px", "animation-duration": "1s", "animation-iteration-count": "3", "box-shadow": "none" });
      await page.locator(".map-node__button").first().click();
      await page.waitForFunction(() => document.querySelector(".map-node--selected") !== null, undefined, { timeout: 10_000 });
      expect((await styleOf(page, ".map-node--selected", ["background-color"]))["background-color"]).toBe("rgb(243, 244, 246)");
      await page.context().close();
    }),
    TIMEOUT,
  );
});
