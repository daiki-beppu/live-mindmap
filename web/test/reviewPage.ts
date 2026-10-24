import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { embedReviewAudio, embedReviewLog } from "../../server/src/core/index.ts";
import type { Viewport } from "../src/camera.ts";
import type { BrowserContext, Page } from "./browser.ts";

export const LOG_PATH = join(import.meta.dirname, "fixtures/sampleMeeting.log.jsonl");
export const TIMEOUT = 180_000;

export const PAGE_VIEWPORT = { width: 1280, height: 801 } as const;

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

export async function prepareReviewPages(template: string, logPath: string = LOG_PATH): Promise<ReviewPages> {
  const dir = await mkdtemp(join(tmpdir(), "live-mindmap-review-pages-"));
  const events = (await readFile(logPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const audioPath = join(dir, "map-audio.html");
  const plainPath = join(dir, "map.html");
  await writeFile(audioPath, embedReviewAudio(embedReviewLog(template, events), silentWav(13).toString("base64")));
  await writeFile(plainPath, embedReviewLog(template, events));
  return { audioPath, plainPath, dispose: () => rm(dir, { recursive: true, force: true }) };
}

export type OpenOptions = {
  audio: boolean;
};

export async function openReviewPage(context: BrowserContext, htmlPath: string, { audio }: OpenOptions): Promise<Page> {
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

export const readFoldkitViewport = async (page: Page): Promise<Viewport> =>
  parseTransform(await page.evaluate(() => (document.querySelector(".map-viewport") as HTMLElement | null)?.style.transform ?? null), ".map-viewport");

const SETTLED_FRAMES = 3;
const SETTLED_TIMEOUT_MS = 8_000;
export async function settled(page: Page): Promise<void> {
  await readFoldkitViewport(page);
  const ok = await page.evaluate(
    ({ frames, timeoutMs }) =>
      new Promise<boolean>((resolve) => {
        const read = () => (document.querySelector(".map-viewport") as HTMLElement | null)?.style.transform ?? null;
        const started = performance.now();
        let last = read();
        let same = 0;
        const tick = () => {
          const now = read();
          same = now === last ? same + 1 : 0;
          last = now;
          if (same >= frames) return resolve(true);
          if (performance.now() - started > timeoutMs) return resolve(false);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { frames: SETTLED_FRAMES, timeoutMs: SETTLED_TIMEOUT_MS },
  );
  if (!ok) throw new Error("ビューポートが落ち着きません");
}

export const mapPoint = async (page: Page, where: "center" | "corner") => {
  const box = await page.locator(".map").boundingBox();
  if (box === null) throw new Error(".map の位置を読めません");
  return where === "center" ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: box.x + box.width - 40, y: box.y + box.height - 40 };
};

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
