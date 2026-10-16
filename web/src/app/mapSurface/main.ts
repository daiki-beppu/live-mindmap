// マップの表示面（Issue #814・#816・#819）: Foldkit のプログラム。ノード（絶対配置の div）・エッジ（SVG のベジェ）・ビューポート（transform）を素で描く。
// 配置（layout）・畳み（foldView）は既存の純粋な関数で、view が毎回、Model の値から導く（Model には持たない）。
// カメラ（寄せる・全体を収める・ずらす・位置を保つ）の目標も、元の値から純粋な関数（camera.ts）で毎回計算し、Model には置かない
import { HashMap, Option, Schema } from "effect";
import { Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { Snapshot, type SnapshotNode } from "../../../../server/src/core/index.ts";
import { personLine } from "../../people.ts";
import {
  anchoredViewport,
  cameraFocus,
  changedFocus,
  clampUserZoom,
  CLICK_ZOOM_FACTOR,
  edgeDots,
  fitViewport,
  focusViewport,
  nodeFocusViewport,
  nodeRect,
  OVERVIEW_MIN_ZOOM,
  overviewViewport,
  panViewport,
  pinchZoomFactor,
  revealViewport,
  screenPoint,
  scrollAlongAxis,
  scrollAxis,
  scrollPanDelta,
  shiftIntoView,
  shouldMoveCamera,
  subtreeViewport,
  USER_MAX_ZOOM,
  USER_MIN_ZOOM,
  zoomAroundCenter,
  zoomAtPoint,
  type Rect,
  type Viewport,
} from "../../camera.ts";
import { FOLD_DOT_CLASSES, MAP_NODE_BUTTON_CLASS } from "../../enterFold.ts";
import { foldView, keepTargetOf, pointedNode, type FoldView } from "../../folding.ts";
import { KIND_COLOR, markOf } from "../../kinds.ts";
import { layout, NODE_WIDTH, type Position } from "../../layout.ts";
import { interpolate, startPositions } from "../../motion.ts";
import { relocations } from "../../relocation.ts";
import { type ArrowDir, type CameraCommand, foldToggle, humanSetsOf, INITIAL_VIEWING, reduceViewing, ViewingState, type ViewingEvent, type ViewKey, type VisibleTree } from "../../viewing.ts";
import { RestartBlink } from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import { ObserveMapSurface } from "./mount.ts";

// still は map.png の撮影用で、畳まず、大きなマップも全体を収める。live は会議中、review は見返しで、どちらも畳み、倍率を人の範囲に収める（review だけ、止めて 10 秒で自動に戻る）
// 動きの状態（Issue #817）: motion は差分更新や高さの変化で目標の位置が変わったときの補間で、start は補間の始まりの位置（id → 位置）、elapsedMs は始めてからの経過 ms。補間していないときは None。
// 表示する位置と目標の位置は Model に持たず、displayedPositions が motion と目標から毎回導く
// 見る状態（Issue #818）: viewing は選んだノードと人が開いた・畳んだ・解いた集合とカメラの状態（自動・止めている・全体を見ている）。意味は reduceViewing が決め、update が Message から出来事を作って渡す
// パンの状態: pointer は押している間の相手、nodePress はノードのボタンを押した記録（click で使い切る）、scrollAxisLock は軸固定の軸
// ズームの状態（Issue #816）: gestureScale は Safari の gesture の前回の累積 scale（update が前回との比を求めるのに使う。始まりの前・外れたら None）
// カメラの状態（Issue #819）: viewport は今見せているビューポート（人が置いた位置は入力の履歴で決まり、他の欄から導けないので持つ）。
// 以下は出来事の履歴で決まる事実: placedRound は今の議題へ寄せた round（変化の無い反映で寄せ直さないため）、
// keepAnchor は人の開閉の後も同じ画面座標に映し続けるノード、pendingShift は列を出したあと画面の幅が変わるのを待っているずらし。
// idleStamp は見る状態を動かす出来事（E・C・選択を除く）のたびに進む通し番号で、見返しの 10 秒を計り直す依存になる
export const Model = Schema.Struct({
  mode: Schema.Literals(["still", "live", "review"]),
  snapshot: Snapshot,
  size: Schema.Option(Schema.Struct({ width: Schema.Finite, height: Schema.Finite })),
  nodeHeights: Schema.HashMap(Schema.String, Schema.Finite),
  isMac: Schema.Boolean,
  pointer: Schema.Option(Schema.Union([Schema.TaggedStruct("PanningPane", { x: Schema.Finite, y: Schema.Finite, button: Schema.Finite }), Schema.TaggedStruct("HoldingNode", {})])),
  nodePress: Schema.Option(Schema.Struct({ nodeId: Schema.String, x: Schema.Finite, y: Schema.Finite, dragged: Schema.Boolean })),
  scrollAxisLock: Schema.Option(Schema.Struct({ axis: Schema.Literals(["x", "y"]), at: Schema.Finite })),
  motion: Schema.Option(Schema.Struct({ start: Schema.HashMap(Schema.String, Schema.Struct({ x: Schema.Finite, y: Schema.Finite })), elapsedMs: Schema.Finite })),
  viewing: ViewingState,
  gestureScale: Schema.Option(Schema.Finite),
  viewport: Schema.Struct({ x: Schema.Finite, y: Schema.Finite, zoom: Schema.Finite }),
  placedRound: Schema.Option(Schema.Finite),
  keepAnchor: Schema.Option(Schema.Struct({ id: Schema.String, point: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }) })),
  pendingShift: Schema.Boolean,
  idleStamp: Schema.Finite,
});
export type Model = typeof Model.Type;

const IDENTITY: Viewport = { x: 0, y: 0, zoom: 1 };

export const init = (snapshot: Snapshot, mode: Model["mode"], isMac: boolean): Model => ({
  mode,
  snapshot,
  size: Option.none(),
  nodeHeights: HashMap.empty(),
  isMac,
  pointer: Option.none(),
  nodePress: Option.none(),
  scrollAxisLock: Option.none(),
  motion: Option.none(),
  viewing: INITIAL_VIEWING,
  gestureScale: Option.none(),
  viewport: IDENTITY,
  placedRound: Option.none(),
  keepAnchor: Option.none(),
  pendingShift: false,
  idleStamp: 0,
});

// 補間の長さ（ms）。React 版（useAnimatedPositions、Issue #829 で削除）から引き継いだ値
const MOTION_DURATION_MS = 500;

// 畳んだ見せ方。人が開いた・畳んだ・解いた集合と選んだノードを渡して導く。still は畳まない
const foldViewOf = (model: Model): FoldView | null => {
  if (model.mode === "still") return null;
  const { opened, folded, unbundled } = humanSetsOf(model.viewing);
  return foldView(model.snapshot, opened, model.viewing.selection?.id ?? null, folded, unbundled);
};
// 畳んだ後に見せるノード
const shownNodesOf = (model: Model): SnapshotNode[] => foldViewOf(model)?.nodes ?? model.snapshot.nodes;
// 測ったノードの高さは実際の高さ（小数）。配置とカメラは @xyflow と同じく offsetHeight（整数に丸めた高さ）で計算し、エッジの端点だけが小数のままの高さを使う
const heightsOf = (model: Model): Record<string, number> => Object.fromEntries(HashMap.toEntries(model.nodeHeights).map(([id, height]) => [id, Math.round(height)]));
// camera.ts の nodeRect などに渡す、ノードの id → { height }
const dimsOf = (model: Model): Record<string, { height: number }> => Object.fromEntries(Object.entries(heightsOf(model)).map(([id, height]) => [id, { height }]));
// 補間の行き先（目標の位置）
const targetOf = (model: Model): Record<string, Position> => layout(shownNodesOf(model), heightsOf(model));

// 見えている木。reduceViewing の入力で、丸を描くかの判定（foldToggle）にも同じものを使う。React 版（MapView、削除済み）から引き継いだ組み立て
const treeOf = (model: Model, view: FoldView | null = foldViewOf(model)): VisibleTree => {
  const shown = view?.nodes ?? model.snapshot.nodes;
  return {
    ids: shown.map((n) => n.id),
    targets: layout(shown, heightsOf(model)),
    parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])),
    foldState: view
      ? Object.fromEntries(shown.filter((n) => (n.kind === "議題" || n.kind === "論点") && !view.summaries.has(n.id)).map((n) => [n.id, n.id in view.folds ? "folded" : "open"]))
      : {},
    runs: view?.runs ?? {},
    changed: changedFocus(model.snapshot, view?.shownAs ?? {})?.ids ?? [],
    currentTopic: model.snapshot.currentTopic,
  };
};

// 今見せている位置。補間中は始まりと目標の間（easeOutCubic）、そうでなければ目標
export const displayedPositions = (model: Model): Record<string, Position> => {
  const target = targetOf(model);
  return Option.match(model.motion, {
    onNone: () => target,
    onSome: ({ start, elapsedMs }) => interpolate(Object.fromEntries(HashMap.toEntries(start)), target, elapsedMs / MOTION_DURATION_MS),
  });
};

const samePositions = (a: Record<string, Position>, b: Record<string, Position>): boolean => {
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every((id) => b[id] !== undefined && a[id]!.x === b[id].x && a[id]!.y === b[id].y);
};

// 更新で目標の位置が変わったら、その前に見せていた位置から補間を始める。still・目標が変わらないとき（大きさだけの測定など）は何もしない（補間中の経過も戻さない）
// 何も測っていない間はノードを見せていないので、始まりの位置が無く、動かさない
const followTarget = (before: Model, after: Model): Model => {
  if (after.mode === "still") return after;
  const target = targetOf(after);
  if (samePositions(targetOf(before), target)) return after;
  const shown = HashMap.size(before.nodeHeights) === 0 ? {} : displayedPositions(before);
  const start = startPositions(shownNodesOf(after), shown, target);
  return modifyFields(after, {
    motion: () => (samePositions(start, target) ? Option.none() : Option.some({ start: HashMap.fromIterable(Object.entries(start)), elapsedMs: 0 })),
  });
};

// --- カメラ（Issue #819）。update の中で、反映 → 寄せる → 位置を保つ → ずらす の順に、次の関数を呼ぶ ---

type Size = { width: number; height: number };

const setViewport = (model: Model, viewport: Viewport): Model => modifyFields(model, { viewport: () => viewport });

// 倍率の下限。still は全体を見るので OVERVIEW_MIN_ZOOM、それ以外は USER_MIN_ZOOM
const minZoomOf = (model: Model): number => (model.mode === "still" ? OVERVIEW_MIN_ZOOM : USER_MIN_ZOOM);

// 全体を収めた位置。測れたノードだけを、今見せている（補間中の）位置で収める。測れたノードが無ければ原点・倍率 1
const fittedOf = (model: Model, size: Size): Viewport => {
  const heights = heightsOf(model);
  const positions = displayedPositions(model);
  const rects = shownNodesOf(model)
    .filter((n) => HashMap.has(model.nodeHeights, n.id))
    .map((n): Rect => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: heights[n.id]! }));
  return fitViewport(rects, size, minZoomOf(model), USER_MAX_ZOOM) ?? IDENTITY;
};

// 全ノードを測り終えて、全体が画面に入っているか（撮影の ready / overflow）。画面の大きさが未測定、または見せるノードに未測定のものがあれば None。
// 箱は fittedOf と同じ（表示位置 × NODE_WIDTH × 丸めた高さ）を今の viewport で画面に写し、4 辺が画面の中に入るかを見る。ノードが 0 件なら入っている
export const fitsAllOf = (model: Model): Option.Option<boolean> => {
  if (Option.isNone(model.size)) return Option.none();
  const { width, height } = model.size.value;
  const shown = shownNodesOf(model);
  if (!shown.every((n) => HashMap.has(model.nodeHeights, n.id))) return Option.none();
  if (shown.length === 0) return Option.some(true);
  const heights = heightsOf(model);
  const positions = displayedPositions(model);
  const { x, y, zoom } = model.viewport;
  const left = Math.min(...shown.map((n) => positions[n.id]!.x));
  const top = Math.min(...shown.map((n) => positions[n.id]!.y));
  const right = Math.max(...shown.map((n) => positions[n.id]!.x + NODE_WIDTH));
  const bottom = Math.max(...shown.map((n) => positions[n.id]!.y + heights[n.id]!));
  return Option.some(left * zoom + x >= 0 && top * zoom + y >= 0 && right * zoom + x <= width && bottom * zoom + y <= height);
};

// 寄せ先の箱（今の議題の外接箱と、収まらないときの中心）。見せないノードは、それを隠している畳んだノード・まとめのノードに置き換えて測る（位置の無い ID は原点で測られる）。
// 補間中の位置ではなく目標の位置で測る。自動のカメラと、列で切れる分のずらしの両方が使う
const focusBoxesOf = (model: Model, focus: { ids: string[]; center: string }): { rects: Rect[]; center: Rect } => {
  const shownAs = foldViewOf(model)?.shownAs ?? {};
  const shownId = (id: string) => shownAs[id] ?? id;
  const target = targetOf(model);
  const dims = dimsOf(model);
  return { rects: [...new Set(focus.ids.map(shownId))].map((id) => nodeRect(id, target, dims)), center: nodeRect(shownId(focus.center), target, dims) };
};

// 差分を見ている間のカメラ: 最後の反映で変わったノード全部を、人の倍率の範囲で収める。位置を保っている間と、変わったノードが無い反映では動かさない
const diffCamera = (model: Model, size: Size): Model => {
  if (Option.isSome(model.keepAnchor)) return model;
  const changed = changedFocus(model.snapshot, foldViewOf(model)?.shownAs ?? {});
  if (changed === null) return model;
  const boxes = focusBoxesOf(model, changed);
  return setViewport(model, focusViewport(boxes.rects, boxes.center, size, USER_MIN_ZOOM));
};

// 自動のカメラ。止めている間は動かさず、全体を見ている間は全体を、差分を見ている間は変わったノードを、自動のときは今の議題（無ければ全体）を収める。still は常に全体
const autoCamera = (model: Model): Model => {
  if (Option.isNone(model.size)) return model;
  const size = model.size.value;
  if (model.mode === "still") return setViewport(model, fittedOf(model, size));
  if (model.viewing.mode === "manual") return model;
  if (model.viewing.mode === "overview") {
    // 位置を保っている間は収め直さない
    if (Option.isSome(model.keepAnchor)) return model;
    const viewport = overviewViewport(treeOf(model).ids, targetOf(model), dimsOf(model), size);
    return viewport === null ? model : setViewport(model, viewport);
  }
  if (model.viewing.mode === "diff") return diffCamera(model, size);
  const focus = cameraFocus(model.snapshot);
  if (focus === null) return setViewport(modifyFields(model, { placedRound: () => Option.none() }), fittedOf(model, size));
  if (!shouldMoveCamera(model.snapshot, Option.getOrNull(model.placedRound))) return model;
  const boxes = focusBoxesOf(model, focus);
  return setViewport(modifyFields(model, { placedRound: () => Option.some(model.snapshot.round) }), focusViewport(boxes.rects, boxes.center, size));
};

// 位置を保つ基準があるあいだ、そのノードが基準の画面座標に映るよう合わせる（補間中も、実寸の確定後の再配置も）
const reanchor = (model: Model): Model =>
  Option.match(model.keepAnchor, {
    onNone: () => model,
    onSome: ({ id, point }) => {
      const at = displayedPositions(model)[id];
      return at === undefined ? model : setViewport(model, anchoredViewport(model.viewport, at, point));
    },
  });

// 列を出したあと、画面の幅が変わったときに一度だけ、今の議題が切れる分だけずらす。列を隠したとき・今の議題が無いときはずらさない。幅が変わるまでは保留のまま
const applyPendingShift = (before: Model, after: Model): Model => {
  if (!after.pendingShift || Option.isNone(after.size)) return after;
  const size = after.size.value;
  if (Option.isSome(before.size) && before.size.value.width === size.width) return after;
  const settled = modifyFields(after, { pendingShift: () => false });
  const focus = after.mode === "still" || after.viewing.sideHidden ? null : cameraFocus(after.snapshot);
  return focus === null ? settled : setViewport(settled, shiftIntoView(after.viewport, focusBoxesOf(after, focus).rects, size));
};

// カメラへの指示の適用先。size は画面の大きさ、previous は Message を受ける前の Model（開閉の前の表示位置を読む）
type CommandContext = { size: Size; previous: Model };
type CommandHandlers = { [K in CameraCommand["type"]]: (model: Model, command: Extract<CameraCommand, { type: K }>, context: CommandContext) => Model };

// 人の倍率の範囲に収めた viewport（全体を見ていて 0.5 未満の倍率から人の状態に移るとき）
const clampedViewport = (viewport: Viewport, size: Size): Viewport => zoomAroundCenter(viewport, clampUserZoom(viewport.zoom), size);

const commandHandlers: CommandHandlers = {
  follow: (model) => model,
  hold: (model) => model,
  fitAll: (model) => model,
  fitChanged: (model) => model,
  shiftIntoView: (model) => model,
  refocus: (model) => modifyFields(model, { placedRound: () => Option.none() }),
  zoomBy: (model, { factor }, { size }) => setViewport(model, zoomAroundCenter(model.viewport, clampUserZoom(model.viewport.zoom * factor), size)),
  zoomTo: (model, { zoom }, { size }) => setViewport(model, zoomAroundCenter(model.viewport, clampUserZoom(zoom), size)),
  pan: (model, { dx, dy }, { size }) => setViewport(model, panViewport(clampedViewport(model.viewport, size), { dx, dy }, size)),
  focusNode: (model, { id }, { size }) => setViewport(model, nodeFocusViewport(nodeRect(id, targetOf(model), dimsOf(model)), model.viewport.zoom, size)),
  revealNode: (model, { id }, { size }) => setViewport(model, revealViewport(clampedViewport(model.viewport, size), nodeRect(id, targetOf(model), dimsOf(model)), size)),
  fitSubtree: (model, { id }, { size }) => setViewport(model, subtreeViewport(id, treeOf(model), targetOf(model), dimsOf(model), size)),
  keepNode: (model, { id }, { previous }) => {
    // 基準の画面座標は、開閉の前の表示位置から作る（畳んで「議題 N 件」に集約されたノードは、今の位置に無い）。
    // 以後は、いま見えている側（集約先のまとめのノード・解いた run:X は最初の議題）を基準の位置に合わせ続ける
    const at = displayedPositions(previous)[id] ?? displayedPositions(model)[id];
    return at === undefined ? model : modifyFields(model, { keepAnchor: () => Option.some({ id: keepTargetOf(foldViewOf(model), id), point: screenPoint(model.viewport, at) }) });
  },
};

// 指示をその場で適用する。指示のたびに、ずらしの保留（shiftIntoView のときだけ立てる）と位置を保つ基準を捨てる。画面の大きさが無いうちは viewport を動かさない
const applyCommand = (model: Model, command: CameraCommand, previous: Model): Model => {
  const reset = modifyFields(model, { pendingShift: () => command.type === "shiftIntoView", keepAnchor: () => Option.none() });
  if (Option.isNone(model.size)) return reset;
  // command.type から handler と引数の対応が決まる（handlers の型が保証する）ので、union の型を handler の引数に合わせるために広げる
  const handle = commandHandlers[command.type] as (model: Model, command: CameraCommand, context: CommandContext) => Model;
  return handle(reset, command, { size: model.size.value, previous });
};

// 10 秒を計り直さない出来事（右の列・字幕の出し入れと、クリックでの選択）
const keepsIdleTimer = (event: ViewingEvent): boolean => event.type === "side" || event.type === "captions" || event.type === "select" || event.type === "deselect";

// 見る状態に出来事を渡し、返ってきたカメラの指示をその場で適用する。reduceViewing へ渡す木は Message を受ける前の Model（押した時点の木。反映だけは反映の後の Model）から作る。
// previous は、目標の位置が変わったとき補間を始める元の表示位置を持つ Model（反映では Snapshot を差し替える前）
// 呼び順: 見る状態 → 補間 → 指示 → 自動のカメラ → 位置を保つ。列で切れる分だけずらす指示（shiftIntoView）と位置を保つ指示（keepNode）は寄せ直しも収め直しもしない
const applyViewing = (model: Model, event: ViewingEvent, previous: Model = model): Model => {
  const { state, camera } = reduceViewing(model.viewing, event, treeOf(model), model.mode === "review" ? "review" : "live");
  const reduced = modifyFields(model, { viewing: () => state, idleStamp: (stamp) => (keepsIdleTimer(event) ? stamp : stamp + 1) });
  // still は見る状態（選択・開閉）だけを受け、カメラは常に全体を収めるので指示を適用しない
  if (model.mode === "still") return reduced;
  const followed = followTarget(previous, reduced);
  const commanded = applyCommand(followed, camera, previous);
  return reanchor(camera.type === "shiftIntoView" || camera.type === "keepNode" ? commanded : autoCamera(commanded));
};

// 反映（round の変化）を見る状態へ渡す出来事。選んだノードが消えたときの移り先は、反映の前後の木から求める。still・round が変わらないとき・最初の反映は渡さない
const reflectionOf = (before: Model, after: Model): ViewingEvent | null => {
  if (after.mode === "still" || before.snapshot.round === after.snapshot.round) return null;
  const replaced = relocations({ tree: treeOf(before), snapshot: before.snapshot, selectedId: before.viewing.selection?.id ?? null }, { tree: treeOf(after), snapshot: after.snapshot });
  return { type: "reflect", replaced };
};

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

// ドラッグでない click とみなす、押した位置からの最大の移動量（px）。React 版（MapNode、削除済み）から引き継いだ値
const CLICK_SLOP = 4;
const awayFrom = (press: { x: number; y: number }, x: number, y: number): boolean => Math.hypot(x - press.x, y - press.y) > CLICK_SLOP;
// 空いたところのドラッグを受けるボタン。@xyflow（d3-zoom）のフィルタと同じく主ボタンと中ボタンで、Ctrl 付きは受けない
const startsPan = (button: number, ctrlKey: boolean): boolean => button <= 1 && !ctrlKey;
// MouseEvent.buttons のビットは主=1・右=2・中=4 で、button の番号（主=0・中=1）とは並びが違う。押したボタンに対応するビットを返す
const buttonsBit = (button: number): number => (button === 1 ? 4 : 1);

// 人が viewport を動かした。位置を保つ基準を捨て、見る状態へ userMoved を渡す（自動のカメラを止める）。
// 全体を見ている間の 0.5 未満の倍率から人の操作に移るときは、人の倍率の範囲に収める。still は人の操作を受けない
const movedByUser = (model: Model, viewport: Viewport): Model => {
  if (model.mode === "still") return model;
  const moved = applyViewing(modifyFields(setViewport(model, viewport), { keepAnchor: () => Option.none() }), { type: "userMoved" });
  return Option.match(moved.size, { onNone: () => moved, onSome: (size) => setViewport(moved, clampedViewport(moved.viewport, size)) });
};

const panBy = (model: Model, x: number, y: number): Model => movedByUser(model, { x: model.viewport.x + x, y: model.viewport.y + y, zoom: model.viewport.zoom });

// 画面上の point（表示面の左上が原点）を中心に倍率を factor 倍する。結果は zoomAtPoint（0.5〜2 に収める）
const zoomBy = (model: Model, point: { x: number; y: number }, factor: number): Model => movedByUser(model, zoomAtPoint(model.viewport, point, factor));

// 補間の位置が変わった後に、カメラを今見せている位置へ合わせる。位置を保つ基準を合わせ直し、今の議題が無い自動のときだけ補間後の配置へ全体を収め直す
const followDisplayed = (model: Model): Model => {
  const follows = model.mode !== "still" && model.viewing.mode === "auto" && cameraFocus(model.snapshot) === null;
  const anchored = reanchor(model);
  return follows ? autoCamera(anchored) : anchored;
};

// キー・時間の出来事を見る状態へ渡す（still は受けない）
const pressed = (model: Model, event: ViewingEvent): Return => ({ model: model.mode === "still" ? model : applyViewing(model, event) });

// 親（見返し）が、キーが押された事実を表示面へ伝える入口（子の Message を親が組み立てずに済む）。意味は update が reduceViewing で決める
export type KeyModifiers = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };
export const pressViewKey = (model: Model, input: KeyModifiers & { key: ViewKey }): Return => update(model, Message.PressedViewKey(input));
export const pressArrowKey = (model: Model, input: KeyModifiers & { dir: ArrowDir }): Return => update(model, Message.PressedArrowKey(input));
export const pressEscapeKey = (model: Model, input: KeyModifiers): Return => update(model, Message.PressedEscapeKey(input));
export const pressSideKey = (model: Model, input: KeyModifiers): Return => update(model, Message.PressedSideKey(input));
export const pressEnterKey = (model: Model, input: KeyModifiers): Return => update(model, Message.PressedEnterKey(input));

// 親（見返し）が、キーの一覧を開いた・閉じたことを表示面へ伝える入口。見る状態は動かさず、10 秒を計り直す（idleStamp を進める）だけ
export const toggledKeyList = (model: Model): Model => update(model, Message.ToggledKeyList()).model;

// 親（見返し）が、update の前後の表示面から、点滅を最初から再生し直す Command を求める入口。
// 測定済みで、表示する Snapshot の反映番号が変わり、変わった後も点滅の対象のノードがあるときだけ返す（同じ反映の中の再描画・選択・補間の Tick では返さない）
export const blinkRestartsOf = (before: Model, after: Model): ReadonlyArray<ReturnType<typeof RestartBlink>> => {
  if (after.mode === "still" || Option.isNone(after.size) || before.snapshot.round === after.snapshot.round) return [];
  return (foldViewOf(after)?.blink.size ?? 0) > 0 ? [RestartBlink()] : [];
};

// 親（見返し）が、時刻の変更で Snapshot が別のものになったことを表示面へ伝える入口（子の Message を親が組み立てずに済む）
export const changedSnapshot = (model: Model, snapshot: Snapshot): Model => update(model, Message.ChangedSnapshot({ snapshot })).model;

// 親（見返し）が、人が時刻を動かしたこと（ボタン・シーク・キー）を表示面へ伝える入口（自動のカメラへ戻る）
export const movedTime = (model: Model): Model => update(model, Message.MovedTime()).model;

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    MeasuredMapSurface: ({ width, height, nodeHeights }) => {
      const measured = modifyFields(model, {
        size: () => Option.some({ width, height }),
        nodeHeights: (current) => HashMap.setMany(current, Object.entries(nodeHeights)),
      });
      // 初めての大きさ・ノードの高さ・画面の大きさが変わったときだけ、寄せ直し・収め直しをする
      // ただしずらしの保留を使い切る測定（幅が変わった）では、画面の大きさの変化で収め直さない（列の出し入れ後の viewport は applyPendingShift だけが決める）
      const settlesShift = model.pendingShift && Option.isSome(model.size) && model.size.value.width !== width;
      const changed =
        Option.isNone(model.size) ||
        (!settlesShift && (model.size.value.width !== width || model.size.value.height !== height)) ||
        Object.entries(nodeHeights).some(([id, nodeHeight]) => Option.getOrUndefined(HashMap.get(model.nodeHeights, id)) !== nodeHeight);
      const followed = followTarget(model, measured);
      return { model: applyPendingShift(model, reanchor(changed ? autoCamera(followed) : followed)) };
    },
    ChangedSnapshot: ({ snapshot }) => {
      const replaced = modifyFields(model, { snapshot: () => snapshot });
      const reflection = reflectionOf(model, replaced);
      return { model: reflection === null ? reanchor(autoCamera(followTarget(model, replaced))) : applyViewing(replaced, reflection, model) };
    },
    MovedTime: () => (model.viewing.mode === "auto" ? { model } : pressed(model, { type: "timeMoved" })),
    PressedViewKey: ({ key, metaKey, ctrlKey, altKey }) => pressed(model, { type: "key", key, meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    PressedArrowKey: ({ dir, metaKey, ctrlKey, altKey }) => pressed(model, { type: "arrow", dir, meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    PressedEscapeKey: ({ metaKey, ctrlKey, altKey }) => pressed(model, { type: "escape", meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    PressedEnterKey: ({ metaKey, ctrlKey, altKey }) => pressed(model, { type: "enter", meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    PressedSideKey: ({ metaKey, ctrlKey, altKey }) => pressed(model, { type: "side", meta: metaKey, ctrl: ctrlKey, alt: altKey }),
    ElapsedIdleTime: () => pressed(model, { type: "idle" }),
    CompletedRestartBlink: () => ({ model }),
    ToggledKeyList: () => ({ model: modifyFields(model, { idleStamp: (stamp) => stamp + 1 }) }),
    TickedAnimationFrame: ({ deltaMs }) => {
      const ticked = modifyFields(model, {
        motion: Option.flatMap(({ start, elapsedMs }) => (elapsedMs + deltaMs >= MOTION_DURATION_MS ? Option.none() : Option.some({ start, elapsedMs: elapsedMs + deltaMs }))),
      });
      return { model: followDisplayed(ticked) };
    },
    PressedMapSurface: ({ clientX, clientY, button, ctrlKey, insideNoPan }) => ({
      model:
        model.mode !== "still" && !insideNoPan && startsPan(button, ctrlKey)
          ? modifyFields(model, { pointer: () => Option.some({ _tag: "PanningPane" as const, x: clientX, y: clientY, button }) })
          : model,
    }),
    PressedNodeButton: ({ nodeId, clientX, clientY }) => ({
      model: modifyFields(model, {
        nodePress: () => Option.some({ nodeId, x: clientX, y: clientY, dragged: false }),
        pointer: () => Option.some({ _tag: "HoldingNode" as const }),
      }),
    }),
    MovedPointer: ({ clientX, clientY, buttons }) => {
      if (Option.isNone(model.pointer)) return { model };
      const pointer = model.pointer.value;
      // 離したことを取りこぼしていても、押していたボタンが離れていればそこで終える
      const heldBit = pointer._tag === "PanningPane" ? buttonsBit(pointer.button) : 1;
      if ((buttons & heldBit) === 0) return { model: modifyFields(model, { pointer: () => Option.none() }) };
      const panned =
        pointer._tag === "PanningPane"
          ? modifyFields(panBy(model, clientX - pointer.x, clientY - pointer.y), { pointer: () => Option.some({ _tag: "PanningPane" as const, x: clientX, y: clientY, button: pointer.button }) })
          : model;
      return { model: modifyFields(panned, { nodePress: Option.map((press) => (awayFrom(press, clientX, clientY) ? { ...press, dragged: true } : press)) }) };
    },
    // 離したときに ⌘/Ctrl が付いていれば、続く click はマップの拡大・縮小に使われノードへ届かない。記録を残すと後のキーボードの click がドラッグ扱いになるので消す
    ReleasedPointer: ({ ctrlKey, metaKey }) => ({
      model: modifyFields(model, { pointer: () => Option.none(), nodePress: (press) => (ctrlKey || metaKey ? Option.none() : press) }),
    }),
    CanceledPointer: () => ({ model: modifyFields(model, { pointer: () => Option.none() }) }),
    // 押した記録の無い click（キーボード）と、別のノードの click は選ぶ。押したノードの click は記録を使い切り、ドラッグ（途中で超えた・押した位置から離れて離した）なら選ばない。
    // まとめのノード（run:）は選ばない（React 版から引き継いだ挙動）
    ClickedNodeButton: ({ nodeId, clientX, clientY }) => {
      const press = Option.filter(model.nodePress, (p) => p.nodeId === nodeId);
      const consumed = Option.isNone(press) ? model : modifyFields(model, { nodePress: () => Option.none() });
      const dragged = Option.isSome(press) && (press.value.dragged || awayFrom(press.value, clientX, clientY));
      if (dragged || foldViewOf(model)?.summaries.has(nodeId) === true) return { model: consumed };
      return { model: applyViewing(consumed, { type: "select", id: nodeId }), outMessage: OutMessage.SelectedNode({ nodeId }) };
    },
    ClickedFoldDot: ({ nodeId }) => ({ model: applyViewing(model, { type: "foldDot", id: nodeId }) }),
    ClickedEdgeDot: ({ nodeId }) => ({ model: applyViewing(model, { type: "edgeDot", id: nodeId }) }),
    // 「変わったこと」の項目: Snapshot にあるノードは祖先と開くかを畳む見せ方から求めて指し、無いノードは選ぶだけ（SessionView の point と同じ）。親へは知らせない
    ClickedChangeItem: ({ nodeId }) => {
      const { opened, folded, unbundled } = humanSetsOf(model.viewing);
      const found = pointedNode(model.snapshot, nodeId, opened, folded, unbundled);
      return { model: applyViewing(model, found === null ? { type: "select", id: nodeId } : { type: "pointChange", id: nodeId, ...found }) };
    },
    // 右の列の Disclosure: 今の状態と同じ向きなら何もしない。違えば E と同じ出来事を渡し、sideHidden は reduceViewing だけが決める
    ClickedEvidenceClose: () => ({ model: applyViewing(model, { type: "deselect" }) }),
    ToggledSide: ({ isOpen }) => (isOpen === (model.viewing.sideHidden !== true) ? { model } : { model: applyViewing(model, { type: "side", meta: false, ctrl: false, alt: false }) }),
    WheeledMapSurface: ({ x, y, deltaX, deltaY, deltaMode, shiftKey, ctrlKey, metaKey, timeStamp }) => {
      if (model.mode === "still") return { model };
      // ⌘/Ctrl＋Shift＋スクロール: 縦か横の一方の軸だけを、生の量で動かす。軸は入力の時刻で決める
      if ((metaKey || ctrlKey) && shiftKey) {
        const lock = scrollAxis(Option.getOrNull(model.scrollAxisLock), timeStamp, { x: deltaX, y: deltaY });
        // 原点から動いた分が、軸に沿った画面上の移動量
        const moved = scrollAlongAxis(IDENTITY, lock.axis, { x: deltaX, y: deltaY });
        return { model: modifyFields(panBy(model, moved.x, moved.y), { scrollAxisLock: () => Option.some(lock) }) };
      }
      // Ctrl 付き（トラックパッドのピンチ）はポインタの位置を中心にズームする。Mac の ⌘ だけはパンもズームもしない
      if (ctrlKey) return { model: zoomBy(model, { x, y }, pinchZoomFactor({ deltaY, deltaMode, ctrlKey }, model.isMac)) };
      if (model.isMac && metaKey) return { model };
      const moved = scrollPanDelta({ deltaX, deltaY, deltaMode, shiftKey }, model.isMac);
      return { model: panBy(model, moved.x, moved.y) };
    },
    // ⌘/Ctrl＋click: 押した点を中心に拡大する（Alt 付きは縮小）。ノードの選択には届かない（Mount が capture で止める）
    ClickedMapSurfaceWithModifier: ({ x, y, altKey }) => ({ model: zoomBy(model, { x, y }, altKey ? 1 / CLICK_ZOOM_FACTOR : CLICK_ZOOM_FACTOR) }),
    StartedMapSurfaceGesture: () => ({ model: modifyFields(model, { gestureScale: () => Option.none() }) }),
    // 累積の scale を前回との比にして掛ける。始まりが無ければ前回を 1 とみなす
    ChangedMapSurfaceGesture: ({ scale, x, y }) => {
      if (model.mode === "still") return { model };
      const factor = scale / Option.getOrElse(model.gestureScale, () => 1);
      return { model: modifyFields(zoomBy(model, { x, y }, factor), { gestureScale: () => Option.some(scale) }) };
    },
  });


// エッジの端点。@xyflow は .react-flow__handle の実際の位置から端点を決める。実際のブラウザで測ると、出る側は親の右端 +3、入る側は子の左端 −3
// （画面の倍率 1・2 のどちらでも同じ）。y はノードの高さの半分（小数のままの高さ）
const HANDLE_OUTSET = 3;

// @xyflow の既定のエッジ（ベジェ、曲率 0.25）の制御点のずれ。calculateControlOffset と同じ
const CURVATURE = 0.25;
const controlOffset = (distance: number): number => (distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance));
const bezier = (source: Position, target: Position): string => {
  const offset = controlOffset(target.x - source.x);
  return `M${source.x},${source.y} C${source.x + offset},${source.y} ${target.x - offset},${target.y} ${target.x},${target.y}`;
};

const classes = (...names: ReadonlyArray<string | false>): string => names.filter(Boolean).join(" ");

type H = HtmlBuilder<Message>;

// selected・toggle・opened は live のときだけ意味を持つ（still は選択も丸も描かない）。toggle は foldToggle の結果（null は開閉できない）
function nodeBody(h: H, node: SnapshotNode, view: FoldView | null, selected: boolean, toggle: ReturnType<typeof foldToggle>, opened: boolean): Html {
  const fold = view?.folds[node.id] ?? null;
  const mark = markOf(node);
  const person = personLine(node);
  return h.div(
    [
      h.Class(
        classes("map-node", node.kind === "案" && node.planStatus === "却下" && "map-node--rejected", fold !== null && "map-node--folded", selected && "map-node--selected", view?.blink.has(node.id) === true && "map-node--blink", "nopan"),
      ),
      h.Style({ "--kind-color": KIND_COLOR[node.kind] }),
    ],
    [
      h.button(
        [h.Type("button"), h.Class(MAP_NODE_BUTTON_CLASS), h.AriaPressed(String(selected))],
        [mark === null ? null : h.span([h.Class("map-node__mark")], [mark]), h.span([h.Class("map-node__text")], [node.text]), person === null ? null : h.span([h.Class("map-node__person text-[12px] text-gray-500")], [person]), fold?.hint ? h.span([h.Class("map-node__hint")], [fold.hint]) : null],
      ),
      fold === null
        ? null
        : toggle === null
          ? h.span([h.Class("map-node__count")], [String(fold.hidden)])
          : h.button([h.Type("button"), h.Class(`map-node__count ${FOLD_DOT_CLASSES[0]}`), h.AriaLabel("開く"), h.OnClick(Message.ClickedFoldDot({ nodeId: node.id }))], [String(fold.hidden)]),
      fold === null && opened && toggle !== null ? h.button([h.Type("button"), h.Class(FOLD_DOT_CLASSES[1]), h.AriaLabel("畳む"), h.OnClick(Message.ClickedFoldDot({ nodeId: node.id }))], []) : null,
    ],
  );
}

export const view = Submodel.defineView<Model, Message>((model, h): Html => {
  const view_ = foldViewOf(model);
  const tree = view_ === null ? null : treeOf(model, view_);
  const selectedId = view_ === null ? null : (model.viewing.selection?.id ?? null);
  const { opened } = humanSetsOf(model.viewing);
  const shown = view_?.nodes ?? model.snapshot.nodes;
  const exactHeight = (id: string): number => Option.getOrThrow(HashMap.get(model.nodeHeights, id));
  const positions = displayedPositions(model);
  // 測れたノードだけ見せる。エッジは両端が測れてから描く
  const measured = shown.filter((n) => HashMap.has(model.nodeHeights, n.id));
  const viewport = model.viewport;

  const edges = measured.flatMap((child) => {
    const parent = child.parent === null ? undefined : measured.find((n) => n.id === child.parent);
    if (parent === undefined) return [];
    const source = { x: positions[parent.id]!.x + NODE_WIDTH + HANDLE_OUTSET, y: positions[parent.id]!.y + exactHeight(parent.id) / 2 };
    const target = { x: positions[child.id]!.x - HANDLE_OUTSET, y: positions[child.id]!.y + exactHeight(child.id) / 2 };
    return [h.keyed("path")(`${parent.id}->${child.id}`, [h.D(bezier(source, target)), h.Stroke(KIND_COLOR[child.kind]), h.StrokeWidth("2"), h.Fill("none")])];
  });
  const nodes = shown.map((node) =>
    h.keyed("div")(
      node.id,
      [
        h.Class("map-node-slot absolute left-0 top-0 box-border origin-top-left [pointer-events:all] select-none cursor-default"),
        h.DataAttribute("node-id", node.id),
        h.Style({ transform: `translate(${positions[node.id]!.x}px, ${positions[node.id]!.y}px)`, width: `${NODE_WIDTH}px`, visibility: HashMap.has(model.nodeHeights, node.id) ? "visible" : "hidden" }),
      ],
      [nodeBody(h, node, view_, node.id === selectedId, tree === null ? null : foldToggle(tree, node.id), view_ !== null && opened.has(node.id))],
    ),
  );

  // 縁の点: 画面の外で変わったノードを、still 以外で人が動かして止めているか全体を見ている間だけ描く。位置は目標の位置と高さで測る
  const dots =
    view_ === null || tree === null || model.viewing.mode === "auto"
      ? []
      : Option.match(model.size, {
          onNone: () => [],
          onSome: (size) =>
            edgeDots(
              tree.ids.filter((id) => view_.blink.has(id) && HashMap.has(model.nodeHeights, id)),
              tree.targets,
              dimsOf(model),
              viewport,
              size,
            ),
        });
  const edgeDotButtons = dots.map((dot) =>
    h.keyed("button")(dot.id, [
      h.Type("button"),
      h.Class("edge-dot nopan nowheel absolute w-[10px] h-[10px] [margin:-5px_0_0_-5px] p-0 [border:0] rounded-[50%] bg-yellow-400 cursor-pointer pointer-events-auto"),
      h.Style({ left: `${dot.x}px`, top: `${dot.y}px` }),
      h.AriaLabel(`画面の外で変わったノードへ寄る（${dot.ids.length} 件）`),
      h.OnClick(Message.ClickedEdgeDot({ nodeId: dot.id })),
    ]),
  );

  return h.div(
    [h.Class("map-surface relative w-full h-full overflow-hidden z-0"), h.OnMount(ObserveMapSurface())],
    [
      h.div([h.Class("map-viewport absolute left-0 top-0 w-full h-full origin-top-left pointer-events-none z-2"), h.Style({ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` })], [h.svg([h.Class("map-edges absolute left-0 top-0 w-[1px] h-[1px] overflow-visible pointer-events-none")], edges), h.div([h.Class("map-nodes absolute left-0 top-0 pointer-events-none")], nodes)]),
      ...(edgeDotButtons.length === 0 ? [] : [h.div([h.Class("edge-dots absolute inset-0 z-4 pointer-events-none overflow-hidden")], edgeDotButtons)]),
    ],
  );
});
