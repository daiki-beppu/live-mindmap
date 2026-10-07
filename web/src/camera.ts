import type { Snapshot } from "../../server/src/core/index.ts";
import { DEFAULT_HEIGHT, NODE_WIDTH, type Position } from "./layout.ts";

// 倍率の範囲。下限 0.75 は、14px の文字が 10.5px で映る大きさ。
export const MIN_ZOOM = 0.75;
export const MAX_ZOOM = 1.1;
// 人が操作するときの倍率の範囲
export const USER_MIN_ZOOM = 0.5;
export const USER_MAX_ZOOM = 2;
// 全体を収めるときの下限（人の下限 0.5 では大きなマップが収まらない）
export const OVERVIEW_MIN_ZOOM = 0.02;
// 寄せ先の外接箱の周りの余白（px）
const PADDING = 40;

export type Rect = { x: number; y: number; width: number; height: number };
export type Viewport = { x: number; y: number; zoom: number };
type Size = { width: number; height: number };

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
export function focusViewport(rects: Rect[], center: Rect, size: Size): Viewport {
  const { left, top, right, bottom, fitZoom } = fitBox(rects, size);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fitZoom));
  const [cx, cy] = fitZoom >= MIN_ZOOM ? [(left + right) / 2, (top + bottom) / 2] : [center.x + center.width / 2, center.y + center.height / 2];
  return { x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom, zoom };
}

// rects の外接箱と、それが（余白込みで）画面に収まる倍率（範囲に収める前）
function fitBox(rects: Rect[], size: Size) {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  const fitZoom = Math.min(size.width / (right - left + PADDING * 2), size.height / (bottom - top + PADDING * 2));
  return { left, top, right, bottom, fitZoom };
}

// 人が操作する倍率を 0.5〜2 倍に収める
export function clampUserZoom(zoom: number): number {
  return Math.min(USER_MAX_ZOOM, Math.max(USER_MIN_ZOOM, zoom));
}

// 画面の中心に映っているワールド座標を保ったまま、倍率を zoom にする
export function zoomAroundCenter(viewport: Viewport, zoom: number, size: Size): Viewport {
  const cx = (size.width / 2 - viewport.x) / viewport.zoom;
  const cy = (size.height / 2 - viewport.y) / viewport.zoom;
  return { x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom, zoom };
}

// 画面の 1/3 ずつ動かす。dx・dy は見えてくる側の向き（dx = 1 なら右側が見える）。倍率は変えない
export function panViewport(viewport: Viewport, dir: { dx: number; dy: number }, size: Size): Viewport {
  return { x: viewport.x - (dir.dx * size.width) / 3, y: viewport.y - (dir.dy * size.height) / 3, zoom: viewport.zoom };
}

// ⌘/Ctrl＋クリックで変える倍率（縮小は逆数）
export const CLICK_ZOOM_FACTOR = 1.5;
// 前回の入力からこれだけ空いたら、スクロールで動かす軸を決め直す（ms）
export const SCROLL_AXIS_RESET_MS = 250;

// 画面上の point に映っているワールド座標を保ったまま、倍率を factor 倍する（結果は 0.5〜2 倍に収める）。point は map 要素の左上が原点
export function zoomAtPoint(viewport: Viewport, point: { x: number; y: number }, factor: number): Viewport {
  const zoom = clampUserZoom(viewport.zoom * factor);
  const wx = (point.x - viewport.x) / viewport.zoom;
  const wy = (point.y - viewport.y) / viewport.zoom;
  return { x: point.x - wx * zoom, y: point.y - wy * zoom, zoom };
}

export type ScrollAxisLock = { axis: "x" | "y"; at: number };

// スクロールで動かす軸。前回から SCROLL_AXIS_RESET_MS 未満なら前回の軸を保ち、それ以外は大きい方の軸（同じ大きさなら y）で決める。at は入力の時刻（ms）
export function scrollAxis(prev: ScrollAxisLock | null, at: number, delta: { x: number; y: number }): ScrollAxisLock {
  if (prev && at - prev.at < SCROLL_AXIS_RESET_MS) return { axis: prev.axis, at };
  return { axis: Math.abs(delta.x) > Math.abs(delta.y) ? "x" : "y", at };
}

// 決まった軸だけを動かす。量は delta.x・delta.y の大きい方。正の量で右側・下側が見えてくる。倍率は変えない
export function scrollAlongAxis(viewport: Viewport, axis: "x" | "y", delta: { x: number; y: number }): Viewport {
  const amount = Math.abs(delta.x) >= Math.abs(delta.y) ? delta.x : delta.y;
  return axis === "x" ? { ...viewport, x: viewport.x - amount } : { ...viewport, y: viewport.y - amount };
}

// ids のノードを、目標の位置で測った外接箱で、画面の中央に一度で収める（OVERVIEW_MIN_ZOOM〜USER_MAX_ZOOM）。ids が空なら null
export function overviewViewport(
  ids: string[],
  target: Record<string, Position>,
  dims: Record<string, { height: number }>,
  size: Size,
): Viewport | null {
  if (ids.length === 0) return null;
  const { left, top, right, bottom, fitZoom } = fitBox(
    ids.map((id) => nodeRect(id, target, dims)),
    size,
  );
  const zoom = Math.min(USER_MAX_ZOOM, Math.max(OVERVIEW_MIN_ZOOM, fitZoom));
  return { x: size.width / 2 - ((left + right) / 2) * zoom, y: size.height / 2 - ((top + bottom) / 2) * zoom, zoom };
}

// 今の round に変わったノードが無く、すでにこの round より前に寄せていれば動かさない。
// 同じ round の測り直し（実寸が届いた）では寄せ直す
export function shouldMoveCamera(snapshot: Snapshot, placedRound: number | null): boolean {
  if (placedRound === null || placedRound === snapshot.round) return true;
  return snapshot.lastChanged !== undefined || snapshot.changes.some((c) => c.round === snapshot.round);
}
