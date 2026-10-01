import { describe, expect, it } from "vitest";
import type { SnapshotNode } from "../../server/src/core/index.ts";
import type { Position } from "../src/layout.ts";
import { interpolate, startPositions } from "../src/motion.ts";

const node = (id: string, parent: string | null): SnapshotNode => ({
  id,
  parent,
  kind: parent ? "議題" : "会議",
  text: id,
  evidence: parent ? ["r1"] : [],
});

type Positions = Record<string, Position>;

describe("startPositions: 位置の変化の出発点", () => {
  // 目標: root → A → A1 → A2。A1 と A2 は今回新しく増えた
  const nodes = [node("root", null), node("A", "root"), node("A1", "A"), node("A2", "A1")];
  const target: Positions = { root: { x: 0, y: 100 }, A: { x: 260, y: 50 }, A1: { x: 520, y: 0 }, A2: { x: 780, y: 0 } };

  it("初回（表示済みの位置がない）は目標の位置のまま。アニメーションしない", () => {
    expect(startPositions(nodes, {}, target)).toEqual(target);
  });

  it("表示済みのノードは、今表示している位置から出発する（目標の位置ではない）", () => {
    const shown: Positions = { root: { x: 0, y: 0 }, A: { x: 260, y: 10 } };
    const start = startPositions(nodes, shown, target);
    expect(start.root).toEqual({ x: 0, y: 0 });
    expect(start.A).toEqual({ x: 260, y: 10 });
  });

  it("新しいノードは、表示済みの親の位置から出発する（根元から伸びる）", () => {
    const shown: Positions = { root: { x: 0, y: 0 }, A: { x: 260, y: 10 } };
    expect(startPositions(nodes, shown, target).A1).toEqual({ x: 260, y: 10 });
  });

  it("親も新しいときは、表示済みの最も近い祖先の位置から出発する", () => {
    const shown: Positions = { root: { x: 0, y: 0 }, A: { x: 260, y: 10 } };
    expect(startPositions(nodes, shown, target).A2).toEqual({ x: 260, y: 10 });
  });

  it("目標に無いノード（消えたノード）の位置は含めない", () => {
    const shown: Positions = { root: { x: 0, y: 0 }, A: { x: 260, y: 10 }, gone: { x: 9, y: 9 } };
    expect(Object.keys(startPositions(nodes, shown, target)).sort()).toEqual(["A", "A1", "A2", "root"]);
  });

  it("補間の途中に次の反映が来ても、そのとき表示している位置から出発する", () => {
    const midway: Positions = { root: { x: 0, y: 40 }, A: { x: 130, y: 25 } };
    const next = [node("root", null), node("A", "root"), node("B", "A")];
    const next2: Positions = { root: { x: 0, y: 100 }, A: { x: 260, y: 50 }, B: { x: 520, y: 80 } };
    const start = startPositions(next, midway, next2);
    expect(start.A).toEqual({ x: 130, y: 25 });
    expect(start.B).toEqual({ x: 130, y: 25 });
  });
});

describe("interpolate: 出発点から目標へ", () => {
  const from: Positions = { a: { x: 0, y: 0 }, b: { x: 100, y: 40 } };
  const to: Positions = { a: { x: 200, y: 100 }, b: { x: 100, y: 0 } };

  it("t = 0 は出発点、t = 1 は目標の位置になる", () => {
    expect(interpolate(from, to, 0)).toEqual(from);
    expect(interpolate(from, to, 1)).toEqual(to);
  });

  it("途中は出発点と目標の間にある（動かないノードは動かない）", () => {
    const mid = interpolate(from, to, 0.5);
    expect(mid.a!.x).toBeGreaterThan(0);
    expect(mid.a!.x).toBeLessThan(200);
    expect(mid.a!.y).toBeGreaterThan(0);
    expect(mid.a!.y).toBeLessThan(100);
    expect(mid.b!.x).toBe(100);
  });

  it("範囲外の t は出発点・目標の外へ出ない（rAF の時刻が開始時刻より前でも逆戻りしない）", () => {
    expect(interpolate(from, to, -0.08)).toEqual(from);
    expect(interpolate(from, to, 1.2)).toEqual(to);
  });
});
