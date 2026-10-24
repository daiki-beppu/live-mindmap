import type { SnapshotNode } from "../../server/src/core/index.ts";
import type { Position } from "./layout.ts";

type Positions = Record<string, Position>;

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

export function interpolate(from: Positions, to: Positions, t: number): Positions {
  const k = easeOutCubic(Math.min(1, Math.max(0, t))); // rAF の時刻は開始時刻より前になりうるので、範囲に収める
  const out: Positions = {};
  for (const [id, p] of Object.entries(to)) {
    const f = from[id] ?? p;
    out[id] = { x: f.x + (p.x - f.x) * k, y: f.y + (p.y - f.y) * k };
  }
  return out;
}
