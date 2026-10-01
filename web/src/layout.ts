import type { SnapshotNode } from "../../server/src/core/index.ts";

// ノードの幅は固定（CSS の .map-node と同じ）。幅を実寸にすると、広いノードが 1 つ増えるだけで右の列が全部動く。
export const NODE_WIDTH = 200;
export const GAP_X = 60;
export const GAP_Y = 12;
// まだ測っていないノードの仮の高さ
export const DEFAULT_HEIGHT = 40;

export type Position = { x: number; y: number };

// 左 → 右の木の配置。
// - x は深さだけで決まる
// - 兄弟は nodes の並び（作られた順）に上から積む
// - 親は子の範囲（最初の子の上端〜最後の子の下端）の上下中央に置く
// - 末尾に子を足しても、それより上にある既存ノードは動かない
// heights は React Flow が測った実寸の高さ。
export function layout(nodes: SnapshotNode[], heights: Record<string, number>): Record<string, Position> {
  const children = new Map<string | null, SnapshotNode[]>();
  for (const n of nodes) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
  const heightOf = (id: string) => heights[id] ?? DEFAULT_HEIGHT;

  // 部分木を、自分の上端を 0 とした相対位置で配置する
  function place(node: SnapshotNode, depth: number): { pos: Record<string, Position>; height: number } {
    const h = heightOf(node.id);
    const x = depth * (NODE_WIDTH + GAP_X);
    const kids = children.get(node.id) ?? [];
    if (kids.length === 0) return { pos: { [node.id]: { x, y: 0 } }, height: h };

    const pos: Record<string, Position> = {};
    // 親が最初の子より高いと、親の上端が部分木の上にはみ出す。はみ出し分を後から全体に足すと、
    // 子を追加するたびに既存の子が動くので、最初の子の開始位置を先に決めておく（最初の子の高さだけで決まる）。
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
