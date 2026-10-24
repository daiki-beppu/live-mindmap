import type { SnapshotNode } from "../../server/src/core/index.ts";

export const NODE_WIDTH = 200;
export const GAP_X = 60;
export const GAP_Y = 12;
export const DEFAULT_HEIGHT = 40;

export type Position = { x: number; y: number };

export function layout(nodes: SnapshotNode[], heights: Record<string, number>): Record<string, Position> {
  const children = new Map<string | null, SnapshotNode[]>();
  for (const n of nodes) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
  const heightOf = (id: string) => heights[id] ?? DEFAULT_HEIGHT;

  function place(node: SnapshotNode, depth: number): { pos: Record<string, Position>; height: number } {
    const h = heightOf(node.id);
    const x = depth * (NODE_WIDTH + GAP_X);
    const kids = children.get(node.id) ?? [];
    if (kids.length === 0) return { pos: { [node.id]: { x, y: 0 } }, height: h };

    const pos: Record<string, Position> = {};
    const firstKidHeight = heightOf(kids[0]!.id);
    let offset = Math.max(0, (h - firstKidHeight) / 2);
    let firstTop = 0;
    let lastBottom = 0;
    kids.forEach((kid, i) => {
      const sub = place(kid, depth + 1);
      for (const [id, p] of Object.entries(sub.pos)) pos[id] = { x: p.x, y: p.y + offset };
      const kidPos = pos[kid.id]!;
      if (i === 0) firstTop = kidPos.y;
      lastBottom = kidPos.y + heightOf(kid.id);
      offset += sub.height + GAP_Y;
    });
    const y = (firstTop + lastBottom) / 2 - h / 2;
    pos[node.id] = { x, y };
    return { pos, height: Math.max(offset - GAP_Y, y + h) };
  }

  const result: Record<string, Position> = {};
  let top = 0;
  for (const root of children.get(null) ?? []) {
    const sub = place(root, 0);
    for (const [id, p] of Object.entries(sub.pos)) result[id] = { x: p.x, y: p.y + top };
    top += sub.height + GAP_Y;
  }
  return result;
}
