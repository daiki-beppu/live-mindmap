import type { Snapshot } from "../../server/src/core/index.ts";
import { DEFAULT_HEIGHT, NODE_WIDTH, type Position } from "./layout.ts";

// 倍率の範囲。下限 0.75 は、14px の文字が 10.5px で映る大きさ。
export const MIN_ZOOM = 0.75;
export const MAX_ZOOM = 1.1;
// 寄せ先の外接箱の周りの余白（px）
const PADDING = 40;

export type Rect = { x: number; y: number; width: number; height: number };
export type Viewport = { x: number; y: number; zoom: number };

// カメラが寄せるノード（今の議題・祖先の議題・今の議題の子孫）と、下限でも収まらないときの中心にするノード
// （今の反映で最後に変わったノード。寄せ先の外でもよい。無ければ今の議題）。
// 今の議題が無い、またはノードに無いときは null（呼び出し側が全体を収める）
export function cameraFocus(snapshot: Snapshot): { ids: string[]; center: string } | null {
  const topic = snapshot.currentTopic;
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  if (topic === undefined || !byId.has(topic)) return null;

  const ids = new Set<string>();
  for (let cur = byId.get(topic); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
    if (cur.kind === "議題") ids.add(cur.id);
  }
  for (const n of snapshot.nodes) if (isUnder(byId, n.id, topic)) ids.add(n.id);

  return { ids: [...ids], center: snapshot.lastChanged ?? topic };
}

// id が ancestor 自身またはその子孫か
function isUnder(byId: Map<string, Snapshot["nodes"][number]>, id: string, ancestor: string): boolean {
  for (let cur = byId.get(id); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
    if (cur.id === ancestor) return true;
  }
  return false;
}

export function nodeRect(id: string, target: Record<string, Position>, dims: Record<string, { height: number }>): Rect {
  const p = target[id] ?? { x: 0, y: 0 };
  return { x: p.x, y: p.y, width: NODE_WIDTH, height: dims[id]?.height ?? DEFAULT_HEIGHT };
}

// rects の外接箱が（余白込みで）収まる倍率（MIN_ZOOM〜MAX_ZOOM）で、画面の中央に映す。
// MIN_ZOOM でも収まらないときは、center の中心を画面の中央にする。画面座標は 座標 × zoom + x（y）
export function focusViewport(rects: Rect[], center: Rect, size: { width: number; height: number }): Viewport {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  const fitZoom = Math.min(size.width / (right - left + PADDING * 2), size.height / (bottom - top + PADDING * 2));
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fitZoom));
  const [cx, cy] = fitZoom >= MIN_ZOOM ? [(left + right) / 2, (top + bottom) / 2] : [center.x + center.width / 2, center.y + center.height / 2];
  return { x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom, zoom };
}

// 今の round に変わったノードが無く、すでにこの round より前に寄せていれば動かさない。
// 同じ round の測り直し（実寸が届いた）では寄せ直す
export function shouldMoveCamera(snapshot: Snapshot, placedRound: number | null): boolean {
  if (placedRound === null || placedRound === snapshot.round) return true;
  return snapshot.lastChanged !== undefined || snapshot.changes.some((c) => c.round === snapshot.round);
}
