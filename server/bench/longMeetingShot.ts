// 長い会議の計測（issue #127 の調査用）: スナップショットを、今のライブの画面（web）で表示して撮る。
// map.png の撮影用表示（still）ではなく、play / ライブと同じ WebSocket 経由の画面を、画面共有の解像度で開く。
//   node bench/longMeetingShot.ts <出力フォルダ> <スナップショット.json>... [--width 1920 --height 1080]
// 各スナップショットについて <名前>.png を書き、倍率・はみ出したノード数・実効の文字サイズを標準出力に JSON で出す。
import { join, basename } from "node:path";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";
import { startSnapshotServer } from "../src/ws.ts";
import type { Snapshot } from "../src/core/index.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { width: { type: "string", default: "1920" }, height: { type: "string", default: "1080" } } });
const [out, ...files] = positionals;
if (!out || files.length === 0) throw new Error("usage: node bench/longMeetingShot.ts <出力フォルダ> <スナップショット.json>...");

const ws = await startSnapshotServer({ port: 0 });
process.env.LIVE_MINDMAP_PORT = String(ws.port); // web の vite.config.ts が /ws の proxy 先に使う
const WEB_ROOT = join(import.meta.dirname, "../../web");
const vite = await createViteServer({ root: WEB_ROOT, configFile: join(WEB_ROOT, "vite.config.ts"), logLevel: "silent", clearScreen: false, server: { host: "127.0.0.1", port: 0, hmr: false } });
await vite.listen();
const url = vite.resolvedUrls!.local[0]!;
const browser = await chromium.launch();
try {
  for (const file of files) {
    const snapshot: Snapshot = JSON.parse(readFileSync(file, "utf8"));
    ws.publish(snapshot);
    const page = await browser.newPage({ viewport: { width: Number(values.width), height: Number(values.height) }, deviceScaleFactor: 1 });
    await page.goto(url);
    await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length >= n, snapshot.nodes.length, { timeout: 60_000 });
    await page.waitForTimeout(4000); // 位置の補間と fitView が落ち着くのを待つ
    const stats = await page.evaluate(() => {
      const vp = document.querySelector(".react-flow__viewport") as HTMLElement;
      const m = /matrix\(([^,]+),/.exec(getComputedStyle(vp).transform);
      const zoom = m ? Number(m[1]) : 1;
      const pane = document.querySelector(".map")!.getBoundingClientRect();
      const nodes = [...document.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect());
      const outside = nodes.filter((b) => b.right < pane.left || b.left > pane.right || b.bottom < pane.top || b.top > pane.bottom).length;
      const partial = nodes.filter((b) => b.left < pane.left || b.right > pane.right || b.top < pane.top || b.bottom > pane.bottom).length;
      const xs = nodes.map((b) => [b.left, b.right]).flat();
      const ys = nodes.map((b) => [b.top, b.bottom]).flat();
      return { zoom, fontPx: +(14 * zoom).toFixed(1), nodes: nodes.length, outside, partial, mapPane: { w: pane.width, h: pane.height }, bounds: { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
    });
    const png = join(out, basename(file).replace(/\.json$/, ".png"));
    await page.screenshot({ path: png });
    process.stdout.write(JSON.stringify({ file, png, ...stats }) + "\n");
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
  await ws.close();
}
