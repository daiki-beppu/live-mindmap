import {
  getNodesBounds,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  type Edge,
  type Node,
  type NodeChange,
  type NodeDimensionChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "../../server/src/core/index.ts";
import { cameraFocus, focusViewport, nodeRect, shouldMoveCamera } from "./camera.ts";
import { changedNodeIds } from "./changes.ts";
import { KIND_COLOR, markOf } from "./kinds.ts";
import { layout, NODE_WIDTH } from "./layout.ts";
import { MapNode, type MapNodeData } from "./MapNode.tsx";
import { useAnimatedPositions } from "./useAnimatedPositions.ts";

const nodeTypes = { map: MapNode };

type Dims = Record<string, { width: number; height: number }>;

type SelectProps = { selectedId: string | null; onSelect: (nodeId: string) => void };

// still は map.png の撮影用: 変わったノードの強調と位置の補間をなくし、大きなマップも全体を収める。
// onFitted は still のとき、全ノードが測られ、全体を収めようとした後に呼ぶ。引数は、全ノードが画面に収まったか（撮る合図の判断材料）。
type StillProps = { still?: boolean; onFitted?: (fitsAll: boolean) => void };

// 撮影では、既定の最小倍率（0.5）より小さくして、大きなマップも収める。この下限でも収まらない場合は onFitted(false) で知らせる
const STILL_MIN_ZOOM = 0.02;

function MapCanvas({ snapshot, selectedId, onSelect, still = false, onFitted }: { snapshot: Snapshot } & SelectProps & StillProps) {
  // React Flow が測った実寸。スナップショットが変わっても捨てない（測り直しは onNodesChange で上書きされる）。
  const [dims, setDims] = useState<Dims>({});
  const { fitView, getViewport, setViewport } = useReactFlow();
  const storeApi = useStoreApi();
  // 最後に今の議題へ寄せた反映の round。変更の無い反映では寄せ直さない
  const placedRound = useRef<number | null>(null);

  const onNodesChange = (changes: NodeChange[]) => {
    const measured = changes.filter((c): c is NodeDimensionChange => c.type === "dimensions" && !!c.dimensions);
    if (measured.length === 0) return;
    setDims((prev) => {
      let next: Dims | undefined;
      for (const c of measured) {
        const d = c.dimensions!;
        const old = prev[c.id];
        if (old && old.width === d.width && old.height === d.height) continue;
        next ??= { ...prev };
        next[c.id] = d;
      }
      return next ?? prev;
    });
  };

  // 目標の位置。表示する位置は、ここへ向けて補間する
  const target = useMemo(() => {
    const heights = Object.fromEntries(Object.entries(dims).map(([id, d]) => [id, d.height]));
    return layout(snapshot.nodes, heights);
  }, [snapshot.nodes, dims]);
  const animated = useAnimatedPositions(snapshot.nodes, target);
  const positions = still ? target : animated;

  const nodes = useMemo((): Node[] => {
    const changed = changedNodeIds(snapshot);
    const formal = snapshot.nodes.map((n): Node<MapNodeData, "map"> => ({
      id: n.id,
      type: "map",
      position: positions[n.id] ?? { x: 0, y: 0 },
      width: NODE_WIDTH,
      measured: dims[n.id],
      data: {
        text: n.text,
        color: KIND_COLOR[n.kind],
        mark: markOf(n),
        rejected: n.kind === "案" && n.planStatus === "却下",
        changedRound: !still && changed.has(n.id) ? snapshot.round : null,
        selected: n.id === selectedId,
        onSelect,
      },
    }));
    return formal;
  }, [snapshot, positions, dims, selectedId, onSelect, still]);

  const edges = useMemo((): Edge[] => {
    return snapshot.nodes.flatMap((n) =>
      n.parent ? [{ id: `${n.parent}->${n.id}`, source: n.parent, target: n.id, style: { stroke: KIND_COLOR[n.kind], strokeWidth: 2 } }] : [],
    );
  }, [snapshot.nodes]);

  // 反映のたびに（位置・寸法が変わるたびに）、撮影では全体を、ふだんは今の議題を画面に収める。今の議題が無いときも全体を収める
  useEffect(() => {
    const focus = still ? null : cameraFocus(snapshot);
    if (focus) {
      // 補間中の位置ではなく目標の位置で測る
      if (!shouldMoveCamera(snapshot, placedRound.current)) return;
      const frame = requestAnimationFrame(() => {
        const { width, height } = storeApi.getState();
        const rects = focus.ids.map((id) => nodeRect(id, target, dims));
        placedRound.current = snapshot.round;
        void setViewport(focusViewport(rects, nodeRect(focus.center, target, dims), { width, height }), { duration: 0 });
      });
      return () => cancelAnimationFrame(frame);
    }
    placedRound.current = null;
    // 撮影では、すべての正式なノードが測られた後の配置を収めようとしてから、収まったかを知らせる
    const measured = snapshot.nodes.every((n) => dims[n.id]);
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      void fitView({ duration: 0, padding: 0.1, ...(still ? { minZoom: STILL_MIN_ZOOM } : {}) }).then(() => {
        if (!still || !measured || cancelled) return;
        // fitView は下限の倍率で止まっても成功を返すので、実際に全体が画面に収まったかを自分で確かめる
        const b = getNodesBounds(nodes);
        const { x, y, zoom } = getViewport();
        const { width, height } = storeApi.getState();
        onFitted?.(
          b.x * zoom + x >= 0 && b.y * zoom + y >= 0 && (b.x + b.width) * zoom + x <= width && (b.y + b.height) * zoom + y <= height,
        );
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [nodes, fitView, getViewport, setViewport, storeApi, still, snapshot, target, dims, onFitted]);

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
      panOnDrag={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      {...(still ? { minZoom: STILL_MIN_ZOOM } : {})}
      proOptions={{ hideAttribution: true }}
    />
  );
}

export function MapView({ snapshot, selectedId, onSelect, still, onFitted }: { snapshot: Snapshot } & SelectProps & StillProps) {
  return (
    <ReactFlowProvider>
      <MapCanvas snapshot={snapshot} selectedId={selectedId} onSelect={onSelect} still={still} onFitted={onFitted} />
    </ReactFlowProvider>
  );
}
