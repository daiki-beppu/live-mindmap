// PROTOTYPE — 案 B: markmap。線の上に文字を置く古典的なマインドマップ。setData で差し替えると d3 の transition で動く。
// markmap はノードの同一性を「並び順の連番＋本文」で決めるため、そのままだと追加のたびに後ろのノードが全部作り直される。
// 内部メソッド _initializeData を上書きして、キーを「ノード id＋本文」にしている（本文が変わったノードだけ作り直しになる）。
import { useEffect, useRef } from "react";
import { Markmap } from "markmap-view";
import type { INode, IPureNode } from "markmap-common";
import { KIND_STYLE, type View } from "./data";
import type { VariantProps } from "./App";

// 型の上では private なので、プロトタイプごと上書きする
const proto = Markmap.prototype as any;
const origInit = proto._initializeData;
proto._initializeData = function (node: IPureNode) {
  const r = origInit.call(this, node) as INode;
  const walk = (n: INode) => { n.state.key = `${n.payload?.id}|${n.content}`; n.children.forEach(walk); };
  walk(r);
  return r;
};

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

function toTree(view: View, id: string): IPureNode {
  const n = view.byId[id]!;
  const k = KIND_STYLE[n.kind]!;
  const status = n.status === "決定済み" ? " ✅" : n.status === "未決" ? " ⏳" : "";
  const text = n.status === "却下" ? `<s>${esc(n.text)}</s>` : esc(n.text);
  const todo = n.kind === "TODO" && n.assignee ? ` <small>（${esc(n.assignee)}）</small>` : "";
  const content = n.kind === "会議" ? `<b>${esc(n.text)}</b>` : `<span class="mk-kind" style="color:${k.color};background:${k.bg}">${k.icon}${n.kind}</span> ${text}${todo}${status}`;
  return { content, payload: { id, kind: n.kind }, children: (view.children[id] ?? []).map((c) => toTree(view, c)) };
}

export function VariantMarkmap({ view, selected, onSelect, showHot, autoFit }: VariantProps) {
  const svg = useRef<SVGSVGElement>(null);
  const mm = useRef<Markmap | null>(null);
  const onSel = useRef(onSelect); onSel.current = onSelect;

  useEffect(() => {
    mm.current = Markmap.create(svg.current!, {
      duration: 500, maxWidth: 280, spacingVertical: 8, paddingX: 10, autoFit: false, initialExpandLevel: -1,
      color: (n: INode) => KIND_STYLE[(n.payload?.kind as string) ?? "会議"]!.color,
    });
    return () => { mm.current?.destroy(); mm.current = null; };
  }, []);

  const lastStep = useRef(-2);
  useEffect(() => {
    const m = mm.current;
    if (!m) return;
    const stepChanged = view.step !== lastStep.current;
    lastStep.current = view.step;
    const decorate = () => {
      // 変化の強調は本文に入れず（入れるとキーが変わる）、描画後に g 要素のクラスで付ける
      m.g.selectAll<SVGGElement, INode>("g.markmap-node")
        .classed("mk-fresh", (d: INode) => view.byId[d.payload?.id as string]?.changeAge === 0)
        .classed("mk-recent", (d: INode) => { const a = view.byId[d.payload?.id as string]?.changeAge; return a !== undefined && a <= 3; })
        .classed("mk-hot", (d: INode) => showHot && !!view.byId[d.payload?.id as string]?.hot)
        .classed("mk-selected", (d: INode) => d.payload?.id === selected)
        .on("click.sel", (_e: unknown, d: INode) => onSel.current(d.payload?.id as string));
    };
    if (stepChanged) {
      m.setData(toTree(view, "root")).then(() => { decorate(); if (autoFit) m.fit(); });
    } else decorate();
  }, [view, selected, showHot, autoFit]);

  return <svg ref={svg} className="markmap" onClick={(e) => { if (e.target === svg.current) onSelect(null); }} />;
}
