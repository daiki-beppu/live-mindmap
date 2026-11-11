import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { MapCapture, withCapturePage } from "../src/capture.ts";
import type { Snapshot, SnapshotNode } from "../src/core/index.ts";
import { managedPlaywright } from "./fixtures/managedPlaywright.ts";

const TIMEOUT = 90_000;

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
    changes: [
      { round: 3, at: 30, change: "追加", node: "a1", kind: "議題", text: "議題 1" },
      { round: 3, at: 30, change: "追加", node: "a1b1", kind: "論点", text: "議題 1 の論点 1" },
    ],
    remarks: [{ id: "r1", track: "相手", start: 0, end: 10, text: "根拠の発言" }],
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
      for (const b of seen.boxes) {
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(seen.viewport.width);
        expect(b.bottom).toBeLessThanOrEqual(seen.viewport.height);
      }
      expect(seen.blink).toBe(0);
      expect(seen.draft).toBe(0);
      expect(seen.side).toBe(0);
      expect(seen.waiting).toBe(0);
      expect(seen.foldkitSurface).toBe(1);
      expect(seen.reactFlow).toBe(0);
      expect(seen.nodeSlots).toBe(snapshot.nodes.length);
      expect([...seen.texts].sort()).toEqual(snapshot.nodes.map((n) => n.text).sort());
    }),
    TIMEOUT,
  );

  it.live("続けて 2 回撮れる（1 回目で起動した Vite・Chromium を残して競合しない）", () => Effect.gen(function* () {
    const dir = yield* temporary;
    yield* capture(bigSnapshot(), join(dir, "a.png"));
    yield* capture(bigSnapshot(), join(dir, "b.png"));
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

    const png = readFileSync(path);
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    expect(height).toBeLessThan(width / 2);
    expect(height).toBeLessThan(1000 * 2);
  }), TIMEOUT);

  it.live("表示ページの依存を、他の Vite と共有する web の .vite/deps から読まない（別の設定の Vite が作り直しても撮影の読み込みが壊れない）", () => Effect.gen(function* () {
    const snapshot: Snapshot = {
      nodes: [{ id: "root", parent: null, kind: "会議", text: "週次", evidence: [] }],
      round: 1,
      changes: [],
      remarks: [],
    };

    const urls = yield* withCapturePage(snapshot, (page) =>
      Effect.tryPromise(() => page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name))),
    ).pipe(Effect.provide(managedPlaywright));

    expect(urls.some((u) => u.includes("/src/main.ts"))).toBe(true);
    expect(urls.filter((u) => u.includes("/node_modules/.vite/deps/"))).toEqual([]);
  }), TIMEOUT);
});
