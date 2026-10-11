// マップの表示面（Issue #814）: Foldkit のプログラム。ノード（絶対配置の div）・エッジ（SVG のベジェ）・ビューポート（transform）を素で描く。
// 配置（layout）・畳み（foldView）・全体を収める（fitViewport）は既存の純粋な関数で、view が毎回、Model の値から導く（Model には持たない）
import { HashMap, Option, Schema } from "effect";
import { Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { Snapshot, type SnapshotNode } from "../../../../server/src/core/index.ts";
import { fitViewport, OVERVIEW_MIN_ZOOM, scrollAlongAxis, scrollAxis, scrollPanDelta, USER_MAX_ZOOM, USER_MIN_ZOOM, type Rect, type Viewport } from "../../camera.ts";
import { MAP_NODE_BUTTON_CLASS } from "../../enterFold.ts";
import { foldView, type FoldView } from "../../folding.ts";
import { KIND_COLOR, markOf } from "../../kinds.ts";
import { layout, NODE_WIDTH, type Position } from "../../layout.ts";
import "./mapSurface.css";
import { Message, OutMessage } from "./message.ts";
import { ObserveMapSurface } from "./mount.ts";

// still は map.png の撮影用で、畳まず、大きなマップも全体を収める。live は会議中・見返しで、畳み、倍率を人の範囲に収める
// パンの状態: pan はフィットした位置に足す画面上の平行移動（倍率に依らない）。pointer は押している間の相手、nodePress はノードのボタンを押した記録（click で使い切る）、scrollAxisLock は軸固定の軸
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
});

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

// ドラッグでない click とみなす、押した位置からの最大の移動量（px）。MapNode.tsx の CLICK_SLOP と同じ
const CLICK_SLOP = 4;
const awayFrom = (press: { x: number; y: number }, x: number, y: number): boolean => Math.hypot(x - press.x, y - press.y) > CLICK_SLOP;
// 空いたところのドラッグを受けるボタン。@xyflow（d3-zoom）のフィルタと同じく主ボタンと中ボタンで、Ctrl 付きは受けない
const startsPan = (button: number, ctrlKey: boolean): boolean => button <= 1 && !ctrlKey;
// MouseEvent.buttons のビットは主=1・右=2・中=4 で、button の番号（主=0・中=1）とは並びが違う。押したボタンに対応するビットを返す
const buttonsBit = (button: number): number => (button === 1 ? 4 : 1);
// ズームの経路の wheel（Ctrl 付きのピンチ、Mac の ⌘ だけ）。この issue ではパンしない
const isZoomWheel = (ctrlKey: boolean, metaKey: boolean, isMac: boolean): boolean => ctrlKey || (isMac && metaKey);

const panBy = (model: Model, x: number, y: number): Model => modifyFields(model, { pan: (pan) => ({ x: pan.x + x, y: pan.y + y }) });

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    MeasuredMapSurface: ({ width, height, nodeHeights }) => ({
      model: modifyFields(model, {
        size: () => Option.some({ width, height }),
        nodeHeights: (current) => HashMap.setMany(current, Object.entries(nodeHeights)),
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
    // 押した記録の無い click（キーボード）と、別のノードの click は選ぶ。押したノードの click は記録を使い切り、ドラッグ（途中で超えた・押した位置から離れて離した）なら選ばない
    ClickedNodeButton: ({ nodeId, clientX, clientY }) => {
      const press = Option.filter(model.nodePress, (p) => p.nodeId === nodeId);
      if (Option.isNone(press)) return { model, outMessage: OutMessage.SelectedNode({ nodeId }) };
      const consumed = modifyFields(model, { nodePress: () => Option.none() });
      const isDrag = press.value.dragged || awayFrom(press.value, clientX, clientY);
      return isDrag ? { model: consumed } : { model: consumed, outMessage: OutMessage.SelectedNode({ nodeId }) };
    },
    WheeledMapSurface: ({ deltaX, deltaY, deltaMode, shiftKey, ctrlKey, metaKey, timeStamp }) => {
      if (model.mode !== "live") return { model };
      // ⌘/Ctrl＋Shift＋スクロール: 縦か横の一方の軸だけを、生の量で動かす。軸は入力の時刻で決める
      if ((metaKey || ctrlKey) && shiftKey) {
        const lock = scrollAxis(Option.getOrNull(model.scrollAxisLock), timeStamp, { x: deltaX, y: deltaY });
        // 原点から動いた分が、軸に沿った画面上の移動量
        const moved = scrollAlongAxis(IDENTITY, lock.axis, { x: deltaX, y: deltaY });
        return { model: modifyFields(panBy(model, moved.x, moved.y), { scrollAxisLock: () => Option.some(lock) }) };
      }
      if (isZoomWheel(ctrlKey, metaKey, model.isMac)) return { model };
      const moved = scrollPanDelta({ deltaX, deltaY, deltaMode, shiftKey }, model.isMac);
      return { model: panBy(model, moved.x, moved.y) };
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

const NO_IDS: ReadonlySet<string> = new Set();
const IDENTITY: Viewport = { x: 0, y: 0, zoom: 1 };

const classes = (...names: ReadonlyArray<string | false>): string => names.filter(Boolean).join(" ");

type H = HtmlBuilder<Message>;

function nodeBody(h: H, node: SnapshotNode, view: FoldView | null): Html {
  const fold = view?.folds[node.id] ?? null;
  const mark = markOf(node);
  return h.div(
    [
      h.Class(classes("map-node", node.kind === "案" && node.planStatus === "却下" && "map-node--rejected", fold !== null && "map-node--folded", view?.blink.has(node.id) === true && "map-node--blink", "nopan")),
      h.Style({ "--kind-color": KIND_COLOR[node.kind] }),
    ],
    [
      h.button(
        [h.Type("button"), h.Class(MAP_NODE_BUTTON_CLASS), h.AriaPressed("false")],
        [mark === null ? null : h.span([h.Class("map-node__mark")], [mark]), h.span([h.Class("map-node__text")], [node.text]), fold?.hint ? h.span([h.Class("map-node__hint")], [fold.hint]) : null],
      ),
      fold === null ? null : h.span([h.Class("map-node__count")], [String(fold.hidden)]),
    ],
  );
}

export const view = Submodel.defineView<Model, Message>((model, h): Html => {
  const view_ = model.mode === "live" ? foldView(model.snapshot, NO_IDS, null, NO_IDS, NO_IDS) : null;
  const shown = view_?.nodes ?? model.snapshot.nodes;
  const heights = Object.fromEntries(HashMap.toEntries(model.nodeHeights));
  const positions = layout(shown, heights);
  // 測れたノードだけ見せる。エッジは両端が測れてから描き、全体を収める箱にも測れたノードだけを使う
  const measured = shown.filter((n) => HashMap.has(model.nodeHeights, n.id));
  const rects = measured.map((n): Rect => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: heights[n.id]! }));
  const minZoom = model.mode === "still" ? OVERVIEW_MIN_ZOOM : USER_MIN_ZOOM;
  const fitted = Option.match(model.size, { onNone: () => null, onSome: (size) => fitViewport(rects, size, minZoom, USER_MAX_ZOOM) }) ?? IDENTITY;
  // パンは画面上の平行移動で、フィットした位置に足す（倍率は変えない）
  const viewport: Viewport = { ...fitted, x: fitted.x + model.pan.x, y: fitted.y + model.pan.y };

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
      [nodeBody(h, node, view_)],
    ),
  );

  return h.div(
    [h.Class("map-surface"), h.OnMount(ObserveMapSurface())],
    [h.div([h.Class("map-viewport"), h.Style({ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` })], [h.svg([h.Class("map-edges")], edges), h.div([h.Class("map-nodes")], nodes)])],
  );
});
