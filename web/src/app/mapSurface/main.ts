// マップの表示面（Issue #814）: Foldkit のプログラム。ノード（絶対配置の div）・エッジ（SVG のベジェ）・ビューポート（transform）を素で描く。
// 配置（layout）・畳み（foldView）・全体を収める（fitViewport）は既存の純粋な関数で、view が毎回、Model の値から導く（Model には持たない）
import { HashMap, Option, Schema } from "effect";
import type { Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { Snapshot, type SnapshotNode } from "../../../../server/src/core/index.ts";
import { fitViewport, OVERVIEW_MIN_ZOOM, USER_MAX_ZOOM, USER_MIN_ZOOM, type Rect, type Viewport } from "../../camera.ts";
import { MAP_NODE_BUTTON_CLASS } from "../../enterFold.ts";
import { foldView, type FoldView } from "../../folding.ts";
import { KIND_COLOR, markOf } from "../../kinds.ts";
import { layout, NODE_WIDTH, type Position } from "../../layout.ts";
import "./mapSurface.css";
import { Message } from "./message.ts";
import { ObserveMapSurface } from "./mount.ts";

// still は map.png の撮影用で、畳まず、大きなマップも全体を収める。live は会議中・見返しで、畳み、倍率を人の範囲に収める
export const Model = Schema.Struct({
  mode: Schema.Literals(["still", "live"]),
  snapshot: Snapshot,
  size: Schema.Option(Schema.Struct({ width: Schema.Finite, height: Schema.Finite })),
  nodeHeights: Schema.HashMap(Schema.String, Schema.Finite),
});
export type Model = typeof Model.Type;

export const init = (snapshot: Snapshot, mode: Model["mode"]): Model => ({ mode, snapshot, size: Option.none(), nodeHeights: HashMap.empty() });

type Return = Update.Return<Model, Message>;

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    MeasuredMapSurface: ({ width, height, nodeHeights }) => ({
      model: modifyFields(model, {
        size: () => Option.some({ width, height }),
        nodeHeights: (current) => HashMap.setMany(current, Object.entries(nodeHeights)),
      }),
    }),
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

export const view = (model: Model, h: H): Html => {
  const view_ = model.mode === "live" ? foldView(model.snapshot, NO_IDS, null, NO_IDS, NO_IDS) : null;
  const shown = view_?.nodes ?? model.snapshot.nodes;
  const heights = Object.fromEntries(HashMap.toEntries(model.nodeHeights));
  const positions = layout(shown, heights);
  // 測れたノードだけ見せる。エッジは両端が測れてから描き、全体を収める箱にも測れたノードだけを使う
  const measured = shown.filter((n) => HashMap.has(model.nodeHeights, n.id));
  const rects = measured.map((n): Rect => ({ x: positions[n.id]!.x, y: positions[n.id]!.y, width: NODE_WIDTH, height: heights[n.id]! }));
  const minZoom = model.mode === "still" ? OVERVIEW_MIN_ZOOM : USER_MIN_ZOOM;
  const viewport = Option.match(model.size, { onNone: () => null, onSome: (size) => fitViewport(rects, size, minZoom, USER_MAX_ZOOM) }) ?? IDENTITY;

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
};
