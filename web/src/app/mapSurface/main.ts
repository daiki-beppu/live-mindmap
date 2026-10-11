// マップの表示面（Issue #814・#816）: Foldkit のプログラム。ノード（絶対配置の div）・エッジ（SVG のベジェ）・ビューポート（transform）を素で描く。
// 配置（layout）・畳み（foldView）・全体を収める（fitViewport）は既存の純粋な関数で、view が毎回、Model の値から導く（Model には持たない）
import { HashMap, Option, Schema } from "effect";
import { Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { Snapshot, type SnapshotNode } from "../../../../server/src/core/index.ts";
import { CLICK_ZOOM_FACTOR, edgeDots, fitViewport, OVERVIEW_MIN_ZOOM, pinchZoomFactor, scrollAlongAxis, scrollAxis, scrollPanDelta, USER_MAX_ZOOM, USER_MIN_ZOOM, zoomAtPoint, type Rect, type Viewport } from "../../camera.ts";
import { FOLD_DOT_CLASSES, MAP_NODE_BUTTON_CLASS } from "../../enterFold.ts";
import { foldView, type FoldView } from "../../folding.ts";
import { KIND_COLOR, markOf } from "../../kinds.ts";
import { layout, NODE_WIDTH, type Position } from "../../layout.ts";
import { interpolate, startPositions } from "../../motion.ts";
import { foldToggle, humanSetsOf, INITIAL_VIEWING, reduceViewing, ViewingState, type ViewingEvent, type VisibleTree } from "../../viewing.ts";
import "./mapSurface.css";
import { Message, OutMessage } from "./message.ts";
import { ObserveMapSurface } from "./mount.ts";

// still は map.png の撮影用で、畳まず、大きなマップも全体を収める。live は会議中・見返しで、畳み、倍率を人の範囲に収める
// 動きの状態（Issue #817）: motion は差分更新や高さの変化で目標の位置が変わったときの補間で、start は補間の始まりの位置（id → 位置）、elapsedMs は始めてからの経過 ms。補間していないときは None。
// 表示する位置と目標の位置は Model に持たず、displayedPositions が motion と目標から毎回導く
// 見る状態（Issue #818）: viewing は選んだノードと人が開いた・畳んだ・解いた集合（カメラの状態も持つが、カメラの動きは後の issue）。意味は reduceViewing が決め、update が Message から出来事を作って渡す
// パンの状態: pan はフィットした位置に足す画面上の平行移動（倍率に依らない）。pointer は押している間の相手、nodePress はノードのボタンを押した記録（click で使い切る）、scrollAxisLock は軸固定の軸
// ズームの状態（Issue #816）: zoomScale は全体を収めた倍率に掛ける倍率（初期 1）、gestureScale は Safari の gesture の前回の累積 scale（update が前回との比を求めるのに使う。始まりの前・外れたら None）。ビューポートは viewportOf が毎回導く
export const Model = Schema.Struct({
  mode: Schema.Literals(["still", "live"]),
  snapshot: Snapshot,
  size: Schema.Option(Schema.Struct({ width: Schema.Finite, height: Schema.Finite })),
  nodeHeights: Schema.HashMap(Schema.String, Schema.Finite),
  isMac: Schema.Boolean,
  pan: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
  pointer: Schema.Option(Schema.Union([Schema.TaggedStruct("PanningPane", { x: Schema.Finite, y: Schema.Finite, button: Schema.Finite }), Schema.TaggedStruct("HoldingNode", {})])),
  nodePress: Schema.Option(Schema.Struct({ nodeId: Schema.String, x: Schema.Finite, y: Schema.Finite, dragged: Schema.Boolean })),
  scrollAxisLock: Schema.Option(Schema.Struct({ axis: Schema.Literals(["x", "y"]), at: Schema.Finite })),
  motion: Schema.Option(Schema.Struct({ start: Schema.HashMap(Schema.String, Schema.Struct({ x: Schema.Finite, y: Schema.Finite })), elapsedMs: Schema.Finite })),
  viewing: ViewingState,
  zoomScale: Schema.Finite,
  gestureScale: Schema.Option(Schema.Finite),
});
export type Model = typeof Model.Type;

export const init = (snapshot: Snapshot, mode: Model["mode"], isMac: boolean): Model => ({
  mode,
  snapshot,
  size: Option.none(),
  nodeHeights: HashMap.empty(),
  isMac,
  pan: { x: 0, y: 0 },
  pointer: Option.none(),
  nodePress: Option.none(),
  scrollAxisLock: Option.none(),
  motion: Option.none(),
  viewing: INITIAL_VIEWING,
  zoomScale: 1,
  gestureScale: Option.none(),
});

// 補間の長さ（ms）。web/src/useAnimatedPositions.ts の DURATION_MS と同じ（React 版の部品には触らないので、ここに別に置く）
const MOTION_DURATION_MS = 500;

// 畳んだ見せ方。人が開いた・畳んだ・解いた集合と選んだノードを渡して導く。still は畳まない
const foldViewOf = (model: Model): FoldView | null => {
  if (model.mode !== "live") return null;
  const { opened, folded, unbundled } = humanSetsOf(model.viewing);
  return foldView(model.snapshot, opened, model.viewing.selection?.id ?? null, folded, unbundled);
};
// 畳んだ後に見せるノード
const shownNodesOf = (model: Model): SnapshotNode[] => foldViewOf(model)?.nodes ?? model.snapshot.nodes;
const heightsOf = (model: Model): Record<string, number> => Object.fromEntries(HashMap.toEntries(model.nodeHeights));
// 補間の行き先（目標の位置）
const targetOf = (model: Model): Record<string, Position> => layout(shownNodesOf(model), heightsOf(model));

// 見えている木。reduceViewing の入力で、丸を描くかの判定（foldToggle）にも同じものを使う。MapView.tsx の tree と同じ組み立て
const treeOf = (model: Model, view: FoldView | null): VisibleTree => {
  const shown = view?.nodes ?? model.snapshot.nodes;
  return {
    ids: shown.map((n) => n.id),
    targets: layout(shown, heightsOf(model)),
    parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])),
    foldState: view
      ? Object.fromEntries(shown.filter((n) => (n.kind === "議題" || n.kind === "論点") && !view.summaries.has(n.id)).map((n) => [n.id, n.id in view.folds ? "folded" : "open"]))
      : {},
    runs: view?.runs ?? {},
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
  if (after.mode !== "live") return after;
  const target = targetOf(after);
  if (samePositions(targetOf(before), target)) return after;
  const shown = HashMap.size(before.nodeHeights) === 0 ? {} : displayedPositions(before);
  const start = startPositions(shownNodesOf(after), shown, target);
  return modifyFields(after, {
    motion: () => (samePositions(start, target) ? Option.none() : Option.some({ start: HashMap.fromIterable(Object.entries(start)), elapsedMs: 0 })),
  });
};

// 見る状態に出来事を渡す。Message を受ける前の Model から作った木で reduceViewing を呼ぶ（押した時点の木）。カメラの指示は後の issue まで使わない。開閉・選択で目標の位置が変わるので補間を始める
const applyViewing = (model: Model, event: ViewingEvent): Model => {
  const { state } = reduceViewing(model.viewing, event, treeOf(model, foldViewOf(model)));
  return followTarget(model, modifyFields(model, { viewing: () => state }));
};

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

// ドラッグでない click とみなす、押した位置からの最大の移動量（px）。MapNode.tsx の CLICK_SLOP と同じ
const CLICK_SLOP = 4;
const awayFrom = (press: { x: number; y: number }, x: number, y: number): boolean => Math.hypot(x - press.x, y - press.y) > CLICK_SLOP;
// 空いたところのドラッグを受けるボタン。@xyflow（d3-zoom）のフィルタと同じく主ボタンと中ボタンで、Ctrl 付きは受けない
const startsPan = (button: number, ctrlKey: boolean): boolean => button <= 1 && !ctrlKey;
// MouseEvent.buttons のビットは主=1・右=2・中=4 で、button の番号（主=0・中=1）とは並びが違う。押したボタンに対応するビットを返す
const buttonsBit = (button: number): number => (button === 1 ? 4 : 1);

const panBy = (model: Model, x: number, y: number): Model => modifyFields(model, { pan: (pan) => ({ x: pan.x + x, y: pan.y + y }) });

// 全体を収めた位置（パンもズームも足す前）。測れたノードだけで収める
const fittedOf = (model: Model): Viewport => {
  const shown = shownNodesOf(model);
  const heights = heightsOf(model);
  const positions = displayedPositions(model);
  const rects = shown.filter((n) => HashMap.has(model.nodeHeights, n.id)).map((n): Rect => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: heights[n.id]! }));
  return Option.match(model.size, { onNone: () => null, onSome: (size) => fitViewport(rects, size, minZoomOf(model), USER_MAX_ZOOM) }) ?? IDENTITY;
};

// 倍率の下限。still は全体を見るので OVERVIEW_MIN_ZOOM、live は USER_MIN_ZOOM
const minZoomOf = (model: Model): number => (model.mode === "still" ? OVERVIEW_MIN_ZOOM : USER_MIN_ZOOM);

// 見せるビューポート。全体を収めた位置に zoomScale を掛け、パン（画面上の平行移動）を足す。view も update のズームも同じ値を使う。
// zoomScale は操作した時点のフィット倍率との比なので、フィット倍率が変わると倍率が範囲外に出うる。実効倍率を範囲に収め、位置もその実効倍率から導く
export const viewportOf = (model: Model): Viewport => {
  const fitted = fittedOf(model);
  const zoom = Math.min(USER_MAX_ZOOM, Math.max(minZoomOf(model), fitted.zoom * model.zoomScale));
  const scale = zoom / fitted.zoom;
  return { x: fitted.x * scale + model.pan.x, y: fitted.y * scale + model.pan.y, zoom };
};

// 画面上の point（表示面の左上が原点）を中心に倍率を factor 倍する。結果は zoomAtPoint（0.5〜2 に収める）で、見せるビューポートがそれと一致するよう zoomScale と pan に書き戻す。still はズームしない
const zoomBy = (model: Model, point: { x: number; y: number }, factor: number): Model => {
  if (model.mode !== "live") return model;
  const fitted = fittedOf(model);
  const next = zoomAtPoint(viewportOf(model), point, factor);
  const zoomScale = next.zoom / fitted.zoom;
  return modifyFields(model, { zoomScale: () => zoomScale, pan: () => ({ x: next.x - fitted.x * zoomScale, y: next.y - fitted.y * zoomScale }) });
};

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    MeasuredMapSurface: ({ width, height, nodeHeights }) => ({
      model: followTarget(
        model,
        modifyFields(model, {
          size: () => Option.some({ width, height }),
          nodeHeights: (current) => HashMap.setMany(current, Object.entries(nodeHeights)),
        }),
      ),
    }),
    ChangedSnapshot: ({ snapshot }) => ({ model: followTarget(model, modifyFields(model, { snapshot: () => snapshot })) }),
    TickedAnimationFrame: ({ deltaMs }) => ({
      model: modifyFields(model, {
        motion: Option.flatMap(({ start, elapsedMs }) => (elapsedMs + deltaMs >= MOTION_DURATION_MS ? Option.none() : Option.some({ start, elapsedMs: elapsedMs + deltaMs }))),
      }),
    }),
    PressedMapSurface: ({ clientX, clientY, button, ctrlKey, insideNoPan }) => ({
      model:
        model.mode === "live" && !insideNoPan && startsPan(button, ctrlKey)
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
    // まとめのノード（run:）は選ばない（MapView.tsx のまとめの onSelect と同じ）
    ClickedNodeButton: ({ nodeId, clientX, clientY }) => {
      const press = Option.filter(model.nodePress, (p) => p.nodeId === nodeId);
      const consumed = Option.isNone(press) ? model : modifyFields(model, { nodePress: () => Option.none() });
      const dragged = Option.isSome(press) && (press.value.dragged || awayFrom(press.value, clientX, clientY));
      if (dragged || foldViewOf(model)?.summaries.has(nodeId) === true) return { model: consumed };
      return { model: applyViewing(consumed, { type: "select", id: nodeId }), outMessage: OutMessage.SelectedNode({ nodeId }) };
    },
    ClickedFoldDot: ({ nodeId }) => ({ model: applyViewing(model, { type: "foldDot", id: nodeId }) }),
    ClickedEdgeDot: ({ nodeId }) => ({ model: applyViewing(model, { type: "edgeDot", id: nodeId }) }),
    WheeledMapSurface: ({ x, y, deltaX, deltaY, deltaMode, shiftKey, ctrlKey, metaKey, timeStamp }) => {
      if (model.mode !== "live") return { model };
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
      if (model.mode !== "live") return { model };
      const factor = scale / Option.getOrElse(model.gestureScale, () => 1);
      return { model: modifyFields(zoomBy(model, { x, y }, factor), { gestureScale: () => Option.some(scale) }) };
    },
  });

// エッジの端点。@xyflow の .react-flow__handle は content-box で幅 6px + 枠 1px × 2 = 8px で、.map-node の padding box
// （枠 1.5px の内側）を基準に ±50% ずらして置かれるので、ノードの左右の端から 2.5px 外に出る（出る側は右端 +2.5、入る側は左端 −2.5）
const HANDLE_OUTSET = 2.5;

// @xyflow の既定のエッジ（ベジェ、曲率 0.25）の制御点のずれ。calculateControlOffset と同じ
const CURVATURE = 0.25;
const controlOffset = (distance: number): number => (distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance));
const bezier = (source: Position, target: Position): string => {
  const offset = controlOffset(target.x - source.x);
  return `M${source.x},${source.y} C${source.x + offset},${source.y} ${target.x - offset},${target.y} ${target.x},${target.y}`;
};

const IDENTITY: Viewport = { x: 0, y: 0, zoom: 1 };

const classes = (...names: ReadonlyArray<string | false>): string => names.filter(Boolean).join(" ");

type H = HtmlBuilder<Message>;

// selected・toggle・opened は live のときだけ意味を持つ（still は選択も丸も描かない）。toggle は foldToggle の結果（null は開閉できない）
function nodeBody(h: H, node: SnapshotNode, view: FoldView | null, selected: boolean, toggle: ReturnType<typeof foldToggle>, opened: boolean): Html {
  const fold = view?.folds[node.id] ?? null;
  const mark = markOf(node);
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
        [mark === null ? null : h.span([h.Class("map-node__mark")], [mark]), h.span([h.Class("map-node__text")], [node.text]), fold?.hint ? h.span([h.Class("map-node__hint")], [fold.hint]) : null],
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
  const heights = heightsOf(model);
  const positions = displayedPositions(model);
  // 測れたノードだけ見せる。エッジは両端が測れてから描く
  const measured = shown.filter((n) => HashMap.has(model.nodeHeights, n.id));
  const viewport = viewportOf(model);

  const edges = measured.flatMap((child) => {
    const parent = child.parent === null ? undefined : measured.find((n) => n.id === child.parent);
    if (parent === undefined) return [];
    const source = { x: positions[parent.id]!.x + NODE_WIDTH + HANDLE_OUTSET, y: positions[parent.id]!.y + heights[parent.id]! / 2 };
    const target = { x: positions[child.id]!.x - HANDLE_OUTSET, y: positions[child.id]!.y + heights[child.id]! / 2 };
    return [h.keyed("path")(`${parent.id}->${child.id}`, [h.D(bezier(source, target)), h.Stroke(KIND_COLOR[child.kind]), h.StrokeWidth("2"), h.Fill("none")])];
  });
  const nodes = shown.map((node) =>
    h.keyed("div")(
      node.id,
      [
        h.Class("map-node-slot"),
        h.DataAttribute("node-id", node.id),
        h.Style({ transform: `translate(${positions[node.id]!.x}px, ${positions[node.id]!.y}px)`, width: `${NODE_WIDTH}px`, visibility: HashMap.has(model.nodeHeights, node.id) ? "visible" : "hidden" }),
      ],
      [nodeBody(h, node, view_, node.id === selectedId, tree === null ? null : foldToggle(tree, node.id), view_ !== null && opened.has(node.id))],
    ),
  );

  // 縁の点: 画面の外で変わったノードを、live で人が動かして止めているか全体を見ている間だけ描く。位置は目標の位置と高さで測る
  const dots =
    view_ === null || tree === null || model.viewing.mode === "auto"
      ? []
      : Option.match(model.size, {
          onNone: () => [],
          onSome: (size) =>
            edgeDots(
              tree.ids.filter((id) => view_.blink.has(id) && HashMap.has(model.nodeHeights, id)),
              tree.targets,
              Object.fromEntries(HashMap.toEntries(model.nodeHeights).map(([id, height]) => [id, { height }])),
              viewport,
              size,
            ),
        });
  const edgeDotButtons = dots.map((dot) =>
    h.keyed("button")(dot.id, [
      h.Type("button"),
      h.Class("edge-dot nopan nowheel"),
      h.Style({ left: `${dot.x}px`, top: `${dot.y}px` }),
      h.AriaLabel(`画面の外で変わったノードへ寄る（${dot.ids.length} 件）`),
      h.OnClick(Message.ClickedEdgeDot({ nodeId: dot.id })),
    ]),
  );

  return h.div(
    [h.Class("map-surface"), h.OnMount(ObserveMapSurface())],
    [
      h.div([h.Class("map-viewport"), h.Style({ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` })], [h.svg([h.Class("map-edges")], edges), h.div([h.Class("map-nodes")], nodes)]),
      ...(edgeDotButtons.length === 0 ? [] : [h.div([h.Class("edge-dots")], edgeDotButtons)]),
    ],
  );
});
