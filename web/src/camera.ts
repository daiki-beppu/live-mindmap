import { Option, Schema } from "effect";
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

  const normalChange = [...changedNodeIds(snapshot)].findLast((id) => byId.has(id) && byId.get(id)!.kind !== "補足");
  const center = snapshot.lastChanged !== undefined && byId.get(snapshot.lastChanged)?.kind !== "補足" ? snapshot.lastChanged : normalChange ?? topic;
  return { ids: [...ids], center };
}

export function changedFocus(snapshot: Snapshot, shownIdOf: (id: string) => string): { ids: string[]; center: string } | null {
  const present = new Set(snapshot.nodes.filter((n) => n.kind !== "補足").map((n) => n.id));
  const changed = [...changedNodeIds(snapshot)].filter((id) => present.has(id));
  if (changed.length === 0) return null;
  const ids = [...new Set(changed.map(shownIdOf))];
  const last = snapshot.lastChanged !== undefined && present.has(snapshot.lastChanged) ? shownIdOf(snapshot.lastChanged) : ids[ids.length - 1]!;
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


export const Camera = Schema.Struct({
  mode: Schema.Literals(["auto", "manual", "overview", "diff"]),
  topic: Schema.UndefinedOr(Schema.String),
  viewport: Schema.Struct({ x: Schema.Finite, y: Schema.Finite, zoom: Schema.Finite }),
  placedRound: Schema.Option(Schema.Finite),
  keepAnchor: Schema.Option(Schema.Struct({ id: Schema.String, point: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }) })),
  pendingShift: Schema.Boolean,
});
export type Camera = typeof Camera.Type;

export const initialCamera = (): Camera => ({ mode: "auto", topic: undefined, viewport: { x: 0, y: 0, zoom: 1 }, placedRound: Option.none(), keepAnchor: Option.none(), pendingShift: false });

export type CameraInput =
  | { type: "selectedByKey"; id: string }
  | { type: "toggledFold"; id: string }
  | { type: "pointedNode"; id: string }
  | { type: "selectedSubtree"; id: string }
  | { type: "viewKey"; key: "=" | "-" | "0" | "Shift+ArrowLeft" | "Shift+ArrowRight" | "Shift+ArrowUp" | "Shift+ArrowDown" }
  | { type: "toggledOverview" }
  | { type: "escaped" }
  | { type: "toggledSide" }
  | { type: "reflected" }
  | { type: "elapsedIdle" }
  | { type: "movedTime" }
  | { type: "unrelated" }
  | { type: "measured"; heightsChanged: boolean }
  | { type: "replacedSnapshot" }
  | { type: "frame" }
  | { type: "movedByUser"; viewport: Viewport };

type Focus = NonNullable<ReturnType<typeof cameraFocus>>;
export type CameraSeen = {
  scope: "still" | "live" | "review";
  currentTopic: string | undefined;
  round: number;
  hasChanges: boolean;
  sideHidden: boolean;
  size: Option.Option<Size>;
  targets: Record<string, Position>;
  positions: Record<string, Position>;
  dims: Record<string, { height: number }>;
  ids: string[];
  parents: Record<string, string | null>;
  shownIdOf: (id: string) => string;
  focus: Focus | null;
  changed: Focus | null;
};

type Placement = "topic" | "refocus" | "unchanged" | "all" | "changes" | "input";
type Decision = { mode: Camera["mode"]; placement: Placement; reset: "keep" | "clear" | "refocus" | "side"; topic: "keep" | "current" | "clear" };
const decision = (mode: Camera["mode"], placement: Placement, reset: Decision["reset"], topic: Decision["topic"]): Decision => ({ mode, placement, reset, topic });

const clampedViewport = (viewport: Viewport, size: Size): Viewport => zoomAroundCenter(viewport, clampUserZoom(viewport.zoom), size);
const boxesOf = (seen: CameraSeen, focus: Focus) => ({ rects: focus.ids.map((id) => nodeRect(id, seen.targets, seen.dims)), center: nodeRect(focus.center, seen.targets, seen.dims) });
const fittedOf = (seen: CameraSeen, size: Size): Viewport =>
  fitViewport(seen.ids.filter((id) => seen.dims[id] !== undefined).map((id) => nodeRect(id, seen.positions, seen.dims)), size, seen.scope === "still" ? OVERVIEW_MIN_ZOOM : USER_MIN_ZOOM, USER_MAX_ZOOM) ?? { x: 0, y: 0, zoom: 1 };

function placeCamera(camera: Camera, placement: Placement, seen: CameraSeen): Camera {
  if (Option.isNone(seen.size) || placement === "unchanged" || placement === "input") return camera;
  const size = seen.size.value;
  if (seen.scope === "still") return { ...camera, viewport: fittedOf(seen, size) };
  if (placement === "all") {
    if (Option.isSome(camera.keepAnchor)) return camera;
    const viewport = overviewViewport(seen.ids, seen.targets, seen.dims, size);
    return viewport === null ? camera : { ...camera, viewport };
  }
  if (placement === "changes") {
    if (Option.isSome(camera.keepAnchor) || seen.changed === null) return camera;
    const boxes = boxesOf(seen, seen.changed);
    return { ...camera, viewport: focusViewport(boxes.rects, boxes.center, size, USER_MIN_ZOOM) };
  }
  if (seen.focus === null) return { ...camera, placedRound: Option.none(), viewport: fittedOf(seen, size) };
  const placed = Option.getOrNull(camera.placedRound);
  if (placement === "topic" && placed !== null && placed !== seen.round && !seen.hasChanges) return camera;
  const boxes = boxesOf(seen, seen.focus);
  return { ...camera, placedRound: Option.some(seen.round), viewport: focusViewport(boxes.rects, boxes.center, size) };
}

function reanchor(camera: Camera, seen: CameraSeen): Camera {
  if (Option.isNone(camera.keepAnchor)) return camera;
  const { id, point } = camera.keepAnchor.value;
  const at = seen.positions[seen.shownIdOf(seen.shownIdOf(id))];
  return at === undefined ? camera : { ...camera, viewport: anchoredViewport(camera.viewport, at, point) };
}

function keyViewport(viewport: Viewport, key: Extract<CameraInput, { type: "viewKey" }>["key"], size: Size): Viewport {
  switch (key) {
    case "=": return zoomAroundCenter(viewport, clampUserZoom(viewport.zoom * 1.25), size);
    case "-": return zoomAroundCenter(viewport, clampUserZoom(viewport.zoom / 1.25), size);
    case "0": return zoomAroundCenter(viewport, clampUserZoom(1), size);
    case "Shift+ArrowLeft": return panViewport(clampedViewport(viewport, size), { dx: -1, dy: 0 }, size);
    case "Shift+ArrowRight": return panViewport(clampedViewport(viewport, size), { dx: 1, dy: 0 }, size);
    case "Shift+ArrowUp": return panViewport(clampedViewport(viewport, size), { dx: 0, dy: -1 }, size);
    case "Shift+ArrowDown": return panViewport(clampedViewport(viewport, size), { dx: 0, dy: 1 }, size);
  }
}

function applyInput(camera: Camera, input: CameraInput, previous: CameraSeen, seen: CameraSeen): Camera {
  if (input.type === "movedByUser") return { ...camera, viewport: Option.isNone(seen.size) ? input.viewport : clampedViewport(input.viewport, seen.size.value) };
  if (Option.isNone(seen.size)) return camera;
  const size = seen.size.value;
  switch (input.type) {
    case "selectedByKey": return { ...camera, viewport: revealViewport(clampedViewport(camera.viewport, size), nodeRect(input.id, seen.targets, seen.dims), size) };
    case "pointedNode": return { ...camera, viewport: nodeFocusViewport(nodeRect(input.id, seen.targets, seen.dims), camera.viewport.zoom, size) };
    case "selectedSubtree": return { ...camera, viewport: subtreeViewport(input.id, seen, seen.targets, seen.dims, size) };
    case "viewKey": return { ...camera, viewport: keyViewport(camera.viewport, input.key, size) };
    case "toggledFold": {
      const at = previous.positions[input.id] ?? seen.positions[input.id];
      return at === undefined ? camera : { ...camera, keepAnchor: Option.some({ id: seen.shownIdOf(input.id), point: screenPoint(camera.viewport, at) }) };
    }
    default: return camera;
  }
}

function measuredCamera(camera: Camera, placement: Placement, input: Extract<CameraInput, { type: "measured" }>, previous: CameraSeen, seen: CameraSeen): Camera {
  const widthChanged = Option.isSome(seen.size) && (Option.isNone(previous.size) || previous.size.value.width !== seen.size.value.width);
  const sizeChanged = Option.isSome(seen.size) && (Option.isNone(previous.size) || previous.size.value.width !== seen.size.value.width || previous.size.value.height !== seen.size.value.height);
  const changed = Option.isNone(previous.size) || (!(camera.pendingShift && widthChanged) && sizeChanged) || input.heightsChanged;
  const placed = reanchor(changed ? placeCamera(camera, placement, seen) : camera, seen);
  if (!placed.pendingShift || !widthChanged || Option.isNone(seen.size)) return placed;
  const settled = { ...placed, pendingShift: false, keepAnchor: Option.none() };
  return seen.scope === "still" || seen.sideHidden || seen.focus === null ? settled : { ...settled, viewport: shiftIntoView(settled.viewport, boxesOf(seen, seen.focus).rects, seen.size.value) };
}

const topicPlacement = (previous: CameraSeen, seen: CameraSeen): "topic" | "refocus" =>
  previous.ids.length !== seen.ids.length || seen.ids.some((id) => previous.targets[id]?.x !== seen.targets[id]!.x || previous.targets[id]?.y !== seen.targets[id]!.y) ? "refocus" : "topic";

export function stepCamera(camera: Camera, input: CameraInput, previous: CameraSeen, seen: CameraSeen): Camera {
  const automatic = decision("auto", "topic", "clear", "clear");
  const refocused = decision("auto", "topic", "refocus", "clear");
  const manualInput = decision("manual", "input", "clear", "current");
  const settled = {
    auto: automatic,
    manual: decision("manual", "unchanged", "clear", "keep"),
    overview: decision("overview", "all", "clear", "keep"),
    diff: decision("diff", "changes", "clear", "keep"),
  };
  const retained = {
    auto: decision("auto", "topic", "keep", "keep"),
    manual: decision("manual", "unchanged", "keep", "keep"),
    overview: decision("overview", "all", "keep", "keep"),
    diff: decision("diff", "changes", "keep", "keep"),
  };
  const allManual = { auto: manualInput, manual: manualInput, overview: manualInput, diff: manualInput };
  const fold = (mode: Camera["mode"]) => decision(mode, "input", "clear", "keep");
  const side = (mode: Camera["mode"]) => decision(mode, "unchanged", "side", "keep");
  const unrelated = (mode: Camera["mode"]) => camera.pendingShift ? decision(mode, "unchanged", "keep", "keep") : mode === "auto" ? decision("auto", topicPlacement(previous, seen), "clear", "clear") : retained[mode];
  const reflected = (mode: "manual" | "overview" | "diff") => seen.currentTopic !== camera.topic ? refocused : settled[mode];
  const overview = decision("overview", "all", "clear", "current");
  const table: Record<CameraInput["type"], Record<Camera["mode"], Decision>> = {
    selectedByKey: allManual,
    pointedNode: allManual,
    selectedSubtree: allManual,
    viewKey: allManual,
    movedByUser: allManual,
    toggledOverview: { auto: overview, manual: overview, overview: seen.changed === null ? refocused : decision("diff", "changes", "clear", "current"), diff: overview },
    escaped: { auto: refocused, manual: refocused, overview: refocused, diff: refocused },
    reflected: { auto: automatic, manual: reflected("manual"), overview: reflected("overview"), diff: reflected("diff") },
    toggledFold: { auto: refocused, manual: fold("manual"), overview: fold("overview"), diff: fold("diff") },
    toggledSide: { auto: side("auto"), manual: side("manual"), overview: side("overview"), diff: side("diff") },
    elapsedIdle: { ...settled, manual: seen.scope === "review" ? refocused : settled.manual },
    movedTime: { auto: decision("auto", "unchanged", "keep", "keep"), manual: seen.scope === "review" ? refocused : settled.manual, overview: seen.scope === "review" ? refocused : settled.overview, diff: seen.scope === "review" ? refocused : settled.diff },
    unrelated: { auto: unrelated("auto"), manual: unrelated("manual"), overview: unrelated("overview"), diff: unrelated("diff") },
    measured: { ...retained, auto: decision("auto", "refocus", "keep", "keep") },
    replacedSnapshot: retained,
    frame: { ...retained, auto: { ...retained.auto, placement: seen.scope !== "still" && seen.focus === null ? "topic" : "unchanged" }, overview: { ...retained.overview, placement: "unchanged" }, diff: { ...retained.diff, placement: "unchanged" } },
  };
  const rule = table[input.type][camera.mode];
  const next: Camera = {
    ...camera,
    mode: rule.mode,
    topic: rule.topic === "clear" ? undefined : rule.topic === "current" ? seen.currentTopic : camera.topic,
    pendingShift: rule.reset === "keep" ? camera.pendingShift : rule.reset === "side",
    keepAnchor: rule.reset === "keep" ? camera.keepAnchor : Option.none(),
    placedRound: rule.reset === "refocus" ? Option.none() : camera.placedRound,
  };
  if (input.type === "measured") return measuredCamera(next, rule.placement, input, previous, seen);
  return reanchor(rule.placement === "input" ? applyInput(next, input, previous, seen) : placeCamera(next, rule.placement, seen), seen);
}
