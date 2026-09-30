// PROTOTYPE — 案 A: React Flow。ノードは自前の React コンポーネント（カード）、配置は自前の左→右の木レイアウト。
// 兄弟は作られた順に並べるので、追加で動くのは「追加された位置より下」だけ。位置の変化は CSS transition で滑らせる。
import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, ReactFlowProvider, Handle, Position, useReactFlow, type Node, type Edge, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CHANGE_LABEL, KIND_STYLE, type View, type ViewNode } from "./data";
import type { VariantProps } from "./App";

const W = 250, GAP_X = 70, GAP_Y = 12;
// 文字数から高さを見積もる（本番では実寸を測る）
const heightOf = (n: ViewNode) => (n.kind === "会議" ? 56 : 40 + Math.ceil((n.text.length * 16) / (W - 28)) * 20);

// 兄弟を作られた順に上から積み、親は子の範囲の中央に置く。案 D も使う
export function layout(view: View, heightOf: (n: ViewNode) => number, colW: number, gapX: number, gapY: number) {
  const pos: Record<string, { x: number; y: number; h: number; depth: number }> = {};
  let cursor = 0;
  const place = (id: string, depth: number): [number, number] => {
    const n = view.byId[id]!;
    const h = heightOf(n);
    const kids = view.children[id] ?? [];
    const top = cursor;
    if (!kids.length) {
      cursor += h + gapY;
      pos[id] = { x: depth * (colW + gapX), y: top, h, depth };
      return [top, top + h];
    }
    const spans = kids.map((k) => place(k, depth + 1));
    const mid = (spans[0]![0] + spans[spans.length - 1]![1]) / 2;
    let y = mid - h / 2;
    if (y < top) y = top;
    pos[id] = { x: depth * (colW + gapX), y, h, depth };
    if (y + h + gapY > cursor) cursor = y + h + gapY;
    return [Math.min(top, y), Math.max(cursor - gapY, y + h)];
  };
  place("root", 0);
  return pos;
}

type CardData = { n: ViewNode; selected: boolean; showHot: boolean };

function Card({ data }: NodeProps<Node<CardData>>) {
  const { n, selected, showHot } = data;
  const k = KIND_STYLE[n.kind]!;
  const fresh = n.changeAge === 0; // いまの反映で変わった
  const recent = n.changeAge !== undefined && n.changeAge <= 3;
  const cls = [
    "card", `k-${n.kind}`,
    n.status === "却下" && "rejected",
    n.status === "決定済み" && "decided",
    n.status === "未決" && "open",
    fresh && `fresh fresh-${n.change}`,
    recent && "recent",
    selected && "selected",
    showHot && n.hot && "hot",
  ].filter(Boolean).join(" ");
  return (
    <div className={cls} style={{ width: W, borderLeftColor: k.color }}>
      <Handle type="target" position={Position.Left} />
      {n.kind !== "会議" && (
        <div className="card-h">
          <span className="kind" style={{ color: k.color, background: k.bg }}>{k.icon} {n.kind}</span>
          {n.status && n.status !== "検討中" && <span className={`st st-${n.status}`}>{n.status}</span>}
          {recent && n.change && <span className={`chg chg-${n.change}`}>{CHANGE_LABEL[n.change]}</span>}
        </div>
      )}
      <div className="card-t">{n.text}</div>
      {n.kind === "TODO" && (n.assignee || n.due) && <div className="todo-m">👤 {n.assignee ?? "—"}　📅 {n.due ?? "—"}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { card: Card };

function Inner({ view, selected, onSelect, showHot, autoFit }: VariantProps) {
  const rf = useReactFlow();
  const pos = useMemo(() => layout(view, heightOf, W, GAP_X, GAP_Y), [view]);
  const nodes: Node<CardData>[] = view.nodes.map((n) => ({
    id: n.id, type: "card", position: { x: pos[n.id]!.x, y: pos[n.id]!.y },
    data: { n, selected: selected === n.id, showHot }, draggable: false,
  }));
  const edges: Edge[] = view.nodes.filter((n) => n.parent).map((n) => ({
    id: `${n.parent}-${n.id}`, source: n.parent!, target: n.id, type: "default",
    className: n.changeAge === 0 ? "edge-fresh" : "",
  }));
  // 反映のたびに全体を画面に収める（自動フィット）。ノード数が増えると文字が小さくなる
  const lastStep = useRef(-2);
  useEffect(() => {
    if (!autoFit || view.step === lastStep.current) return;
    lastStep.current = view.step;
    const id = setTimeout(() => rf.fitView({ duration: 600, padding: 0.08, maxZoom: 1.2 }), 50);
    return () => clearTimeout(id);
  }, [view.step, autoFit, rf]);
  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onSelect(n.id)} onPaneClick={() => onSelect(null)}
      nodesConnectable={false} minZoom={0.1}
      className="flow"
    />
  );
}

export function VariantFlow(p: VariantProps) {
  return <ReactFlowProvider><Inner {...p} /></ReactFlowProvider>;
}
