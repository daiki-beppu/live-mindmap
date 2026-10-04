// PROTOTYPE（issue #131）: 長い会議の試作の出力（log.jsonl と closes.jsonl）を再生して、各反映の時点の画面の入力を作る。
// main には入れない。
import { restoreSession, type Snapshot, type SnapshotNode } from "../../../server/src/core/index.ts";

type CloseEvent = { at: number; type: "close" | "reopen" | "close-dropped"; node: string };

export type Meeting = {
  name: string;
  events: unknown[];
  diffEnds: number[]; // events の中の、各 diff の位置（その diff までを再生すると、その反映の時点になる）
  diffAt: number[]; // 各 diff の会議の中の時刻（渡した発言の終わり）
  closes: CloseEvent[];
};

export type Frame = {
  index: number;
  at: number;
  snapshot: Snapshot;
  closed: Set<string>; // 済みの議題・論点
  lastTouched: Record<string, number>; // 議題 → 最後に触れた時刻（その議題の中のノードが変わった時刻）
  current: string | null; // 今の議題
};

export async function loadMeeting(name: string): Promise<Meeting> {
  const text = async (f: string) => (await fetch(`/proto-long/${name}/${f}`)).text();
  const lines = (s: string) => s.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const events = lines(await text("log.jsonl"));
  const closes = lines(await text("closes.jsonl")) as CloseEvent[];
  const ends: Record<string, number> = {};
  const diffEnds: number[] = [];
  const diffAt: number[] = [];
  events.forEach((e: any, i) => {
    if (e.type === "remark") ends[e.remark.id] = e.remark.end;
    if (e.type === "diff") {
      diffEnds.push(i + 1);
      diffAt.push(Math.max(0, ...e.input.fresh.map((id: string) => ends[id] ?? 0)));
    }
  });
  return { name, events, diffEnds, diffAt, closes };
}

// ノードの属する議題（自分が議題なら自分）。会議の直下でなければ null
export function topicOf(byId: Map<string, SnapshotNode>, id: string): string | null {
  for (let cur = byId.get(id); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) if (cur.kind === "議題") return cur.id;
  return null;
}

const cache = new Map<string, Frame>();

// 入れ子の議題の模擬（利用者の案、2026-10-04）: AI の出力は変えず、議題名から親の議題を付け直す。
// parent が既存の議題ならその下へ、無ければ text の議題を作って（最初の子の直前に）入れる。
const NESTS: Record<string, { parent?: string; text: string; match: RegExp }[]> = {
  parnassus: [{ parent: "n1", text: "", match: /^写真/ }],
  silly: [
    { text: "ネタの仕込み方", match: /^ネタ/ },
    { text: "仕込み済みの人向けのコツ", match: /^(仕込み済み|コツ)/ },
    { text: "発表", match: /^発表/ },
  ],
};

function nest(name: string, snapshot: Snapshot): Snapshot {
  let nodes = [...snapshot.nodes];
  (NESTS[name] ?? []).forEach((g, gi) => {
    const kids = nodes.filter((n) => n.kind === "議題" && n.parent === "root" && n.id !== g.parent && g.match.test(n.text));
    if (kids.length === 0) return;
    let pid = g.parent;
    if (!pid || !nodes.some((n) => n.id === pid)) {
      pid = `group${gi}`;
      const first = nodes.indexOf(kids[0]!);
      nodes.splice(first, 0, { id: pid, parent: "root", kind: "議題", text: g.text, evidence: kids[0]!.evidence });
    }
    const ids = new Set(kids.map((k) => k.id));
    nodes = nodes.map((n) => (ids.has(n.id) ? { ...n, parent: pid! } : n));
  });
  return { ...snapshot, nodes };
}

export function frameAt(m: Meeting, index: number, nested = false): Frame {
  const key = `${m.name}:${index}:${nested}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const session = restoreSession(m.events.slice(0, m.diffEnds[index]), { updater: async () => ({ ops: [] }), log: () => {} });
  const snapshot = nested ? nest(m.name, session.snapshot()) : session.snapshot();
  const at = m.diffAt[index]!;
  const closed = new Set<string>();
  for (const c of m.closes) {
    if (c.at > at) break;
    if (c.type === "close") closed.add(c.node);
    if (c.type === "reopen") closed.delete(c.node);
  }
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  if (nested) {
    // 子の議題を持つ議題は、子の議題がすべて済みなら済み、1 つでも話し中なら話し中（深い方から）
    for (const n of [...snapshot.nodes].reverse()) {
      const subs = snapshot.nodes.filter((k) => k.parent === n.id && k.kind === "議題");
      if (n.kind !== "議題" || subs.length === 0) continue;
      if (subs.every((k) => closed.has(k.id))) closed.add(n.id);
      else closed.delete(n.id);
    }
  }
  const lastTouched: Record<string, number> = {};
  let current: string | null = null;
  for (const c of snapshot.changes) {
    const t = topicOf(byId, c.node);
    if (!t) continue;
    for (let u: string | null = t; u; u = byId.get(u)?.parent ?? null) if (byId.get(u)?.kind === "議題") lastTouched[u] = c.at;
    current = t; // 直近の反映が当たった議題（同じ反映で複数なら最後のもの）
  }
  const frame = { index, at, snapshot, closed, lastTouched, current };
  cache.set(key, frame);
  return frame;
}

// 畳む: 既定は済みの議題・論点。open は人（と、ここでは根拠を見るための選択）の上書きで開いているもの。
// 将来の人の開閉は「上書きがあればそれ、なければ済みから」（#129）。今回は上書きを選択からだけ作る。
// staleMin: 話し中でも、最後に触れてからこの分数たった議題は畳む（データは話し中のまま。0 なら畳まない）
export function foldedIds(frame: Frame, open: ReadonlySet<string>, staleMin = 0): Set<string> {
  const stale = staleMin > 0 ? Object.entries(frame.lastTouched).filter(([, t]) => frame.at - t > staleMin * 60).map(([id]) => id) : [];
  return new Set([...frame.closed, ...stale].filter((id) => !open.has(id)));
}

// 畳んだノードの子孫（描かないノード）
export function hiddenIds(nodes: SnapshotNode[], folded: ReadonlySet<string>): Set<string> {
  const hidden = new Set<string>();
  for (const n of nodes) if (n.parent && (folded.has(n.parent) || hidden.has(n.parent))) hidden.add(n.id);
  return hidden;
}

// 畳んだノードに添える中身の手がかり
export function summaryOf(nodes: SnapshotNode[], id: string): { decisions: number; todos: number; open: number; total: number } {
  const kids = new Map<string, SnapshotNode[]>();
  for (const n of nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const s = { decisions: 0, todos: 0, open: 0, total: 0 };
  const walk = (pid: string) => {
    for (const k of kids.get(pid) ?? []) {
      s.total++;
      if (k.kind === "決定") s.decisions++;
      if (k.kind === "TODO") s.todos++;
      if (k.kind === "論点" && k.pointStatus === "未決") s.open++;
      walk(k.id);
    }
  };
  walk(id);
  return s;
}

export function hintText(nodes: SnapshotNode[], id: string): string {
  const s = summaryOf(nodes, id);
  return [s.decisions && `決定 ${s.decisions}`, s.todos && `TODO ${s.todos}`, s.open && `未決 ${s.open}`].filter(Boolean).join("・") || `${s.total} 件`;
}

export const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
