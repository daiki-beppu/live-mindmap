import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embedReviewAudio, embedReviewLog } from "../../server/src/core/index.ts";
import { buildReviewTemplateHtml } from "../../server/test/fixtures/reviewTemplate.ts";
import { compareScreens, withBrowser, type Browser, type Page, type Side, type Step, type Viewport } from "./screenCompare.ts";

// ビルドした見返し（React 版）を 2 つ headless Chromium で開き、同じ操作を流して、ビューポート・<audio>・スクリーンショットを比べる。
// 時間がかかる。事前に `pnpm --filter @live-mindmap/server deps:install chromium` が要る。
const TIMEOUT = 180_000;

const LOG_PATH = join(import.meta.dirname, "fixtures/screenCompare.log.jsonl");

// テストの中で作る無音の WAV（PCM 16bit・モノラル）。会議の長さ（11 秒）より少し長くする
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// React 版の ViewPort は @xyflow の .react-flow__viewport の style.transform（translate(xpx, ypx) scale(z)）
const readReactViewport = async (page: Page): Promise<Viewport> => {
  const transform = await page.evaluate(() => (document.querySelector(".react-flow__viewport") as HTMLElement | null)?.style.transform ?? null);
  const match = transform === null ? null : /translate\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)\s*scale\((-?[\d.e+-]+)\)/.exec(transform);
  if (match === null) throw new Error(`.react-flow__viewport の transform を読めません: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
};

let dir: string;
let htmlPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "live-mindmap-screen-compare-"));
  const events = (await readFile(LOG_PATH, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const template = await buildReviewTemplateHtml();
  htmlPath = join(dir, "map-audio.html");
  await writeFile(htmlPath, embedReviewAudio(embedReviewLog(template, events), silentWav(13).toString("base64")));
}, TIMEOUT);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// React 版を開く。ノードが出て、<audio> が読み込めるまで待つ（読み込めなければ、照合の前提が崩れている）
const reactSide = (name: string, afterOpen?: (page: Page) => Promise<void>): Side => ({
  name,
  viewport: readReactViewport,
  open: async (browser: Browser) => {
    // 高さ 801: 800 だと、ノードの文字の位置が描画の丸めの境目に載り、ほぼ同じ状態でも 0.05% を超えて揺れる
    const context = await browser.newContext({ viewport: { width: 1280, height: 801 } });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href);
    await page.locator(".map-node").first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const audio = document.querySelector("audio");
      return audio !== null && Number.isFinite(audio.duration) && audio.duration > 0;
    }, undefined, { timeout: 30_000 });
    await afterOpen?.(page);
    return page;
  },
});

const keys = (name: string, sequence: string[], playing = false): Step => ({
  name,
  playing,
  run: async (page) => {
    for (const key of sequence) await page.keyboard.press(key);
  },
});

// .map の中の、ノードの無い所（右下の隅）と、中央
const mapPoint = async (page: Page, where: "center" | "corner") => {
  const box = await page.locator(".map").boundingBox();
  if (box === null) throw new Error(".map の位置を読めません");
  return where === "center" ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: box.x + box.width - 40, y: box.y + box.height - 40 };
};

const wheelWith = (name: string, held: string[], deltaX: number, deltaY: number): Step => ({
  name,
  run: async (page) => {
    const { x, y } = await mapPoint(page, "center");
    await page.mouse.move(x, y);
    for (const key of held) await page.keyboard.down(key);
    await page.mouse.wheel(deltaX, deltaY);
    for (const key of held.toReversed()) await page.keyboard.up(key);
  },
});

const FULL_STEPS: Step[] = [
  {
    name: "畳まれた議題を開く",
    run: async (page) => {
      const dots = page.locator('button[aria-label="開く"]');
      if ((await dots.count()) === 0) throw new Error("「開く」の丸がありません（ログの「済み」の議題が畳まれていない）");
      await dots.first().click();
    },
  },
  {
    name: "開いた議題を畳む",
    run: async (page) => {
      const foldButtons = page.locator('button[aria-label="畳む"]');
      if ((await foldButtons.count()) === 0) throw new Error("「畳む」の丸がありません（開いた議題が開いた状態になっていない）");
      const openDots = page.locator('button[aria-label="開く"]');
      const before = await openDots.count();
      await foldButtons.first().click();
      await page.waitForFunction(
        (expected) => document.querySelectorAll('button[aria-label="開く"]').length === expected,
        before + 1,
        { timeout: 10_000 },
      );
    },
  },
  {
    name: "変わったことの項目を選ぶ",
    run: async (page) => {
      await page.locator(".changes__button").first().click();
    },
  },
  keys("再生（Space）", ["Space"], true),
  keys("止めて先頭へ（Space・Home）", ["Space", "Home"]),
  keys("速さと音量（> > < M M）", [">", ">", "<", "M", "M"]),
  keys("ミュート（M）", ["M"]),
  keys("シーク（L L J End）", ["L", "L", "J", "End"]),
  keys("反映の前後（, . ,）", [",", ".", ","]),
  keys("カメラ（= - 0 F Z）", ["=", "=", "-", "0", "F", "Z"]),
  keys("選択の移動（矢印）", ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]),
  keys("カメラの移動（Shift＋矢印）", ["Shift+ArrowLeft", "Shift+ArrowDown", "Shift+ArrowRight", "Shift+ArrowUp"]),
  keys("列と字幕の出し入れ（E C E C）", ["E", "C", "E", "C"]),
  keys("キーの一覧と Escape（? Escape）", ["?", "Escape"]),
  keys("Enter", ["Enter"]),
  wheelWith("ホイールでパン", [], 40, 90),
  {
    name: "⌘＋クリックで拡大",
    run: async (page) => {
      const { x, y } = await mapPoint(page, "center");
      await page.mouse.move(x, y);
      await page.keyboard.down("Meta");
      await page.mouse.click(x, y);
      await page.keyboard.up("Meta");
    },
  },
  wheelWith("Ctrl＋ホイールでピンチ", ["Control"], 0, -120),
  wheelWith("⌘⇧＋スクロール", ["Meta", "Shift"], 0, 80),
  {
    name: "何も無い所のドラッグ",
    run: async (page) => {
      const { x, y } = await mapPoint(page, "corner");
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 120, y - 60, { steps: 8 });
      await page.mouse.up();
    },
  },
];

describe("見返しの画面の照合", () => {
  it(
    "React 版どうしに同じ操作を流すと、ビューポート・<audio>・スクリーンショット（違うピクセル 0.05% 以下）が全ステップで一致し、操作で値は実際に変わる",
    () => withBrowser(async (browser) => {
      const { initial, steps } = await compareScreens(browser, [reactSide("左"), reactSide("右")], FULL_STEPS);

      // 何も起きなくても通るテストにしない: 操作の前後で、ビューポートも <audio> の値も実際に変わっている
      const viewportAt = (name: string) => steps.find((step) => step.name === name)!.viewports[0];
      expect(initial.audio[0]!.duration).toBeGreaterThan(0);
      expect(viewportAt("ホイールでパン")).not.toEqual(initial.viewports[0]);
      expect(viewportAt("⌘＋クリックで拡大").zoom).toBeGreaterThan(viewportAt("ホイールでパン").zoom);
      expect(viewportAt("Ctrl＋ホイールでピンチ").zoom).toBeGreaterThan(viewportAt("⌘＋クリックで拡大").zoom);
      expect(viewportAt("⌘⇧＋スクロール")).not.toEqual(viewportAt("Ctrl＋ホイールでピンチ"));
      expect(viewportAt("何も無い所のドラッグ")).not.toEqual(viewportAt("⌘⇧＋スクロール"));
      const audioAfter = (name: string) => steps.find((step) => step.name === name)!.audio[0]!;
      expect(steps.find((step) => step.name === "再生（Space）")!.audio[0]!.paused).toBe(false);
      expect(audioAfter("止めて先頭へ（Space・Home）").paused).toBe(true);
      expect(audioAfter("速さと音量（> > < M M）").playbackRate).not.toBe(initial.audio[0]!.playbackRate);
      expect(audioAfter("ミュート（M）").muted).not.toBe(initial.audio[0]!.muted);
      expect(audioAfter("シーク（L L J End）").currentTime).not.toBe(audioAfter("ミュート（M）").currentTime);
      // 撮ったスクリーンショットの比較が、再生中以外の全ステップで行われている
      expect(steps.filter((step) => step.differingPixelPercent === null).map((step) => step.name)).toEqual(["再生（Space）"]);
    }),
    TIMEOUT,
  );

  const SHORT_STEPS: Step[] = [wheelWith("ホイールでパン", [], 40, 90)];

  it(
    "片方のページにだけスタイルを足すと、スクリーンショットの不一致として落ちる（ビューポートは一致のまま）",
    () => withBrowser(async (browser) => {
      const shifted = reactSide("スタイルを足した右", (page) => page.addStyleTag({ content: ".map-node { margin-left: 60px; }" }).then(() => undefined));
      const failure = await compareScreens(browser, [reactSide("左"), shifted], SHORT_STEPS).then(() => null, (error: unknown) => error as Error);
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
        run: async (page, side) => {
          const { x, y } = await mapPoint(page, "center");
          await page.mouse.move(x, y);
          await page.mouse.wheel(40, 90);
          if (side === 1) await page.mouse.wheel(40, 90);
        },
      };
      const failure = await compareScreens(browser, [reactSide("左"), reactSide("右")], [extraWheel]).then(() => null, (error: unknown) => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toContain("[ホイールでパン] ビューポートが違います");
    }),
    TIMEOUT,
  );
});
