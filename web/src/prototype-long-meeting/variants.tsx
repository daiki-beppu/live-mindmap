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
  runs: boolean; // A: 済みの兄弟の議題が 2 つ以上続いたら 1 つにまとめる
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

// A のまとめ: 同じ親の下で、畳んだ議題が 2 つ以上続いたら「済みの議題 N 件」の 1 ノードに置き換える
function collapseRuns(visible: SnapshotNode[], folded: Set<string>, keep: Set<string>) {
  const kids = new Map<string, SnapshotNode[]>();
  for (const n of visible) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const replaced = new Map<string, SnapshotNode | null>(); // 元の ID → まとめたノード（先頭）か null（消す）
  const members: Record<string, string[]> = {};
  for (const [pid, list] of kids) {
    let run: SnapshotNode[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const id = `run:${run[0]!.id}`;
        members[id] = run.map((r) => r.id);
        const node: SnapshotNode = { id, parent: pid, kind: "議題", text: `議題 ${run.length} 件`, evidence: [] };
        run.forEach((r, i) => replaced.set(r.id, i === 0 ? node : null));
      }
      run = [];
    };
    for (const k of list) {
      if (k.kind === "議題" && folded.has(k.id) && !keep.has(k.id)) run.push(k);
      else flush();
    }
    flush();
  }
  const nodes = visible.flatMap((n) => (replaced.has(n.id) ? (replaced.get(n.id) ? [replaced.get(n.id)!] : []) : [n]));
  return { nodes, members };
}

export function VariantA(p: VariantProps) {
  const c = useCommon(p);
  const { nodes, members, folded, hints, changed, focusIds } = useMemo(() => {
    const keep = new Set<string>(p.frame.current ? [p.frame.current] : []);
    const r = p.runs ? collapseRuns(c.visible, p.folded, keep) : { nodes: c.visible, members: {} as Record<string, string[]> };
    const folded = new Set([...p.folded, ...Object.keys(r.members)]);
    const hints = { ...c.hints };
    const changed = new Set(c.changed);
    for (const [id, ms] of Object.entries(r.members)) {
      const titles = ms.map((m) => c.byId.get(m)!.text);
      hints[id] = { text: `${titles[0]} 〜 ${titles.at(-1)}`, count: ms.length };
      if (ms.some((m) => changed.has(m))) changed.add(id);
    }
    // カメラは今の議題に加えて、祖先の議題（入れ子の親）も入れる
    const chain: string[] = [];
    for (let cur = p.focusTopic ? c.byId.get(p.focusTopic)?.parent : undefined; cur && cur !== "root"; cur = c.byId.get(cur)?.parent) chain.push(cur);
    return { ...r, folded, hints, changed, focusIds: [...c.focusIds, ...chain] };
  }, [c, p.folded, p.runs, p.frame.current, p.focusTopic]);
  const lay = useCallback((h: Record<string, number>) => layout(nodes, h), [nodes]);
  void members;
  return (
    <ProtoCanvas
      nodes={nodes}
      layout={lay}
      edges
      round={p.frame.snapshot.round}
      changed={changed}
      folded={folded}
      hints={hints}
      hint={p.hint}
      current={p.frame.current}
      selectedId={p.selectedId}
      onSelect={p.onSelect}
      camera={p.camera}
      focusIds={focusIds}
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
  // 目次: 議題を作られた順に、入れ子の深さで字下げする。済みの親の議題の子は、見ている議題の親でなければ隠す
  const depthOf = (id: string) => {
    let d = 0;
    for (let cur = c.byId.get(id)?.parent; cur && cur !== "root"; cur = c.byId.get(cur)?.parent) d++;
    return d;
  };
  const shown = p.focusTopic;
  const chain: string[] = []; // 見ている議題の祖先の議題
  for (let cur = shown ? c.byId.get(shown)?.parent : undefined; cur && cur !== "root"; cur = c.byId.get(cur)?.parent) chain.unshift(cur);
  const topics: typeof snapshot.nodes = [];
  const walkTopics = (pid: string) => {
    for (const n of snapshot.nodes) {
      if (n.parent !== pid || n.kind !== "議題") continue;
      topics.push(n);
      if (!closed.has(n.id) || chain.includes(n.id)) walkTopics(n.id);
    }
  };
  walkTopics("root");
  // キャンバス: 祖先の議題を 1 本の鎖でつなぎ、その先に見ている議題の木（写真 ─ 写真1 ─ 話題）
  const nodes = useMemo(() => {
    if (shown === null) return [];
    const sub = c.visible.filter((n) => n.id !== shown && topicOf(c.byId, n.id) === shown);
    const head = [...chain, shown].map((id, i, all) => ({ ...c.byId.get(id)!, parent: i === 0 ? null : all[i - 1]! }));
    return [...head, ...sub];
  }, [c, shown, chain.join()]);
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
            style={{ paddingLeft: depthOf(t.id) * 16 }}
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
