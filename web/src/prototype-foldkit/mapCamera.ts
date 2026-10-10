// 試作（Issue #736）: マップの表示面のカメラ。React 版の MapView.tsx が effect の順序で行っていた
// 「反映 → 今の議題へ寄せる・全体に収める・位置を保つ・列のずらし」を、Model を受けて Model を返す関数にした。計算は camera.ts をそのまま使う
import {
  anchoredViewport,
  cameraFocus,
  clampUserZoom,
  focusViewport,
  nodeFocusViewport,
  nodeRect,
  OVERVIEW_MIN_ZOOM,
  overviewViewport,
  panViewport,
  revealViewport,
  screenPoint,
  shiftIntoView,
  shouldMoveCamera,
  subtreeViewport,
  USER_MAX_ZOOM,
  USER_MIN_ZOOM,
  zoomAroundCenter,
  type Viewport,
} from "../camera.ts";
import { keepTargetOf } from "../folding.ts";
import { DEFAULT_HEIGHT, NODE_WIDTH } from "../layout.ts";
import { interpolate, startPositions } from "../motion.ts";
import { reduceViewing, type CameraCommand, type ViewingEvent, type ViewingState } from "../viewing.ts";
import { derive, type Model, type Positions } from "./model.ts";

const DURATION_MS = 500;
// 今の議題が無いときの全体の収め方（React Flow の fitView の padding 0.1 と同じ式）
const FIT_PADDING = 0.1;

const samePositions = (a: Positions, b: Positions): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k]?.x === b[k]?.x && a[k]?.y === b[k]?.y);
};

// 導く値を作り直し、目標が変わっていれば、いま表示している位置から補間を始める（新しいノードは祖先の位置から）
export function rederive(m: Model, snapshot = m.d.snapshot): Model {
  const d = derive(snapshot, m.viewing, m.dims);
  const start = startPositions(d.nodes, m.shown, d.target);
  return { ...m, d, shown: start, anim: samePositions(start, d.target) ? null : { from: start, to: d.target, elapsed: 0 } };
}

const isPaused = (v: ViewingState) => v.mode !== "auto";

// 今の議題が無いときに全体を収める（補間中の位置で測る）
function fitShown(m: Model): Viewport {
  const ids = Object.keys(m.shown);
  if (ids.length === 0) return m.viewport;
  const rects = ids.map((id) => ({ x: m.shown[id]!.x, y: m.shown[id]!.y, h: m.dims[id]?.height ?? DEFAULT_HEIGHT }));
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const width = Math.max(...rects.map((r) => r.x + NODE_WIDTH)) - left;
  const height = Math.max(...rects.map((r) => r.y + r.h)) - top;
  const fit = Math.min(m.size.width / (width * (1 + FIT_PADDING)), m.size.height / (height * (1 + FIT_PADDING)));
  const zoom = Math.min(USER_MAX_ZOOM, Math.max(USER_MIN_ZOOM, fit));
  return { x: m.size.width / 2 - (left + width / 2) * zoom, y: m.size.height / 2 - (top + height / 2) * zoom, zoom };
}

// 寄せ先の外接箱。見せないノードは、隠している畳んだノード・まとめのノードで測る
function focusRects(m: Model, focus: { ids: string[]; center: string }) {
  const shownId = (id: string) => m.d.view.shownAs[id] ?? id;
  return {
    rects: [...new Set(focus.ids.map(shownId))].map((id) => nodeRect(id, m.d.target, m.dims)),
    center: nodeRect(shownId(focus.center), m.d.target, m.dims),
  };
}

// 自動のカメラ。自動なら今の議題へ寄せ（同じ round で寄せ済みでも、変化が無ければ動かさない）、全体を見ているなら全体に収める。
// React 版の「反映・目標・実寸・指示の番号が変わるたびに走る effect」に当たり、呼ぶ側がそのきっかけで呼ぶ
export function autoCamera(m: Model): Model {
  if (m.size.width === 0) return m;
  if (m.viewing.mode === "overview") {
    if (m.keepAnchor) return m;
    const v = overviewViewport(m.d.tree.ids, m.d.target, m.dims, m.size);
    return v ? { ...m, viewport: v } : m;
  }
  if (isPaused(m.viewing)) return m;
  const focus = cameraFocus(m.d.snapshot);
  if (!focus) return { ...m, placedRound: null, viewport: fitShown(m) };
  if (!shouldMoveCamera(m.d.snapshot, m.placedRound)) return m;
  const boxes = focusRects(m, focus);
  return { ...m, placedRound: m.d.snapshot.round, viewport: focusViewport(boxes.rects, boxes.center, m.size) };
}

// 位置を保つ基準があれば、そのノードが基準の画面座標に映るよう合わせる
export function reanchor(m: Model): Model {
  const at = m.keepAnchor ? m.shown[m.keepAnchor.id] : undefined;
  return m.keepAnchor && at ? { ...m, viewport: anchoredViewport(m.viewport, at, m.keepAnchor.point) } : m;
}

// キーなどの指示を実行する。prevShown は出来事の前の表示位置（開閉の後に位置を保つ基準を作る）
function applyCommand(m: Model, command: CameraCommand, prevShown: Positions): Model {
  const { size, viewport: current } = m;
  const next: Model = { ...m, pendingShift: command.type === "shiftIntoView", keepAnchor: null };
  const userRange = () => zoomAroundCenter(current, clampUserZoom(current.zoom), size);
  switch (command.type) {
    case "zoomBy":
      return { ...next, viewport: zoomAroundCenter(current, clampUserZoom(current.zoom * command.factor), size) };
    case "zoomTo":
      return { ...next, viewport: zoomAroundCenter(current, clampUserZoom(command.zoom), size) };
    case "pan":
      return { ...next, viewport: panViewport(userRange(), command, size) };
    case "focusNode":
      return { ...next, viewport: nodeFocusViewport(nodeRect(command.id, m.d.target, m.dims), current.zoom, size) };
    case "revealNode":
      return { ...next, viewport: revealViewport(userRange(), nodeRect(command.id, m.d.target, m.dims), size) };
    case "fitSubtree":
      return { ...next, viewport: subtreeViewport(command.id, m.d.tree, m.d.target, m.dims, size) };
    case "keepNode": {
      const at = prevShown[command.id] ?? m.shown[command.id];
      return at ? { ...next, keepAnchor: { id: keepTargetOf(m.d.view, command.id), point: screenPoint(current, at) } } : next;
    }
    case "restore":
      return { ...next, beforeOverview: null, viewport: m.beforeOverview ?? current };
    case "refocus":
      return { ...next, placedRound: null };
    default:
      return next;
  }
}

// 見る状態への出来事 1 つ。reducer の結果で見せ方を作り直し、カメラへの指示を実行し、自動のカメラと位置を保つ基準を当て直す
export function viewingEvent(m: Model, event: ViewingEvent): Model {
  const out = reduceViewing(m.viewing, event, m.d.tree, "review");
  const before = m.viewing;
  const after = out.state;
  let next: Model = { ...m, viewing: after, idleSeq: event.type === "side" || event.type === "captions" || event.type === "select" ? m.idleSeq : m.idleSeq + 1 };
  if (after.mode === "overview" && before.mode !== "overview") next.beforeOverview = m.viewport;
  if (after.mode !== "overview" && before.mode === "overview" && out.camera.type !== "restore") next.beforeOverview = null;
  const viewChanged =
    before.selection?.id !== after.selection?.id || before.humanOpened !== after.humanOpened || before.humanFolded !== after.humanFolded || before.humanUnbundled !== after.humanUnbundled;
  if (viewChanged) next = rederive(next);
  next = applyCommand(next, out.camera, m.shown);
  if (viewChanged || (out.camera.type !== "shiftIntoView" && out.camera.type !== "keepNode")) next = autoCamera(next);
  return reanchor(next);
}

// 人が動かした。viewport は動かした後の位置。全体を見ていて 0.5 未満の倍率だったら、人の範囲に収める
export function userMove(m: Model, viewport: Viewport): Model {
  const next = viewingEvent({ ...m, keepAnchor: null, viewport }, { type: "userMoved" });
  const zoom = clampUserZoom(next.viewport.zoom);
  return zoom === next.viewport.zoom ? next : { ...next, viewport: zoomAroundCenter(next.viewport, zoom, m.size) };
}

// 画面上の point を保って倍率を ratio 倍にする（全体を見ている間は下限 0.02、ふだんは 0.5）
export function zoomAt(m: Model, point: { x: number; y: number }, ratio: number): Viewport {
  const v = m.viewport;
  const min = m.viewing.mode === "overview" ? OVERVIEW_MIN_ZOOM : USER_MIN_ZOOM;
  const zoom = Math.min(USER_MAX_ZOOM, Math.max(min, v.zoom * ratio));
  const wx = (point.x - v.x) / v.zoom;
  const wy = (point.y - v.y) / v.zoom;
  return { x: point.x - wx * zoom, y: point.y - wy * zoom, zoom };
}

// 補間を dt だけ進め、位置を保つ基準と、今の議題が無いときの全体の収め直しを当てる
export function advanceFrame(m: Model, dt: number): Model {
  if (!m.anim) return m;
  const elapsed = m.anim.elapsed + dt;
  const t = Math.min(1, elapsed / DURATION_MS);
  let next: Model = { ...m, shown: t >= 1 ? m.anim.to : interpolate(m.anim.from, m.anim.to, t), anim: t >= 1 ? null : { ...m.anim, elapsed } };
  next = reanchor(next);
  if (!isPaused(next.viewing) && cameraFocus(next.d.snapshot) === null) next = autoCamera(next);
  return next;
}

// マップの大きさが変わった。列を出した後のずらしの保留があれば、今の議題が端で切れる分だけ横にずらす（隠したときはずらさない）
export function resized(m: Model, size: { width: number; height: number }): Model {
  const first = m.size.width === 0;
  let next: Model = { ...m, size };
  if (first) return autoCamera(next);
  if (!next.pendingShift || size.width === m.size.width) return next;
  next = { ...next, pendingShift: false };
  const focus = cameraFocus(next.d.snapshot);
  if (next.viewing.sideHidden || !focus) return next;
  return { ...next, viewport: shiftIntoView(next.viewport, focusRects(next, focus).rects, size) };
}
