// PROTOTYPE — 案 D: React Flow の仕組みのまま、見た目を案 C（Plait / Drawnix）に寄せたもの。
// 「C が綺麗に見えるのはライブラリのおかげか、描き方のおかげか」を確かめる。
// 描き方: 種別の淡い塗りと細い枠の角丸ノード、種別色の太く曲がった枝（根元ほど太い）、バッジを使わない。
// 配置は案 A と同じ木レイアウトだが、高さは描画後の実寸を使う（見積もりによる重なりを無くす）。
import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Handle, Position, useReactFlow, useNodesInitialized,
  type Node, type Edge, type NodeProps, type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { KIND_STYLE, type ViewNode } from "./data";
import { layout } from "./VariantFlow";
import type { VariantProps } from "./App";

const COL = 340, GAP_X = 90, GAP_Y = 14;
const estimate = (n: ViewNode) => (n.kind === "会議" ? 60 : 22 + Math.ceil((n.text.length * 15.5) / (COL - 30)) * 22);

type D = { n: ViewNode; selected: boolean; showHot: boolean; depth: number };

function Topic({ data }: NodeProps<Node<D>>) {
  const { n, selected, showHot, depth } = data;
  const k = KIND_STYLE[n.kind]!;
  const fresh = n.changeAge === 0;
  const recent = n.changeAge !== undefined && n.changeAge <= 3;
  const cls = [
    "topic", depth === 0 && "topic-root", depth === 1 && "topic-l1",
    n.status === "却下" && "rejected", fresh && "fresh", !fresh && recent && "recent",
    selected && "selected", showHot && n.hot && "hot",
  ].filter(Boolean).join(" ");
  // 種別は色で伝え、文字では小さな印だけにする（決定・TODO・未決は状態が大事なので印を強める）
  const mark = n.kind === "決定" ? "✓" : n.kind === "TODO" ? "☐" : n.kind === "論点" ? (n.status === "決定済み" ? "✓" : "?") : "";
  return (
    <div className={cls} style={{ ["--c" as string]: k.color, ["--bg" as string]: k.bg, maxWidth: COL }}>
      <Handle type="target" position={Position.Left} />
      {mark && <span className={`mark mark-${n.kind} ${n.status === "決定済み" ? "done" : ""}`}>{mark}</span>}
      <span className="topic-t">{n.text}</span>
      {n.kind === "TODO" && n.assignee && <span className="topic-who">{n.assignee}</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// Plait 風の枝: 親の右端から子の左端へ、種別色の曲線。根元ほど太い
function Branch({ sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<{ color: string; w: number; fresh: boolean }>>) {
  const mx = sourceX + (targetX - sourceX) * 0.5;
  const d = `M ${sourceX} ${sourceY} C ${mx} ${sourceY}, ${mx} ${targetY}, ${targetX} ${targetY}`;
  return <path className={`branch ${data?.fresh ? "branch-fresh" : ""}`} d={d} fill="none" stroke={data?.color} strokeWidth={data?.w} strokeLinecap="round" />;
}

const nodeTypes = { topic: Topic };
const edgeTypes = { branch: Branch };

function Inner({ view, selected, onSelect, showHot, autoFit }: VariantProps) {
  const rf = useReactFlow();
  const initialized = useNodesInitialized();
  // 描画後の実寸。変わったら配置し直す
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const pos = useMemo(() => layout(view, (n) => measured[n.id] ?? estimate(n), COL, GAP_X, GAP_Y), [view, measured]);

  useEffect(() => {
    if (!initialized) return;
    const next: Record<string, number> = {};
    let changed = false;
    for (const n of rf.getNodes()) {
      const h = n.measured?.height;
      if (h) { next[n.id] = h; if (measured[n.id] !== h) changed = true; }
    }
    if (changed) setMeasured(next);
  });

  const nodes: Node<D>[] = view.nodes.map((n) => ({
    id: n.id, type: "topic", position: { x: pos[n.id]!.x, y: pos[n.id]!.y },
    data: { n, selected: selected === n.id, showHot, depth: pos[n.id]!.depth }, draggable: false,
  }));
  const edges: Edge[] = view.nodes.filter((n) => n.parent).map((n) => {
    const depth = pos[n.id]!.depth;
    return {
      id: `${n.parent}-${n.id}`, source: n.parent!, target: n.id, type: "branch",
      data: { color: KIND_STYLE[n.kind]!.color, w: depth <= 1 ? 5 : depth === 2 ? 3.5 : 2.2, fresh: n.changeAge === 0 && n.change === "added" },
    };
  });

  // 反映のたび、または実寸で配置し直したあとに全体を収め直す
  useEffect(() => {
    if (!autoFit) return;
    const id = setTimeout(() => rf.fitView({ duration: 600, padding: 0.06, maxZoom: 1.3 }), 120);
    return () => clearTimeout(id);
  }, [view.step, measured, autoFit, rf]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodeClick={(_, n) => onSelect(n.id)} onPaneClick={() => onSelect(null)}
      nodesConnectable={false} minZoom={0.1} className="soft"
    />
  );
}

export function VariantSoft(p: VariantProps) {
  return <ReactFlowProvider><Inner {...p} /></ReactFlowProvider>;
}
