// PROTOTYPE（issue #131）: 長い会議の画面の 3 案。どれも「今の議題を見せる・済みの議題を畳む」を、違う構造で描く。
//   A 一本の木: 今の作りの左 → 右の木のまま、済みの議題を 1 ノードに畳み、カメラが今の議題に寄る
//   B 今の議題だけ: マップには今の議題の木だけを大きく描き、左端に議題の目次（話し中・済み）を置く
//   C 議題の格子: 会議のノードを描かず、議題を作られた順に縦の段へ詰めて折り返す。横の余りを使う
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { SnapshotNode } from "../../../server/src/core/index.ts";
import { GAP_X, GAP_Y, layout, NODE_WIDTH, type Position } from "../layout.ts";
import { hiddenIds, hintText, summaryOf, topicOf, type Frame } from "./data.ts";
import { ProtoCanvas, type Camera, type Hint } from "./ProtoCanvas.tsx";

export type VariantProps = {
  frame: Frame;
  folded: Set<string>;
  focusTopic: string | null; // カメラが寄る議題（今の議題、選択があればその議題）
  hint: Hint;
  camera: Camera;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPickTopic: (id: string) => void;
};

function useCommon({ frame, folded, focusTopic }: VariantProps) {
  const { snapshot } = frame;
  return useMemo(() => {
    const hidden = hiddenIds(snapshot.nodes, folded);
    const visible = snapshot.nodes.filter((n) => !hidden.has(n.id));
    const hints: Record<string, { text: string; count: number }> = {};
    for (const id of folded) hints[id] = { text: hintText(snapshot.nodes, id), count: summaryOf(snapshot.nodes, id).total };
    const changed = new Set(snapshot.changes.filter((c) => c.round === snapshot.round).map((c) => c.node));
    // 変わったノードが畳んだ議題の中なら、畳んだノードを光らせる
    const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
    for (const id of [...changed]) {
      if (!hidden.has(id)) continue;
      let cur = byId.get(id);
      while (cur && hidden.has(cur.id)) cur = cur.parent ? byId.get(cur.parent) : undefined;
      if (cur) changed.add(cur.id);
    }
    const inTopic = (id: string) => focusTopic !== null && topicOf(byId, id) === focusTopic;
    const focusIds = visible.filter((n) => inTopic(n.id)).map((n) => n.id);
    const anchorIds = [...changed].filter((id) => inTopic(id) && !hidden.has(id));
    return { visible, hints, changed, focusIds, anchorIds, byId };
  }, [snapshot, folded, focusTopic]);
}

export function VariantA(p: VariantProps) {
  const c = useCommon(p);
  const lay = useCallback((h: Record<string, number>) => layout(c.visible, h), [c.visible]);
  return (
    <ProtoCanvas
      nodes={c.visible}
      layout={lay}
      edges
      round={p.frame.snapshot.round}
      changed={c.changed}
      folded={p.folded}
      hints={c.hints}
      hint={p.hint}
      current={p.frame.current}
      selectedId={p.selectedId}
      onSelect={p.onSelect}
      camera={p.camera}
      focusIds={c.focusIds}
      anchorIds={c.anchorIds}
      aimKey={`${p.frame.snapshot.round}:${p.focusTopic}`}
      topicKey={String(p.focusTopic)}
    />
  );
}

// C: 議題ごとの木を、作られた順に縦の段へ詰める。段の高さを超えたら右の段へ折り返す
function gridLayout(nodes: SnapshotNode[], heights: Record<string, number>, columnHeight: number): Record<string, Position> {
  const topics = nodes.filter((n) => n.kind === "議題" && n.parent === "root");
  const result: Record<string, Position> = {};
  const byParent = new Map<string, SnapshotNode[]>();
  for (const n of nodes) if (n.parent) byParent.set(n.parent, [...(byParent.get(n.parent) ?? []), n]);
  let x = 0;
  let y = 0;
  let colWidth = 0;
  for (const t of topics) {
    const sub: SnapshotNode[] = [];
    const walk = (id: string) => (byParent.get(id) ?? []).forEach((k) => (sub.push(k), walk(k.id)));
    walk(t.id);
    const pos = layout([{ ...t, parent: null }, ...sub], heights);
    const ys = Object.entries(pos).map(([id, q]) => [q.y, q.y + (heights[id] ?? 40)] as const);
    const h = Math.max(...ys.map((v) => v[1])) - Math.min(...ys.map((v) => v[0]));
    const w = Math.max(...Object.values(pos).map((q) => q.x)) + NODE_WIDTH;
    if (y > 0 && y + h > columnHeight) {
      x += colWidth + GAP_X * 1.5;
      y = 0;
      colWidth = 0;
    }
    const top = Math.min(...ys.map((v) => v[0]));
    for (const [id, q] of Object.entries(pos)) result[id] = { x: q.x + x, y: q.y - top + y };
    y += h + GAP_Y * 3;
    colWidth = Math.max(colWidth, w);
  }
  return result;
}

export function VariantC(p: VariantProps) {
  const c = useCommon(p);
  const nodes = useMemo(() => c.visible.filter((n) => n.parent !== null), [c.visible]);
  const lay = useCallback((h: Record<string, number>) => gridLayout(nodes, h, 1500), [nodes]);
  return (
    <ProtoCanvas
      nodes={nodes}
      layout={lay}
      edges
      round={p.frame.snapshot.round}
      changed={c.changed}
      folded={p.folded}
      hints={c.hints}
      hint={p.hint}
      current={p.frame.current}
      selectedId={p.selectedId}
      onSelect={p.onSelect}
      camera={p.camera}
      focusIds={c.focusIds}
      anchorIds={c.anchorIds}
      aimKey={`${p.frame.snapshot.round}:${p.focusTopic}`}
      topicKey={String(p.focusTopic)}
    />
  );
}

// B: 今の議題（選んだ議題）の木だけ。左端に議題の目次
export function VariantB(p: VariantProps) {
  const c = useCommon(p);
  const { snapshot, closed, current, lastTouched } = p.frame;
  const topics = snapshot.nodes.filter((n) => n.kind === "議題" && n.parent === "root");
  const shown = p.focusTopic;
  const nodes = useMemo(() => c.visible.filter((n) => n.id === shown || (n.id !== shown && shown !== null && topicOf(c.byId, n.id) === shown)).map((n) => (n.id === shown ? { ...n, parent: null } : n)), [c, shown]);
  const lay = useCallback((h: Record<string, number>) => layout(nodes, h), [nodes]);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-id="${shown}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [shown]);
  return (
    <div className="proto-b">
      <ol className="proto-b__toc" ref={listRef}>
        {topics.map((t) => (
          <li
            key={t.id}
            data-id={t.id}
            className={["proto-b__item", closed.has(t.id) && "proto-b__item--closed", t.id === shown && "proto-b__item--shown", t.id === current && "proto-b__item--current"].filter(Boolean).join(" ")}
          >
            <button type="button" onClick={() => p.onPickTopic(t.id)}>
              <span className="proto-b__title">{t.text}</span>
              {closed.has(t.id) && p.hint !== "none" && <span className="proto-b__hint">{hintText(snapshot.nodes, t.id)}</span>}
              {!closed.has(t.id) && lastTouched[t.id] !== undefined && <span className="proto-b__hint">{Math.round((p.frame.at - lastTouched[t.id]!) / 60)} 分前</span>}
            </button>
          </li>
        ))}
      </ol>
      <div className="proto-b__canvas">
        <ProtoCanvas
          nodes={nodes}
          layout={lay}
          edges
          round={snapshot.round}
          changed={c.changed}
          folded={p.folded}
          hints={c.hints}
          hint={p.hint}
          current={null}
          selectedId={p.selectedId}
          onSelect={p.onSelect}
          camera={p.camera === "fit" ? "fit" : "focus"}
          focusIds={nodes.map((n) => n.id)}
          anchorIds={c.anchorIds}
          aimKey={`${snapshot.round}:${shown}`}
          topicKey={String(shown)}
        />
      </div>
    </div>
  );
}

export const VARIANTS = {
  A: { name: "一本の木", C: VariantA },
  B: { name: "今の議題だけ＋目次", C: VariantB },
  C: { name: "議題の格子", C: VariantC },
} as const;
export type VariantKey = keyof typeof VARIANTS;
