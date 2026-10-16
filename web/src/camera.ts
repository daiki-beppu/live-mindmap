import type { Snapshot } from "../../server/src/core/index.ts";
import { changedNodeIds } from "./changes.ts";
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
// 縁の点を、画面の縁から内側へ置く距離（px）。点の半径（5px）が画面の外へはみ出さない大きさ
const EDGE_INSET = 12;
// この距離（px）以内に並ぶ縁の点は 1 つにまとめる。点の直径（10px）の 2 倍強で、重ならず隣り合う間隔
const MERGE_DISTANCE = 24;

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

// 最後の反映で変わったノード全部の寄せ先と、下限でも収まらないときの中心にするノード（最後に変わったノード。変わったものの外でもよい。無ければ寄せ先の最後）。
// 畳みで隠れたノードは、畳みを解かず、shownAs の見えている代わりのノードに置き換える。ノードに無い id は除く。変わったノードが無ければ null
export function changedFocus(snapshot: Snapshot, shownAs: Readonly<Record<string, string>>): { ids: string[]; center: string } | null {
  const present = new Set(snapshot.nodes.map((n) => n.id));
  const changed = [...changedNodeIds(snapshot)].filter((id) => present.has(id));
  if (changed.length === 0) return null;
  const shownId = (id: string) => shownAs[id] ?? id;
  const ids = [...new Set(changed.map(shownId))];
  const last = snapshot.lastChanged !== undefined ? shownId(snapshot.lastChanged) : ids[ids.length - 1]!;
  return { ids, center: last };
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

// rects の外接箱が（余白込みで）収まる倍率（minZoom〜MAX_ZOOM。既定の下限は MIN_ZOOM）で、画面の中央に映す。
// minZoom でも収まらないときは、center の中心を画面の中央にする。画面座標は 座標 × zoom + x（y）
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

// rects の外接箱と、それが（余白込みで）画面に収まる倍率（範囲に収める前）
function fitBox(rects: Rect[], size: Size) {
  const { left, top, right, bottom } = boundsOf(rects);
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

// ピンチ（Ctrl 付きの wheel）の倍率（@xyflow の wheelDelta と同じ式）。今の倍率に 2^(-deltaY × 係数 × Mac の Ctrl なら 10) を掛ける。係数は deltaMode が行（1）なら 0.05、ページ（2）なら 1、ピクセル（0）なら 0.002
const PINCH_DELTA_FACTOR = { line: 0.05, page: 1, pixel: 0.002 };
const PINCH_MAC_CTRL_MULTIPLIER = 10;

export function pinchZoomFactor(wheel: { deltaY: number; deltaMode: number; ctrlKey: boolean }, isMac: boolean): number {
  const perDelta = wheel.deltaMode === 1 ? PINCH_DELTA_FACTOR.line : wheel.deltaMode ? PINCH_DELTA_FACTOR.page : PINCH_DELTA_FACTOR.pixel;
  return 2 ** (-wheel.deltaY * perDelta * (isMac && wheel.ctrlKey ? PINCH_MAC_CTRL_MULTIPLIER : 1));
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

// 二本指スクロール（@xyflow の createPanOnScrollHandler と同じ式）。画面上の移動量は delta × 0.5 で、倍率に依らない
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

// ids のうち画面の外にあるノードを、画面の中心からノードの中心へ向かう線と、縁から EDGE_INSET だけ内側の四角との交点に置く。
// 画面と一部でも重なるノードは含めない。近い点は 1 つにまとめる（id は画面の中心に一番近いノード、ids はまとめた全部）。
// 位置は目標の位置と高さで測る。x・y は画面座標（map 要素の左上が原点）で点の中心
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

// 点を押したノードへ寄る。今の倍率のまま（MIN_ZOOM 未満なら MIN_ZOOM にして）、ノードの中心を画面の中央に置く
export function nodeFocusViewport(rect: Rect, zoom: number, size: Size): Viewport {
  const z = Math.max(MIN_ZOOM, zoom);
  return { x: size.width / 2 - (rect.x + rect.width / 2) * z, y: size.height / 2 - (rect.y + rect.height / 2) * z, zoom: z };
}

// 選んだノード id と、見せるノードのうちその子孫が収まるまで寄る（倍率は 0.5〜2 倍）。目標の位置で測った外接箱の中心を画面の中央に置く。
// 0.5 倍でも収まらないときは、0.5 倍で選んだノードの中心を画面の中央に置く。id は見せるノードであること（呼び出し側が確かめる）
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

// 列を出したあと（size は出した後の画面の大きさ）、rects の外接箱が画面の左右で切れているときだけ、切れた分を横にずらす。
// 倍率・縦の位置は変えない。反対側を新たに切るほどはずらさない（右が切れていれば左端が 0 に来るまで、左が切れていれば右端が幅に来るまで）。
// 両端とも切れている、または rects が空なら、そのまま返す。画面座標は 座標 × zoom + x
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

// ノードが画面の外にはみ出していれば、倍率は変えず、はみ出した分だけ最小限ずらして入れる（中央へは寄せない・余白は足さない）。
// 中にあれば動かさない。画面より大きい軸は左端・上端を 0 に合わせる。画面座標は 座標 × zoom + x
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

// 座標 position が今の viewport で映る画面座標（map 要素の左上が原点）
export function screenPoint(viewport: Viewport, position: Position): { x: number; y: number } {
  return { x: position.x * viewport.zoom + viewport.x, y: position.y * viewport.zoom + viewport.y };
}

// 座標 position のノードが、画面座標 anchor に映るように位置を合わせる。倍率は変えない
export function anchoredViewport(viewport: Viewport, position: Position, anchor: { x: number; y: number }): Viewport {
  return { x: anchor.x - position.x * viewport.zoom, y: anchor.y - position.y * viewport.zoom, zoom: viewport.zoom };
}

// 今の round に変わったノードが無く、すでにこの round より前に寄せていれば動かさない。
// 同じ round の測り直し（実寸が届いた）では寄せ直す
export function shouldMoveCamera(snapshot: Snapshot, placedRound: number | null): boolean {
  if (placedRound === null || placedRound === snapshot.round) return true;
  return snapshot.lastChanged !== undefined || snapshot.changes.some((c) => c.round === snapshot.round);
}

// 全体を収めるときの余白の割合（@xyflow の fitView({ padding: 0.1 }) と同じ）
const FIT_PADDING = 0.1;

// 余白（px）。@xyflow の parsePadding と同じく、画面の辺から (辺 − 辺 / (1 + padding)) の半分を切り捨てる
const fitPadding = (side: number): number => Math.floor((side - side / (1 + FIT_PADDING)) * 0.5);

// rects の外接箱を、余白 0.1 で画面に収める。@xyflow の fitView（getViewportForBounds）と同じ式:
// 倍率は minZoom〜maxZoom に収め、箱の中心を画面の中央に置く。切り捨てた余白の分だけ、辺ごとに足りない余白を位置で補う。
// 箱が 1 つも無いときは null
export function fitViewport(rects: readonly Rect[], size: Size, minZoom: number, maxZoom: number): Viewport | null {
  if (rects.length === 0) return null;
  const { left, top, right, bottom } = boundsOf(rects);
  const padX = fitPadding(size.width);
  const padY = fitPadding(size.height);
  const fitZoom = Math.min((size.width - padX * 2) / (right - left), (size.height - padY * 2) / (bottom - top));
  const zoom = Math.min(maxZoom, Math.max(minZoom, fitZoom));
  const x = size.width / 2 - ((left + right) / 2) * zoom;
  const y = size.height / 2 - ((top + bottom) / 2) * zoom;
  // 今の位置で実際に残る余白（箱の各辺と画面の各辺の間。切り捨て）が、必要な余白に足りない分
  const shortLeft = Math.min(Math.floor(left * zoom + x) - padX, 0);
  const shortTop = Math.min(Math.floor(top * zoom + y) - padY, 0);
  const shortRight = Math.min(Math.floor(size.width - (right * zoom + x)) - padX, 0);
  const shortBottom = Math.min(Math.floor(size.height - (bottom * zoom + y)) - padY, 0);
  return { x: x - shortLeft + shortRight, y: y - shortTop + shortBottom, zoom };
}
