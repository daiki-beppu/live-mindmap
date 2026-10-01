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
import { KIND_COLOR, markOf } from "./kinds.ts";
import { layout, NODE_WIDTH } from "./layout.ts";
import { MapNode, type MapNodeData } from "./MapNode.tsx";

const nodeTypes = { map: MapNode };

type Dims = Record<string, { width: number; height: number }>;

function MapCanvas({ snapshot }: { snapshot: Snapshot }) {
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

  const { nodes, edges } = useMemo(() => {
    const heights = Object.fromEntries(Object.entries(dims).map(([id, d]) => [id, d.height]));
    const pos = layout(snapshot.nodes, heights);
    const nodes: Node<MapNodeData, "map">[] = snapshot.nodes.map((n) => ({
      id: n.id,
      type: "map",
      position: pos[n.id] ?? { x: 0, y: 0 },
      width: NODE_WIDTH,
      measured: dims[n.id],
      data: {
        text: n.text,
        color: KIND_COLOR[n.kind],
        mark: markOf(n),
        rejected: n.kind === "案" && n.planStatus === "却下",
      },
    }));
    const edges: Edge[] = snapshot.nodes.flatMap((n) =>
      n.parent ? [{ id: `${n.parent}->${n.id}`, source: n.parent, target: n.id, style: { stroke: KIND_COLOR[n.kind], strokeWidth: 2 } }] : [],
    );
    return { nodes, edges };
  }, [snapshot, dims]);

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
      elementsSelectable={false}
      panOnDrag={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
    />
  );
}

export function MapView({ snapshot }: { snapshot: Snapshot }) {
  return (
    <ReactFlowProvider>
      <MapCanvas snapshot={snapshot} />
    </ReactFlowProvider>
  );
}
