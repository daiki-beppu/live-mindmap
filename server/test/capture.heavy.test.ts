import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { MapCapture, withCapturePage } from "../src/capture.ts";
import type { Snapshot, SnapshotNode } from "../src/core/index.ts";
import { managedPlaywright } from "./fixtures/managedPlaywright.ts";

// 実物の Playwright（Chromium）と Vite で、サーバー自身の表示ページを撮る。ブラウザの起動があるので時間がかかる。
// 事前に `pnpm cli install chromium` が要る。
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

// 1 回の撮影。Service の口から呼び、呼び出しごとに Vite とブラウザを開いて閉じる
const capture = (snapshot: Snapshot, path: string) =>
  Effect.gen(function* () {
    const service = yield* MapCapture;
    yield* service.capture(snapshot, path);
  }).pipe(Effect.provide(MapCapture.layer.pipe(Layer.provide(managedPlaywright))));

const temporary = Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-")));

describe("map.png の撮影", () => {
  it.live(
    "マップだけを描く: 渡したスナップショットのノードの本文がそのまま描かれ、全ノードが画面に収まり、変わったノードの強調・仮のノード・「根拠」と「変わったこと」の欄は出ない",
    () => Effect.gen(function* () {
      const snapshot = bigSnapshot();

      const seen = yield* withCapturePage(snapshot, (page) =>
        Effect.tryPromise(async () => {
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
            foldkitSurface: await page.locator(".map-surface").count(),
            reactFlow: await page.locator(".react-flow").count(),
            nodeSlots: await page.locator(".map-node-slot").count(),
            texts: await page.locator(".map-node__text").allTextContents(),
          };
        }),
      ).pipe(Effect.provide(managedPlaywright));

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
      // Foldkit の表示面で撮っている（React Flow ではない）。切り抜きの基準 .map-node-slot が全ノード分ある
      expect(seen.foldkitSurface).toBe(1);
      expect(seen.reactFlow).toBe(0);
      expect(seen.nodeSlots).toBe(snapshot.nodes.length);
      // 渡したスナップショットの本文がそのまま描かれる（WebSocket から取り直さない）
      expect([...seen.texts].sort()).toEqual(snapshot.nodes.map((n) => n.text).sort());
    }),
    TIMEOUT,
  );

  it.live("続けて 2 回撮れる（1 回目で起動した Vite・Chromium を残して競合しない）", () => Effect.gen(function* () {
    const dir = yield* temporary;
    yield* capture(bigSnapshot(), join(dir, "a.png"));
    yield* capture(bigSnapshot(), join(dir, "b.png"));
    // 両方とも指定のパスに PNG（シグネチャを持つ空でないファイル）が書かれている
    for (const name of ["a.png", "b.png"]) {
      const png = readFileSync(join(dir, name));
      expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      expect(png.length).toBeGreaterThan(1000);
    }
  }), TIMEOUT * 2);

  it.live("ノードを囲む範囲だけを切り抜くので、横に細長い小さなマップは撮影画面（1600×1000）より背の低い画像になる", () => Effect.gen(function* () {
    const nodes: SnapshotNode[] = [
      { id: "root", parent: null, kind: "会議", text: "週次", evidence: [] },
      { id: "n1", parent: "root", kind: "議題", text: "採用の進め方", evidence: [] },
    ];
    const path = join(yield* temporary, "map.png");

    yield* capture({ nodes, round: 1, changes: [], remarks: [] }, path);

    // PNG の IHDR: 幅は 16〜19 バイト目、高さは 20〜23 バイト目（deviceScaleFactor 2 の実ピクセル）
    const png = readFileSync(path);
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    expect(height).toBeLessThan(width / 2);
    expect(height).toBeLessThan(1000 * 2);
  }), TIMEOUT);
});
