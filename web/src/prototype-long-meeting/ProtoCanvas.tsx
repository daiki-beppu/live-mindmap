// PROTOTYPE（issue #131）: 案 A・C が共有する React Flow の画面とカメラ。配置は各案が渡す。
import {
  Handle,
  useStore,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  type Edge,
  type Node,
  type NodeChange,
  type NodeDimensionChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { SnapshotNode } from "../../../server/src/core/index.ts";
import { KIND_COLOR, markOf } from "../kinds.ts";
import { NODE_WIDTH, type Position as Pos } from "../layout.ts";
import { useAnimatedPositions } from "../useAnimatedPositions.ts";

export type Hint = "none" | "text" | "count";
export type Camera = "focus" | "glance" | "fit";

// PROTOTYPE（issue #285）: 人が動かす操作。mode は App が持つ（follow: 自動のカメラ／manual: 人が動かした／overview: 全体を見る）
export type ViewMode = "follow" | "manual" | "overview";
export type View = {
  mode: ViewMode;
  minZoom: number; // 人が縮められる下限
  offscreen: boolean; // 画面の外で変わったノードの印を縁に出す
  onUserMove: () => void;
};

type ProtoData = {
  text: string;
  color: string;
  mark: string | null;
  rejected: boolean;
  changedRound: number | null;
  selected: boolean;
  folded: boolean;
  hint: string | null; // 畳んだノードの下に添える文字
  count: number | null; // 畳んだノードの右端に添える、隠れているノードの数
  current: boolean; // 今の議題
  onSelect: (id: string) => void;
};

function ProtoNode({ id, data }: NodeProps<Node<ProtoData, "proto">>) {
  return (
    <div
      key={data.changedRound ?? "steady"}
      className={[
        "map-node",
        data.rejected && "map-node--rejected",
        data.changedRound !== null && "map-node--blink",
        data.folded && "proto-node--folded",
        data.current && "proto-node--current",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--kind-color": data.color } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button type="button" className="map-node__button" aria-pressed={data.selected} onClick={() => data.onSelect(id)}>
        {data.mark && <span className="map-node__mark">{data.mark}</span>}
        <span className="map-node__text">
          {data.text}
          {data.hint && <span className="proto-node__hint">{data.hint}</span>}
        </span>
      </button>
      {data.count !== null && <span className="proto-node__count">{data.count}</span>}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { proto: ProtoNode };

export type CanvasProps = {
  nodes: SnapshotNode[]; // 描くノード（畳んだノードの子孫は除いてある）
  layout: (heights: Record<string, number>) => Record<string, Pos>;
  edges: boolean; // 親子の枝を描くか
  round: number;
  changed: Set<string>;
  folded: Set<string>;
  hints: Record<string, { text: string; count: number }>;
  hint: Hint;
  current: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  camera: Camera;
  focusIds: string[]; // カメラが寄る範囲
  anchorIds: string[]; // 寄る範囲が画面に収まらないとき、優先して見せるノード（直近に変わったノード）
  aimKey: string; // これが変わったら狙い直す
  topicKey: string; // これが変わったら議題が変わった（glance で全体を見せる）
  view?: View;
};

const READABLE_MIN = 0.75; // 画面共有で読める下限の倍率（14px → 10.5px）
const MAX_ZOOM = 1.1;

function Canvas(p: CanvasProps) {
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});
  const { setViewport, fitView } = useReactFlow();
  const store = useStoreApi();

  const onNodesChange = (changes: NodeChange[]) => {
    const measured = changes.filter((c): c is NodeDimensionChange => c.type === "dimensions" && !!c.dimensions);
    if (measured.length === 0) return;
    setDims((prev) => {
      let next: typeof prev | undefined;
      for (const c of measured) {
        const old = prev[c.id];
        if (old && old.width === c.dimensions!.width && old.height === c.dimensions!.height) continue;
        next ??= { ...prev };
        next[c.id] = c.dimensions!;
      }
      return next ?? prev;
    });
  };

  const target = useMemo(() => {
    const heights = Object.fromEntries(Object.entries(dims).map(([id, d]) => [id, d.height]));
    return p.layout(heights);
  }, [p.layout, dims]);
  const positions = useAnimatedPositions(p.nodes, target);

  const nodes = useMemo(
    (): Node[] =>
      p.nodes.map((n): Node<ProtoData, "proto"> => {
        const folded = p.folded.has(n.id);
        const h = p.hints[n.id];
        return {
          id: n.id,
          type: "proto",
          position: positions[n.id] ?? { x: 0, y: 0 },
          width: NODE_WIDTH,
          measured: dims[n.id],
          data: {
            text: n.text,
            color: KIND_COLOR[n.kind],
            mark: markOf(n),
            rejected: n.kind === "案" && n.planStatus === "却下",
            changedRound: p.changed.has(n.id) ? p.round : null,
            selected: n.id === p.selectedId,
            folded,
            hint: folded && h && p.hint === "text" ? h.text : null,
            count: folded && h && p.hint === "count" ? h.count : null,
            current: n.id === p.current,
            onSelect: p.onSelect,
          },
        };
      }),
    [p.nodes, positions, dims, p.folded, p.hints, p.hint, p.changed, p.round, p.selectedId, p.current, p.onSelect],
  );

  const edges = useMemo(
    (): Edge[] =>
      p.edges
        ? p.nodes.flatMap((n) =>
            n.parent && p.nodes.some((m) => m.id === n.parent)
              ? [{ id: `${n.parent}->${n.id}`, source: n.parent, target: n.id, type: "default", style: { stroke: KIND_COLOR[n.kind], strokeWidth: 2 } }]
              : [],
          )
        : [],
    [p.nodes, p.edges],
  );

  // カメラ。配置は補間中も目標（target）で狙う
  const glanceUntil = useRef(0);
  const lastTopic = useRef(p.topicKey);
  useEffect(() => {
    const mode = p.view?.mode ?? "follow";
    if (mode === "manual") return;
    if (mode === "overview") {
      const f = requestAnimationFrame(() => void fitView({ duration: 600, padding: 0.05, minZoom: 0.02, maxZoom: MAX_ZOOM }));
      return () => cancelAnimationFrame(f);
    }
    const aim = () => {
      const { width, height } = store.getState();
      if (!width || !height) return;
      if (p.camera === "fit" || performance.now() < glanceUntil.current) {
        void fitView({ duration: 600, padding: 0.05, minZoom: 0.02, maxZoom: MAX_ZOOM });
        return;
      }
      const box = (ids: string[]) => {
        const ps = ids.flatMap((id) => (target[id] ? [{ ...target[id], h: dims[id]?.height ?? 40 }] : []));
        if (ps.length === 0) return null;
        const x0 = Math.min(...ps.map((q) => q.x));
        const y0 = Math.min(...ps.map((q) => q.y));
        const x1 = Math.max(...ps.map((q) => q.x + NODE_WIDTH));
        const y1 = Math.max(...ps.map((q) => q.y + q.h));
        return { x0, y0, x1, y1 };
      };
      const b = box(p.focusIds);
      if (!b) return;
      const pad = 48;
      const zoom = Math.min(MAX_ZOOM, Math.max(READABLE_MIN, Math.min((width - pad * 2) / (b.x1 - b.x0), (height - pad * 2) / (b.y1 - b.y0))));
      const fitsX = (b.x1 - b.x0) * zoom <= width - pad * 2;
      const fitsY = (b.y1 - b.y0) * zoom <= height - pad * 2;
      const a = box(p.anchorIds) ?? b;
      const cx = fitsX ? (b.x0 + b.x1) / 2 : Math.min(Math.max((a.x0 + a.x1) / 2, b.x0 + (width / 2 - pad) / zoom), b.x1 - (width / 2 - pad) / zoom);
      const cy = fitsY ? (b.y0 + b.y1) / 2 : (a.y0 + a.y1) / 2;
      void setViewport({ x: width / 2 - cx * zoom, y: height / 2 - cy * zoom, zoom }, { duration: 600 });
    };
    if (p.camera === "glance" && lastTopic.current !== p.topicKey) {
      lastTopic.current = p.topicKey;
      glanceUntil.current = performance.now() + 1800;
      const t = setTimeout(aim, 1900);
      aim();
      return () => clearTimeout(t);
    }
    lastTopic.current = p.topicKey;
    const f = requestAnimationFrame(aim);
    return () => cancelAnimationFrame(f);
    // 寸法が測れたら狙い直す（dims）。位置の補間（positions）では狙い直さない
  }, [p.aimKey, p.topicKey, p.camera, target, dims, store, setViewport, fitView, p.view?.mode]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      elementsSelectable={false}
      panOnDrag={!!p.view}
      panOnScroll={!!p.view}
      zoomOnScroll={false}
      zoomOnPinch={!!p.view}
      zoomActivationKeyCode={p.view ? ["Meta", "Control"] : null}
      zoomOnDoubleClick={false}
      panActivationKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      deleteKeyCode={null}
      minZoom={p.view?.mode === "overview" ? 0.02 : (p.view?.minZoom ?? 0.02)}
      maxZoom={2}
      onMoveStart={(e) => e && p.view?.onUserMove()}
      onMove={(e) => e && p.view?.onUserMove()}
      proOptions={{ hideAttribution: true }}
    >
      {p.view?.offscreen && p.view.mode !== "follow" && <Offscreen ids={[...p.changed]} target={target} dims={dims} round={p.round} />}
    </ReactFlow>
  );
}

// 画面の外で変わったノードを、その方向の縁に小さな点と議題の文字で知らせる。押すとそのノードへ移す（人の操作のまま）
function Offscreen({ ids, target, dims, round }: { ids: string[]; target: Record<string, Pos>; dims: Record<string, { width: number; height: number }>; round: number }) {
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const { setCenter } = useReactFlow();
  const m = 14;
  const marks = ids.flatMap((id) => {
    const q = target[id];
    if (!q) return [];
    const h = dims[id]?.height ?? 40;
    const sx = tx + (q.x + NODE_WIDTH / 2) * zoom;
    const sy = ty + (q.y + h / 2) * zoom;
    const inside = tx + (q.x + NODE_WIDTH) * zoom > 0 && tx + q.x * zoom < width && ty + (q.y + h) * zoom > 0 && ty + q.y * zoom < height;
    if (inside) return [];
    return [{ id, x: Math.min(Math.max(sx, m), width - m), y: Math.min(Math.max(sy, m), height - m), cx: q.x + NODE_WIDTH / 2, cy: q.y + h / 2 }];
  });
  // 縁で重なる印は 1 つにまとめる
  const shown = marks.filter((k, i) => marks.findIndex((o) => Math.hypot(o.x - k.x, o.y - k.y) < 20) === i);
  return (
    <>
      {shown.map((k) => (
        <button
          key={`${k.id}:${round}`}
          type="button"
          className="proto-offscreen"
          style={{ left: k.x, top: k.y }}
          title="画面の外で変わったノード"
          onClick={() => void setCenter(k.cx, k.cy, { zoom: Math.max(zoom, 0.75), duration: 400 })}
        />
      ))}
    </>
  );
}

export function ProtoCanvas(p: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...p} />
    </ReactFlowProvider>
  );
}
