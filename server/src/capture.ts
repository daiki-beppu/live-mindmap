// map.png の撮影。サーバー自身が web の表示ページを Vite で立て、Playwright のヘッドレスブラウザで開いて撮る。
// ブラウザ（WebSocket のクライアント）は要らない。スナップショットは addInitScript でページへ直接渡す。
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { chromium, type Page } from "playwright";
import { CAPTURE_OVERFLOW_ATTRIBUTE, CAPTURE_READY_ATTRIBUTE, CAPTURE_SNAPSHOT_GLOBAL } from "./core/capture.ts";
import type { Snapshot } from "./core/index.ts";

// スナップショットのマップを path に PNG で書き出す
export type MapCapture = (snapshot: Snapshot, path: string) => Promise<void>;

const WEB_ROOT = join(import.meta.dirname, "../../web");
const VIEWPORT = { width: 1600, height: 1000 };
const READY_TIMEOUT_MS = 30_000;

// 撮影用のページを開いて fn に渡し、終わったら（失敗しても）ブラウザと Vite を閉じる
export async function withCapturePage<T>(snapshot: Snapshot, fn: (page: Page) => Promise<T>): Promise<T> {
  // 常に今のソースで描くため、web の Vite をここで起動する（ビルドの手順を持たない）。ポートは空きを割り当てる
  const vite = await createViteServer({
    root: WEB_ROOT,
    configFile: join(WEB_ROOT, "vite.config.ts"),
    logLevel: "silent",
    clearScreen: false,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
  });
  try {
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("撮影用の表示ページの URL を取得できません");
    const browser = await chromium.launch().catch((e: unknown) => {
      throw new Error(`Chromium を起動できません。pnpm --filter @live-mindmap/server exec playwright install chromium を実行してください（${e instanceof Error ? e.message : e}）`);
    });
    try {
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
      await page.addInitScript(
        ({ name, value }) => {
          (globalThis as Record<string, unknown>)[name] = value;
        },
        { name: CAPTURE_SNAPSHOT_GLOBAL, value: snapshot },
      );
      await page.goto(url);
      await page.waitForSelector(`[${CAPTURE_READY_ATTRIBUTE}], [${CAPTURE_OVERFLOW_ATTRIBUTE}]`, { timeout: READY_TIMEOUT_MS });
      if ((await page.locator(`[${CAPTURE_OVERFLOW_ATTRIBUTE}]`).count()) > 0) {
        throw new Error(`マップ全体を ${VIEWPORT.width}×${VIEWPORT.height} の撮影画面に収められません（ノード数: ${snapshot.nodes.length}）`);
      }
      return await fn(page);
    } finally {
      await browser.close();
    }
  } finally {
    await vite.close();
  }
}

export const captureMap: MapCapture = (snapshot, path) =>
  withCapturePage(snapshot, async (page) => {
    await page.screenshot({ path, type: "png" });
  });
