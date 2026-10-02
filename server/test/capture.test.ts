import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureMap, withCapturePage } from "../src/capture.ts";
import type { Snapshot, SnapshotNode } from "../src/core/index.ts";

// 実物の Playwright（Chromium）と Vite で、サーバー自身の表示ページを撮る。ブラウザの起動があるので時間がかかる。
// 事前に `pnpm --filter @live-mindmap/server exec playwright install chromium` が要る。
const TIMEOUT = 90_000;

// 議題 6 つ × 論点 6 つ（ルートを入れて 43 ノード）。既定の画面に収まらない大きさにして、「全体を収める」ことを確かめる。
function bigSnapshot(): Snapshot {
  const nodes: SnapshotNode[] = [{ id: "root", parent: null, kind: "会議", text: "週次", evidence: [] }];
  for (let a = 1; a <= 6; a++) {
    nodes.push({ id: `a${a}`, parent: "root", kind: "議題", text: `議題 ${a}`, evidence: ["r1"] });
    for (let b = 1; b <= 6; b++) {
      nodes.push({ id: `a${a}b${b}`, parent: `a${a}`, kind: "論点", text: `議題 ${a} の論点 ${b}`, evidence: ["r1"] });
    }
  }
  return {
    nodes,
    round: 3,
    // 最新の反映（round 3）で変わったノードがある。ブラウザの画面なら点滅・黄色の枠になる
    changes: [
      { round: 3, at: 30, change: "追加", node: "a1", kind: "議題", text: "議題 1" },
      { round: 3, at: 30, change: "追加", node: "a1b1", kind: "論点", text: "議題 1 の論点 1" },
    ],
    remarks: [{ id: "r1", track: "相手", start: 0, end: 10, text: "根拠の発言" }],
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("map.png の撮影", () => {
  it(
    "マップだけを描く: 全ノードが画面に収まり、変わったノードの強調・仮のノード・「根拠」と「変わったこと」の欄は出ない",
    { timeout: TIMEOUT },
    async () => {
      const snapshot = bigSnapshot();

      const seen = await withCapturePage(snapshot, async (page) => {
        const viewport = page.viewportSize()!;
        const boxes = await page.locator(".map-node").evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          }),
        );
        return {
          viewport,
          boxes,
          blink: await page.locator(".map-node--blink").count(),
          draft: await page.locator(".draft-node").count(),
          side: await page.locator(".side").count(),
          waiting: await page.locator(".waiting").count(),
        };
      });

      expect(seen.boxes).toHaveLength(snapshot.nodes.length);
      // 全体を収める: どのノードも、撮る画面（ビューポート）からはみ出さない
      for (const b of seen.boxes) {
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(seen.viewport.width);
        expect(b.bottom).toBeLessThanOrEqual(seen.viewport.height);
      }
      expect(seen.blink).toBe(0);
      expect(seen.draft).toBe(0);
      expect(seen.side).toBe(0);
      expect(seen.waiting).toBe(0); // 「サーバーを待っています」の待機表示を撮らない
    },
  );

  it(
    "渡したスナップショットのノードの本文が、そのまま描かれる（WebSocket から取り直さない）",
    { timeout: TIMEOUT },
    async () => {
      const texts = await withCapturePage(bigSnapshot(), (page) => page.locator(".map-node__text").allTextContents());
      expect(texts.sort()).toEqual(bigSnapshot().nodes.map((n) => n.text).sort());
    },
  );

  it("captureMap は指定のパスに PNG（シグネチャを持つ空でないファイル）を書く", { timeout: TIMEOUT }, async () => {
    const path = join(await mkdtemp(join(tmpdir(), "live-mindmap-")), "map.png");

    await captureMap(bigSnapshot(), path);

    const png = readFileSync(path);
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(png.length).toBeGreaterThan(1000);
  });

  it("続けて 2 回撮れる（1 回目で起動した Vite・Chromium を残して競合しない）", { timeout: TIMEOUT * 2 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-mindmap-"));
    await captureMap(bigSnapshot(), join(dir, "a.png"));
    await captureMap(bigSnapshot(), join(dir, "b.png"));
    for (const name of ["a.png", "b.png"]) expect([...readFileSync(join(dir, name)).subarray(0, 4)]).toEqual(PNG_SIGNATURE.slice(0, 4));
  });

  it("全体を下限の倍率でも収められない大きさなら、PNG を書かずに失敗する（欠けた画像を成功として書き出さない）", { timeout: TIMEOUT }, async () => {
    // ルート + 葉 1500 枚。縦の配置が約 90,000px になり、必要な倍率（約 0.011）が下限 0.02 を下回る
    const nodes: SnapshotNode[] = [{ id: "root", parent: null, kind: "会議", text: "週次", evidence: [] }];
    for (let i = 1; i <= 1500; i++) nodes.push({ id: `n${i}`, parent: "root", kind: "議題", text: `議題 ${i}`, evidence: [] });
    const path = join(await mkdtemp(join(tmpdir(), "live-mindmap-")), "map.png");

    await expect(captureMap({ nodes, round: 1, changes: [], remarks: [] }, path)).rejects.toThrow("収められません");
    expect(existsSync(path)).toBe(false);
  });

  it("撮影の処理（fn）が失敗しても、そのエラーをそのまま伝える（握りつぶさない）", { timeout: TIMEOUT }, async () => {
    await expect(
      withCapturePage(bigSnapshot(), async () => {
        throw new Error("fn の失敗");
      }),
    ).rejects.toThrow("fn の失敗");
  });
});
