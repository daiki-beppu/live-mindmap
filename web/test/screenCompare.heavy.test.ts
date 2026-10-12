import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FULL_STEPS, foldkitSide, mapPoint, prepareReviewPages, TIMEOUT, wheelWith, type ReviewPages } from "./reviewPage.ts";
import { compareScreens, withBrowser, type CompareResult, type Page, type Step } from "./screenCompare.ts";

// 画面の照合の道具（screenCompare.ts）の点検と、見返し（Foldkit 版）の操作の列が決まった値を返すことの確認。
// 比べる相手が React 版だったのは、React の見返しを消すまで（Issue #826。結果は実装レポート）。React 版が無い今は、Foldkit 版どうしを比べ、
// 同じ操作が同じ値になること（揺れない）と、道具がスタイルの差・ビューポートの差を見逃さないことを保つ。#827・#829 の照合も同じ道具を使う。
// 時間がかかる。事前に `pnpm --filter @live-mindmap/server deps:install chromium` が要る。

let pages: ReviewPages;
beforeAll(async () => {
  pages = await prepareReviewPages();
}, TIMEOUT);
afterAll(async () => {
  await pages.dispose();
});

const side = (name: string, kind: "audio" | "plain", afterOpen?: (page: Page) => Promise<void>) =>
  foldkitSide(name, { htmlPath: kind === "audio" ? pages.audioPath : pages.plainPath, audio: kind === "audio", afterOpen });

// 何も起きなくても通るテストにしない: 操作の前後で、ビューポートの値が実際に変わっている
const expectOperationsChangeViewport = ({ initial, steps }: CompareResult) => {
  const viewportAt = (name: string) => steps.find((step) => step.name === name)!.viewports[0];
  expect(viewportAt("ホイールでパン")).not.toEqual(initial.viewports[0]);
  expect(viewportAt("⌘＋クリックで拡大").zoom).toBeGreaterThan(viewportAt("ホイールでパン").zoom);
  expect(viewportAt("Ctrl＋ホイールでピンチ").zoom).toBeGreaterThan(viewportAt("⌘＋クリックで拡大").zoom);
  expect(viewportAt("⌘⇧＋スクロール")).not.toEqual(viewportAt("Ctrl＋ホイールでピンチ"));
  expect(viewportAt("何も無い所のドラッグ")).not.toEqual(viewportAt("⌘⇧＋スクロール"));
  // 撮ったスクリーンショットの比較が、再生中以外の全ステップで行われている
  expect(steps.filter((step) => step.differingPixelPercent === null).map((step) => step.name)).toEqual(["再生（Space）"]);
};

describe("見返し（Foldkit 版）の画面の照合", () => {
  it(
    "録音つき（map-audio.html）: 同じ操作を流すと、ビューポート・<audio>・スクリーンショットが全ステップで一致し、操作で値は実際に変わる",
    () => withBrowser(async (browser) => {
      const result = await compareScreens(browser, [side("左", "audio"), side("右", "audio")], FULL_STEPS);
      expectOperationsChangeViewport(result);
      const { initial, steps } = result;
      const audioAfter = (name: string) => steps.find((step) => step.name === name)!.audio[0]!;
      expect(initial.audio[0]!.duration).toBeGreaterThan(0);
      expect(audioAfter("再生（Space）").paused).toBe(false);
      expect(audioAfter("止めて先頭へ（Space・Home）").paused).toBe(true);
      expect(audioAfter("速さと音量（> > < M M）").playbackRate).not.toBe(initial.audio[0]!.playbackRate);
      expect(audioAfter("ミュート（M）").muted).not.toBe(initial.audio[0]!.muted);
      expect(audioAfter("シーク（L L J End）").currentTime).not.toBe(audioAfter("ミュート（M）").currentTime);
    }),
    TIMEOUT,
  );

  it(
    "録音なし（map.html）: 同じ操作を流すと、ビューポートとスクリーンショットが全ステップで一致し、<audio> は無い",
    () => withBrowser(async (browser) => {
      const result = await compareScreens(browser, [side("左", "plain"), side("右", "plain")], FULL_STEPS);
      expectOperationsChangeViewport(result);
      expect(result.initial.audio).toEqual([null, null]);
    }),
    TIMEOUT,
  );
});

describe("照合の道具の自己点検", () => {
  const SHORT_STEPS: Step[] = [wheelWith("ホイールでパン", [], 40, 90)];

  it(
    "片方のページにだけスタイルを足すと、スクリーンショットの不一致として落ちる（ビューポートは一致のまま）",
    () => withBrowser(async (browser) => {
      const shifted = side("スタイルを足した右", "audio", (page) => page.addStyleTag({ content: ".map-node { margin-left: 60px; }" }).then(() => undefined));
      const failure = await compareScreens(browser, [side("左", "audio"), shifted], SHORT_STEPS).then(() => null, (error: unknown) => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toContain("[ホイールでパン] スクリーンショットが違います");
      expect(failure!.message).not.toContain("ビューポートが違います");
    }),
    TIMEOUT,
  );

  it(
    "片方のページにだけホイールを 1 回多く送ると、ビューポートの不一致として落ちる",
    () => withBrowser(async (browser) => {
      const extraWheel: Step = {
        name: "ホイールでパン",
        run: async (page, sideIndex) => {
          const { x, y } = await mapPoint(page, "center");
          await page.mouse.move(x, y);
          await page.mouse.wheel(40, 90);
          if (sideIndex === 1) await page.mouse.wheel(40, 90);
        },
      };
      const failure = await compareScreens(browser, [side("左", "audio"), side("右", "audio")], [extraWheel]).then(() => null, (error: unknown) => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toContain("[ホイールでパン] ビューポートが違います");
    }),
    TIMEOUT,
  );
});
