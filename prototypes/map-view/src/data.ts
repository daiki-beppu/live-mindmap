// PROTOTYPE — issue #7。ラン結果の再生と、表示用のビューモデル（何が変わったか・いまどこの話か）を作る。
// 語彙は CONTEXT.md に従う。型は prototype/diff-engine の map.ts の写し。

export type Kind = "議題" | "論点" | "案" | "決定" | "課題" | "TODO";
export type Segment = { id: string; start: number; end: number; track: string; text: string };
export type MapNode = {
  id: string;
  parent: string | null;
  kind: Kind | "会議";
  text: string;
  proposalStatus?: "検討中" | "却下";
  assignee?: string;
  due?: string;
  evidence: string[];
  createdAt: number;
  updatedAt: number;
};
export type MindMap = { nodes: Record<string, MapNode>; order: string[]; nextId: number };
export type Step = {
  at: number;
  applyAt: number; // at + Claude の応答時間。マップに反映される時刻
  segIds: string[];
  results: { op: string; nodeId?: string }[];
  map: MindMap;
};
export type Run = { name: string; segments: Segment[]; steps: Step[] };

export type Change = "added" | "updated" | "decided" | "rejected" | "moved" | "merged";
export type ChangeEvent = { step: number; at: number; nodeId: string; change: Change; text: string; kind: string; synthetic?: boolean };

export type ViewNode = {
  id: string;
  parent: string | null;
  kind: MapNode["kind"];
  text: string;
  status?: "未決" | "決定済み" | "検討中" | "却下";
  assignee?: string;
  due?: string;
  evidence: string[];
  change?: Change; // 直近に起きた変化
  changeAge?: number; // その変化から何回の反映が経ったか（0 = いまの反映）
  hot: boolean; // 「いま話している」仮表示の対象
};
export type View = {
  t: number;
  step: number; // -1 = まだ何も反映されていない
  nodes: ViewNode[]; // order 順
  byId: Record<string, ViewNode>;
  children: Record<string, string[]>;
  feed: ChangeEvent[]; // 新しい順
  pendingSegs: string[]; // 話し終わったがまだマップに反映されていない発言
};

export async function loadRun(name: string): Promise<Run> {
  return (await fetch(`/data/${name}.json`)).json();
}
export async function listRuns(): Promise<string[]> {
  return (await fetch(`/data/index.json`)).json();
}

// 実際のランでは統合と移動が 0 回なので、見せ方を試すために手で作った操作を混ぜる。
// ある反映以降のすべてのマップに同じ変形をかける。
type Synthetic = { step: number; kind: "move" | "merge"; node: string; target: string };

function pickSynthetic(run: Run): Synthetic[] {
  const out: Synthetic[] = [];
  const n = run.steps.length;
  const sMove = Math.floor(n * 0.45), sMerge = Math.floor(n * 0.65);
  const mm = run.steps[sMove]!.map;
  const nodes = mm.order.map((k) => mm.nodes[k]!);
  // 移動: 議題か論点の直下の葉を、同じ種別の別の親（別の議題・別の論点）の下へ
  for (const x of nodes) {
    if (x.kind === "議題" || x.kind === "会議" || x.kind === "決定") continue;
    const p = mm.nodes[x.parent!]!;
    const isLeaf = !nodes.some((c) => c.parent === x.id);
    const other = nodes.find((a) => a.kind === p.kind && a.id !== p.id);
    if ((p.kind === "議題" || p.kind === "論点") && isLeaf && other) { out.push({ step: sMove, kind: "move", node: x.id, target: other.id }); break; }
  }
  // 統合: 同じ親を持つ同じ種別の兄弟（後の方を前の方へ）
  const m2 = run.steps[sMerge]!.map;
  const ns2 = m2.order.map((k) => m2.nodes[k]!);
  outer: for (const a of ns2) {
    if (a.kind !== "案" && a.kind !== "課題") continue;
    for (const b of ns2) {
      if (b.id !== a.id && b.parent === a.parent && b.kind === a.kind && m2.order.indexOf(b.id) > m2.order.indexOf(a.id)
        && !out.some((o) => o.node === a.id || o.node === b.id)) {
        out.push({ step: sMerge, kind: "merge", node: b.id, target: a.id });
        break outer;
      }
    }
  }
  return out;
}

function transform(map: MindMap, syn: Synthetic[], step: number): MindMap {
  const active = syn.filter((s) => s.step <= step);
  if (!active.length) return map;
  const m: MindMap = structuredClone(map);
  for (const s of active) {
    const x = m.nodes[s.node], tgt = m.nodes[s.target];
    if (!x || !tgt) continue;
    if (s.kind === "move") x.parent = tgt.id;
    else {
      for (const k of m.order) if (m.nodes[k]!.parent === x.id) m.nodes[k]!.parent = tgt.id;
      for (const e of x.evidence) if (!tgt.evidence.includes(e)) tgt.evidence.push(e);
      delete m.nodes[x.id];
      m.order = m.order.filter((k) => k !== x.id);
    }
  }
  return m;
}

const issueStatus = (m: MindMap, id: string) =>
  m.order.some((k) => m.nodes[k]!.parent === id && m.nodes[k]!.kind === "決定") ? "決定済み" : "未決";

// 再生の前処理: 各反映でのマップ（変形後）と、その反映で起きた変化の一覧
export type Prepared = { run: Run; maps: MindMap[]; events: ChangeEvent[][]; synthetic: Synthetic[] };

export function prepare(run: Run, withSynthetic: boolean): Prepared {
  const synthetic = withSynthetic ? pickSynthetic(run) : [];
  const maps = run.steps.map((s, i) => transform(s.map, synthetic, i));
  const events: ChangeEvent[][] = maps.map((m, i) => {
    const prev = i > 0 ? maps[i - 1]! : null;
    const at = run.steps[i]!.applyAt;
    const ev: ChangeEvent[] = [];
    const push = (nodeId: string, change: Change, synth = false) => {
      const n = m.nodes[nodeId] ?? prev?.nodes[nodeId];
      ev.push({ step: i, at, nodeId, change, text: n?.text ?? "", kind: n?.kind ?? "", synthetic: synth });
    };
    for (const id of m.order) {
      const n = m.nodes[id]!, p = prev?.nodes[id];
      if (n.kind === "会議") continue;
      if (!p) { push(id, "added"); continue; }
      if (n.kind === "論点" && prev && issueStatus(prev, id) !== issueStatus(m, id)) push(id, "decided");
      else if (n.proposalStatus === "却下" && p.proposalStatus !== "却下") push(id, "rejected");
      else if (n.parent !== p.parent) push(id, "moved", synthetic.some((s) => s.step === i && s.node === id));
      else if (synthetic.some((s) => s.step === i && s.kind === "merge" && s.target === id)) push(id, "merged", true);
      else if (n.text !== p.text || n.evidence.length !== p.evidence.length) push(id, "updated");
    }
    return ev;
  });
  return { run, maps, events, synthetic };
}

// 「いま話している」仮表示（System One モデルの代わり）。
// Jev は発言ごとに約 0.2 秒で関係ノードを返せた（Claude の更新先との一致 86%）。
// ここでは、まだ反映されていない次の呼び出しが実際に触ったノードを、発言が終わって 0.2 秒後から光らせて代用する。
function hotNodes(p: Prepared, t: number, step: number): { hot: Set<string>; pending: string[] } {
  const next = p.run.steps[step + 1];
  const hot = new Set<string>();
  if (!next) return { hot, pending: [] };
  const segEnd = new Map(p.run.segments.map((s) => [s.id, s.end]));
  const pending = next.segIds.filter((id) => (segEnd.get(id) ?? Infinity) + 0.2 <= t);
  if (!pending.length) return { hot, pending };
  const cur = p.maps[step] ?? p.maps[0]!;
  for (const r of next.results) {
    if (!r.nodeId) continue;
    if (r.op === "add") {
      const parent = p.maps[step + 1]!.nodes[r.nodeId]?.parent;
      if (parent && cur.nodes[parent] && parent !== "root") hot.add(parent);
    } else if (cur.nodes[r.nodeId]) hot.add(r.nodeId);
  }
  return { hot, pending };
}

export function stepAt(p: Prepared, t: number): number {
  let k = -1;
  for (let i = 0; i < p.run.steps.length; i++) if (p.run.steps[i]!.applyAt <= t) k = i;
  return k;
}

export function buildView(p: Prepared, t: number): View {
  const step = stepAt(p, t);
  const m = step >= 0 ? p.maps[step]! : { nodes: { root: p.maps[0]!.nodes.root! }, order: ["root"], nextId: 1 };
  const last = new Map<string, ChangeEvent>();
  for (let i = 0; i <= step; i++) for (const e of p.events[i]!) last.set(e.nodeId, e);
  const { hot, pending } = hotNodes(p, t, step);
  const byId: Record<string, ViewNode> = {};
  const children: Record<string, string[]> = {};
  const nodes: ViewNode[] = m.order.map((id) => {
    const n = m.nodes[id]!;
    const e = last.get(id);
    const v: ViewNode = {
      id, parent: n.parent, kind: n.kind, text: n.text, evidence: n.evidence, assignee: n.assignee, due: n.due,
      status: n.kind === "論点" ? issueStatus(m, id) : n.kind === "案" ? n.proposalStatus ?? "検討中" : undefined,
      change: e?.change, changeAge: e ? step - e.step : undefined, hot: hot.has(id),
    };
    byId[id] = v;
    if (n.parent) (children[n.parent] ??= []).push(id);
    return v;
  });
  const feed = p.events.slice(0, step + 1).flat().reverse().slice(0, 30);
  return { t, step, nodes, byId, children, feed, pendingSegs: pending };
}

export const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export const KIND_STYLE: Record<string, { color: string; bg: string; icon: string }> = {
  会議: { color: "#111827", bg: "#f3f4f6", icon: "●" },
  議題: { color: "#1d4ed8", bg: "#dbeafe", icon: "▣" },
  論点: { color: "#b45309", bg: "#fef3c7", icon: "?" },
  案: { color: "#6d28d9", bg: "#ede9fe", icon: "💡" },
  決定: { color: "#047857", bg: "#d1fae5", icon: "✓" },
  課題: { color: "#b91c1c", bg: "#fee2e2", icon: "!" },
  TODO: { color: "#0f766e", bg: "#ccfbf1", icon: "☐" },
};

export const CHANGE_LABEL: Record<Change, string> = {
  added: "追加", updated: "更新", decided: "決定済みに", rejected: "却下", moved: "移動", merged: "統合",
};
