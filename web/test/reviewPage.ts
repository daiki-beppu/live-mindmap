import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { embedReviewAudio, embedReviewLog } from "../../server/src/core/index.ts";
import { buildReviewTemplateHtml } from "../../server/test/fixtures/reviewTemplate.ts";
import type { Viewport } from "../src/camera.ts";
import type { Browser, Page, Side, Step } from "./screenCompare.ts";

// 見返し（map.html・map-audio.html）の heavy IT が共有する道具（Issue #826）。テストではなく、
// テストの中で作る WAV・ビルドしたテンプレートへのログと音声の埋め込み・ページの開き方・ビューポートの読み方・照合の操作の列だけを置く。
// 音声のファイルはリポジトリに足さない（WAV は silentWav が作る）。

export const LOG_PATH = join(import.meta.dirname, "fixtures/screenCompare.log.jsonl");
export const TIMEOUT = 180_000;

// 画面の大きさ。高さ 801: 800 だと、ノードの文字の位置が描画の丸めの境目に載り、ほぼ同じ状態でも 0.05% を超えて揺れる
export const PAGE_VIEWPORT = { width: 1280, height: 801 } as const;

// テストの中で作る無音の WAV（PCM 16bit・モノラル）。会議の長さ（11 秒）より少し長くする
export function silentWav(seconds: number): Buffer {
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

export type ReviewPages = { audioPath: string; plainPath: string; dispose: () => Promise<void> };

// 本物のビルドを 1 回だけ流し、同じテンプレートから map-audio.html（録音つき）と map.html（録音なし）を書き出す。ログは既定で照合の例（LOG_PATH）で、別の例を使うときは logPath で渡す
export async function prepareReviewPages(logPath: string = LOG_PATH): Promise<ReviewPages> {
  const dir = await mkdtemp(join(tmpdir(), "live-mindmap-review-pages-"));
  const events = (await readFile(logPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const template = await buildReviewTemplateHtml();
  const audioPath = join(dir, "map-audio.html");
  const plainPath = join(dir, "map.html");
  await writeFile(audioPath, embedReviewAudio(embedReviewLog(template, events), silentWav(13).toString("base64")));
  await writeFile(plainPath, embedReviewLog(template, events));
  return { audioPath, plainPath, dispose: () => rm(dir, { recursive: true, force: true }) };
}

export type OpenOptions = {
  // 録音つきなら、<audio> が読み込めるまで待つ（読み込めなければ、前提が崩れている）
  audio: boolean;
  // 開くときの画面の大きさ（既定は PAGE_VIEWPORT）。狭い幅で開いたときの最初の状態を見るときに渡す
  viewport?: { width: number; height: number };
  afterOpen?: (page: Page) => Promise<void>;
};

// ページを開き、ノードが出て（録音つきなら <audio> が読み込めて）画面が使える状態になるまで待って返す
export async function openReviewPage(browser: Browser, htmlPath: string, { audio, viewport = PAGE_VIEWPORT, afterOpen }: OpenOptions): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(pathToFileURL(htmlPath).href);
  await page.locator(".map-node").first().waitFor({ timeout: 30_000 });
  if (audio) {
    await page.waitForFunction(
      () => {
        const element = document.querySelector("audio");
        return element !== null && Number.isFinite(element.duration) && element.duration > 0;
      },
      undefined,
      { timeout: 30_000 },
    );
  }
  await afterOpen?.(page);
  return page;
}

const TRANSFORM = /translate\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)\s*scale\((-?[\d.e+-]+)\)/;
const parseTransform = (transform: string | null, source: string): Viewport => {
  const match = transform === null ? null : TRANSFORM.exec(transform);
  if (match === null) throw new Error(`${source} の transform を読めません: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
};

// ビューポートは .map-viewport の style.transform（translate(xpx, ypx) scale(z)）
export const readFoldkitViewport = async (page: Page): Promise<Viewport> =>
  parseTransform(await page.evaluate(() => (document.querySelector(".map-viewport") as HTMLElement | null)?.style.transform ?? null), ".map-viewport");

type SideOptions = OpenOptions & { htmlPath: string };
export const foldkitSide = (name: string, { htmlPath, ...options }: SideOptions): Side => ({
  name,
  viewport: readFoldkitViewport,
  open: (browser) => openReviewPage(browser, htmlPath, options),
});

// ---- 照合の操作の列 ----
export const keys = (name: string, sequence: string[], playing = false): Step => ({
  name,
  playing,
  run: async (page) => {
    for (const key of sequence) await page.keyboard.press(key);
  },
});

// .map の中の、ノードの無い所（右下の隅）と、中央
export const mapPoint = async (page: Page, where: "center" | "corner") => {
  const box = await page.locator(".map").boundingBox();
  if (box === null) throw new Error(".map の位置を読めません");
  return where === "center" ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: box.x + box.width - 40, y: box.y + box.height - 40 };
};

export const wheelWith = (name: string, held: string[], deltaX: number, deltaY: number): Step => ({
  name,
  run: async (page) => {
    const { x, y } = await mapPoint(page, "center");
    await page.mouse.move(x, y);
    for (const key of held) await page.keyboard.down(key);
    await page.mouse.wheel(deltaX, deltaY);
    for (const key of held.toReversed()) await page.keyboard.up(key);
  },
});

// 見返しに流す操作の列。人の手の操作（キー・ホイール・ピンチ・ドラッグ・クリック・開閉・変わったこと）を一通り含める
export const FULL_STEPS: Step[] = [
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
      await page.waitForFunction((expected) => document.querySelectorAll('button[aria-label="開く"]').length === expected, before + 1, { timeout: 10_000 });
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

// ---- 寸法の確認 ----
// 動いている animation・transition は読む前に最後まで進めて終わらせる（途中の値を読んで揺れるのを避ける）
export const styleOf = <K extends string>(page: Page, selector: string, props: readonly K[], nth = 0): Promise<Record<K, string>> =>
  page.locator(selector).nth(nth).evaluate((element, names) => {
    for (const animation of element.getAnimations()) animation.finish();
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
  }, props) as Promise<Record<K, string>>;
export const rectOf = (page: Page, selector: string, nth = 0) =>
  page.locator(selector).nth(nth).evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish();
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
export const near = (actual: number, expected: number, label: string) => expect(Math.abs(actual - expected), `${label}: ${actual} / ${expected}`).toBeLessThanOrEqual(1);
