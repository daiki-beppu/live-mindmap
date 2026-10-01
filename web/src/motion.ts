import type { SnapshotNode } from "../../server/src/core/index.ts";
import type { Position } from "./layout.ts";

type Positions = Record<string, Position>;

// 位置の変化の出発点。目標にあるノードだけを返す。
// - 表示済みのノードは、今表示している位置から（補間の途中でも途中の位置から続ける）
// - 新しいノードは、表示済みの最も近い祖先の位置から（根元から伸びる）
// - 表示済みの位置が何もない初回は、目標のまま（動かさない）
export function startPositions(nodes: SnapshotNode[], shown: Positions, target: Positions): Positions {
  if (Object.keys(shown).length === 0) return target;
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent]));
  const start: Positions = {};
  for (const id of Object.keys(target)) {
    let from: Position | undefined = shown[id];
    for (let cur = parentOf.get(id); !from && cur; cur = parentOf.get(cur)) from = shown[cur];
    start[id] = from ?? target[id]!;
  }
  return start;
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

// t は 0〜1 の進み具合。0 で出発点、1 で目標の位置になる。
export function interpolate(from: Positions, to: Positions, t: number): Positions {
  const k = easeOutCubic(Math.min(1, Math.max(0, t))); // rAF の時刻は開始時刻より前になりうるので、範囲に収める
  const out: Positions = {};
  for (const [id, p] of Object.entries(to)) {
    const f = from[id] ?? p;
    out[id] = { x: f.x + (p.x - f.x) * k, y: f.y + (p.y - f.y) * k };
  }
  return out;
}
