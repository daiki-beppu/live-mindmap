import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeDimensionChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "../../server/src/core/index.ts";
import { changedNodeIds } from "./changes.ts";
import { KIND_COLOR, markOf } from "./kinds.ts";
import { layout, NODE_WIDTH } from "./layout.ts";
import { MapNode, type MapNodeData } from "./MapNode.tsx";
import { useAnimatedPositions } from "./useAnimatedPositions.ts";

const nodeTypes = { map: MapNode };

type Dims = Record<string, { width: number; height: number }>;

type SelectProps = { selectedId: string | null; onSelect: (nodeId: string) => void };

function MapCanvas({ snapshot, selectedId, onSelect }: { snapshot: Snapshot } & SelectProps) {
  // React Flow が測った実寸。スナップショットが変わっても捨てない（測り直しは onNodesChange で上書きされる）。
  const [dims, setDims] = useState<Dims>({});
  const { fitView } = useReactFlow();

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
  const positions = useAnimatedPositions(snapshot.nodes, target);

  const nodes = useMemo(() => {
    const changed = changedNodeIds(snapshot);
    return snapshot.nodes.map((n): Node<MapNodeData, "map"> => ({
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
        changedRound: changed.has(n.id) ? snapshot.round : null,
        selected: n.id === selectedId,
        onSelect,
      },
    }));
  }, [snapshot, positions, dims, selectedId, onSelect]);

  const edges = useMemo(
    (): Edge[] =>
      snapshot.nodes.flatMap((n) =>
        n.parent ? [{ id: `${n.parent}->${n.id}`, source: n.parent, target: n.id, style: { stroke: KIND_COLOR[n.kind], strokeWidth: 2 } }] : [],
      ),
    [snapshot.nodes],
  );

  // 反映のたびに（位置・寸法が変わるたびに）全体を画面に収める
  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView({ duration: 0, padding: 0.1 }));
    return () => cancelAnimationFrame(frame);
  }, [nodes, fitView]);

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
      proOptions={{ hideAttribution: true }}
    />
  );
}

export function MapView({ snapshot, selectedId, onSelect }: { snapshot: Snapshot } & SelectProps) {
  return (
    <ReactFlowProvider>
      <MapCanvas snapshot={snapshot} selectedId={selectedId} onSelect={onSelect} />
    </ReactFlowProvider>
  );
}
