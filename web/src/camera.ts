import type { Snapshot } from "../../server/src/core/index.ts";
import { changedNodeIds } from "./changes.ts";
import { DEFAULT_HEIGHT, NODE_WIDTH, type Position } from "./layout.ts";

export const MIN_ZOOM = 0.75;
export const MAX_ZOOM = 1.1;
export const USER_MIN_ZOOM = 0.5;
export const USER_MAX_ZOOM = 2;
export const OVERVIEW_MIN_ZOOM = 0.02;
const PADDING = 40;
const EDGE_INSET = 12;
const MERGE_DISTANCE = 24;

export type Rect = { x: number; y: number; width: number; height: number };
export type Viewport = { x: number; y: number; zoom: number };
type Size = { width: number; height: number };

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

export function changedFocus(snapshot: Snapshot, shownIdOf: (id: string) => string): { ids: string[]; center: string } | null {
  const present = new Set(snapshot.nodes.map((n) => n.id));
  const changed = [...changedNodeIds(snapshot)].filter((id) => present.has(id));
  if (changed.length === 0) return null;
  const ids = [...new Set(changed.map(shownIdOf))];
  const last = snapshot.lastChanged !== undefined ? shownIdOf(snapshot.lastChanged) : ids[ids.length - 1]!;
  return { ids, center: last };
}

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

export function focusViewport(rects: Rect[], center: Rect, size: Size, minZoom: number = MIN_ZOOM): Viewport {
  const { left, top, right, bottom, fitZoom } = fitBox(rects, size);
  const zoom = Math.min(MAX_ZOOM, Math.max(minZoom, fitZoom));
  const [cx, cy] = fitZoom >= minZoom ? [(left + right) / 2, (top + bottom) / 2] : [center.x + center.width / 2, center.y + center.height / 2];
  return { x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom, zoom };
}

function boundsOf(rects: readonly Rect[]) {
  return {
    left: Math.min(...rects.map((r) => r.x)),
    top: Math.min(...rects.map((r) => r.y)),
    right: Math.max(...rects.map((r) => r.x + r.width)),
    bottom: Math.max(...rects.map((r) => r.y + r.height)),
  };
}

function fitBox(rects: Rect[], size: Size) {
  const { left, top, right, bottom } = boundsOf(rects);
  const fitZoom = Math.min(size.width / (right - left + PADDING * 2), size.height / (bottom - top + PADDING * 2));
  return { left, top, right, bottom, fitZoom };
}

export function clampUserZoom(zoom: number): number {
  return Math.min(USER_MAX_ZOOM, Math.max(USER_MIN_ZOOM, zoom));
}

export function zoomAroundCenter(viewport: Viewport, zoom: number, size: Size): Viewport {
  const cx = (size.width / 2 - viewport.x) / viewport.zoom;
  const cy = (size.height / 2 - viewport.y) / viewport.zoom;
  return { x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom, zoom };
}

export function panViewport(viewport: Viewport, dir: { dx: number; dy: number }, size: Size): Viewport {
  return { x: viewport.x - (dir.dx * size.width) / 3, y: viewport.y - (dir.dy * size.height) / 3, zoom: viewport.zoom };
}

export const CLICK_ZOOM_FACTOR = 1.5;
export const SCROLL_AXIS_RESET_MS = 250;

export function zoomAtPoint(viewport: Viewport, point: { x: number; y: number }, factor: number): Viewport {
  const zoom = clampUserZoom(viewport.zoom * factor);
  const wx = (point.x - viewport.x) / viewport.zoom;
  const wy = (point.y - viewport.y) / viewport.zoom;
  return { x: point.x - wx * zoom, y: point.y - wy * zoom, zoom };
}

const PINCH_DELTA_FACTOR = { line: 0.05, page: 1, pixel: 0.002 };
const PINCH_MAC_CTRL_MULTIPLIER = 10;

export function pinchZoomFactor(wheel: { deltaY: number; deltaMode: number; ctrlKey: boolean }, isMac: boolean): number {
  const perDelta = wheel.deltaMode === 1 ? PINCH_DELTA_FACTOR.line : wheel.deltaMode ? PINCH_DELTA_FACTOR.page : PINCH_DELTA_FACTOR.pixel;
  return 2 ** (-wheel.deltaY * perDelta * (isMac && wheel.ctrlKey ? PINCH_MAC_CTRL_MULTIPLIER : 1));
}

export type ScrollAxisLock = { axis: "x" | "y"; at: number };

export function scrollAxis(prev: ScrollAxisLock | null, at: number, delta: { x: number; y: number }): ScrollAxisLock {
  if (prev && at - prev.at < SCROLL_AXIS_RESET_MS) return { axis: prev.axis, at };
  return { axis: Math.abs(delta.x) > Math.abs(delta.y) ? "x" : "y", at };
}

export function scrollAlongAxis(viewport: Viewport, axis: "x" | "y", delta: { x: number; y: number }): Viewport {
  const amount = Math.abs(delta.x) >= Math.abs(delta.y) ? delta.x : delta.y;
  return axis === "x" ? { ...viewport, x: viewport.x - amount } : { ...viewport, y: viewport.y - amount };
}

const PAN_ON_SCROLL_SPEED = 0.5;
// 行単位の wheel（Firefox の deltaMode 1）は 20 倍する
const LINE_DELTA_FACTOR = 20;

export type WheelDelta = { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean };

// 二本指スクロールで画面（ビューポートの平行移動）が動く量。delta と逆向き。Mac でない環境の Shift 付きは、縦の量を横に使う（Mac はブラウザが入れ替えて渡す）
export function scrollPanDelta(wheel: WheelDelta, isMac: boolean): { x: number; y: number } {
  const factor = wheel.deltaMode === 1 ? LINE_DELTA_FACTOR : 1;
  const swap = !isMac && wheel.shiftKey;
  const deltaX = (swap ? wheel.deltaY : wheel.deltaX) * factor;
  const deltaY = swap ? 0 : wheel.deltaY * factor;
  return { x: -deltaX * PAN_ON_SCROLL_SPEED, y: -deltaY * PAN_ON_SCROLL_SPEED };
}

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

export type EdgeDot = { id: string; ids: string[]; side: "top" | "right" | "bottom" | "left"; x: number; y: number };

type EdgeCandidate = { id: string; dist: number; dot: Omit<EdgeDot, "id" | "ids"> };

function offscreenCandidate(
  id: string,
  target: Record<string, Position>,
  dims: Record<string, { height: number }>,
  viewport: Viewport,
  size: Size,
): EdgeCandidate | null {
  const cx = size.width / 2;
  const cy = size.height / 2;
  const r = nodeRect(id, target, dims);
  const left = r.x * viewport.zoom + viewport.x;
  const top = r.y * viewport.zoom + viewport.y;
  const right = left + r.width * viewport.zoom;
  const bottom = top + r.height * viewport.zoom;
  if (right > 0 && left < size.width && bottom > 0 && top < size.height) return null;
  const dx = (left + right) / 2 - cx;
  const dy = (top + bottom) / 2 - cy;
  const tx = dx === 0 ? Infinity : (cx - EDGE_INSET) / Math.abs(dx);
  const ty = dy === 0 ? Infinity : (cy - EDGE_INSET) / Math.abs(dy);
  const horizontal = tx <= ty;
  const t = horizontal ? tx : ty;
  const side = horizontal ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
  return { id, dist: Math.hypot(dx, dy), dot: { side, x: cx + dx * t, y: cy + dy * t } };
}

function mergeNearDots(candidates: readonly EdgeCandidate[]): EdgeDot[] {
  const dots: EdgeDot[] = [];
  for (const c of candidates) {
    const near = dots.find((d) => Math.hypot(d.x - c.dot.x, d.y - c.dot.y) <= MERGE_DISTANCE);
    if (near) near.ids.push(c.id);
    else dots.push({ id: c.id, ids: [c.id], ...c.dot });
  }
  return dots;
}

export function edgeDots(
  ids: string[],
  target: Record<string, Position>,
  dims: Record<string, { height: number }>,
  viewport: Viewport,
  size: Size,
): EdgeDot[] {
  const candidates = ids.flatMap((id) => offscreenCandidate(id, target, dims, viewport, size) ?? []);
  candidates.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return mergeNearDots(candidates);
}

export function nodeFocusViewport(rect: Rect, zoom: number, size: Size): Viewport {
  const z = Math.max(MIN_ZOOM, zoom);
  return { x: size.width / 2 - (rect.x + rect.width / 2) * z, y: size.height / 2 - (rect.y + rect.height / 2) * z, zoom: z };
}

export function subtreeViewport(
  id: string,
  tree: { ids: string[]; parents: Record<string, string | null> },
  target: Record<string, Position>,
  dims: Record<string, { height: number }>,
  size: Size,
): Viewport {
  const under = (n: string) => {
    for (let cur: string | null | undefined = n; cur != null; cur = tree.parents[cur]) if (cur === id) return true;
    return false;
  };
  const { left, top, right, bottom, fitZoom } = fitBox(
    tree.ids.filter(under).map((n) => nodeRect(n, target, dims)),
    size,
  );
  const self = nodeRect(id, target, dims);
  const zoom = clampUserZoom(fitZoom);
  const [cx, cy] = fitZoom >= USER_MIN_ZOOM ? [(left + right) / 2, (top + bottom) / 2] : [self.x + self.width / 2, self.y + self.height / 2];
  return { x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom, zoom };
}

export function shiftIntoView(viewport: Viewport, rects: Rect[], size: Size): Viewport {
  if (rects.length === 0) return { ...viewport };
  const left = Math.min(...rects.map((r) => r.x)) * viewport.zoom + viewport.x;
  const right = Math.max(...rects.map((r) => r.x + r.width)) * viewport.zoom + viewport.x;
  const cutRight = right > size.width;
  const cutLeft = left < 0;
  if (cutRight === cutLeft) return { ...viewport };
  const dx = cutRight ? -Math.min(right - size.width, left) : Math.min(-left, size.width - right);
  return { ...viewport, x: viewport.x + dx };
}

export function revealViewport(viewport: Viewport, rect: Rect, size: Size): Viewport {
  const shift = (start: number, length: number, extent: number) => {
    const from = start;
    const to = start + length;
    if (length > extent || from < 0) return -from;
    return to > extent ? extent - to : 0;
  };
  const left = rect.x * viewport.zoom + viewport.x;
  const top = rect.y * viewport.zoom + viewport.y;
  return {
    ...viewport,
    x: viewport.x + shift(left, rect.width * viewport.zoom, size.width),
    y: viewport.y + shift(top, rect.height * viewport.zoom, size.height),
  };
}

export function screenPoint(viewport: Viewport, position: Position): { x: number; y: number } {
  return { x: position.x * viewport.zoom + viewport.x, y: position.y * viewport.zoom + viewport.y };
}

export function anchoredViewport(viewport: Viewport, position: Position, anchor: { x: number; y: number }): Viewport {
  return { x: anchor.x - position.x * viewport.zoom, y: anchor.y - position.y * viewport.zoom, zoom: viewport.zoom };
}

export function shouldMoveCamera(snapshot: Snapshot, placedRound: number | null): boolean {
  if (placedRound === null || placedRound === snapshot.round) return true;
  return snapshot.lastChanged !== undefined || snapshot.changes.some((c) => c.round === snapshot.round);
}

const FIT_PADDING = 0.1;

const fitPadding = (side: number): number => Math.floor((side - side / (1 + FIT_PADDING)) * 0.5);

export function fitViewport(rects: readonly Rect[], size: Size, minZoom: number, maxZoom: number): Viewport | null {
  if (rects.length === 0) return null;
  const { left, top, right, bottom } = boundsOf(rects);
  const padX = fitPadding(size.width);
  const padY = fitPadding(size.height);
  const fitZoom = Math.min((size.width - padX * 2) / (right - left), (size.height - padY * 2) / (bottom - top));
  const zoom = Math.min(maxZoom, Math.max(minZoom, fitZoom));
  const x = size.width / 2 - ((left + right) / 2) * zoom;
  const y = size.height / 2 - ((top + bottom) / 2) * zoom;
  const shortLeft = Math.min(Math.floor(left * zoom + x) - padX, 0);
  const shortTop = Math.min(Math.floor(top * zoom + y) - padY, 0);
  const shortRight = Math.min(Math.floor(size.width - (right * zoom + x)) - padX, 0);
  const shortBottom = Math.min(Math.floor(size.height - (bottom * zoom + y)) - padY, 0);
  return { x: x - shortLeft + shortRight, y: y - shortTop + shortBottom, zoom };
}
