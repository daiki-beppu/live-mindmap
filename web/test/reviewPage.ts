import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { embedReviewAudio, embedReviewLog } from "../../server/src/core/index.ts";
import { buildReviewTemplateHtml } from "../../server/test/fixtures/reviewTemplate.ts";
import type { Viewport } from "../src/camera.ts";
import type { Browser, Page } from "./browser.ts";

// 見返し（map.html・map-audio.html）の heavy IT が共有する道具（Issue #826）。テストではなく、
// テストの中で作る WAV・ビルドしたテンプレートへのログと音声の埋め込み・ページの開き方・ビューポートの読み方だけを置く。
// 音声のファイルはリポジトリに足さない（WAV は silentWav が作る）。

export const LOG_PATH = join(import.meta.dirname, "fixtures/sampleMeeting.log.jsonl");
export const TIMEOUT = 180_000;

// 画面の大きさ。高さ 801: 寸法の期待値（meeting.mount.heavy.test.ts の CAPTIONS_WIDTH など）が、この大きさで測った値のため
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

// 本物のビルドを 1 回だけ流し、同じテンプレートから map-audio.html（録音つき）と map.html（録音なし）を書き出す。ログは既定で題材のログ（LOG_PATH）で、別の例を使うときは logPath で渡す
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
};

// ページを開き、ノードが出て（録音つきなら <audio> が読み込めて）画面が使える状態になるまで待って返す
export async function openReviewPage(browser: Browser, htmlPath: string, { audio, viewport = PAGE_VIEWPORT }: OpenOptions): Promise<Page> {
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

// .map の中の、ノードの無い所（右下の隅）と、中央
export const mapPoint = async (page: Page, where: "center" | "corner") => {
  const box = await page.locator(".map").boundingBox();
  if (box === null) throw new Error(".map の位置を読めません");
  return where === "center" ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: box.x + box.width - 40, y: box.y + box.height - 40 };
};

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
