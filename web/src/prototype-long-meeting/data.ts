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

export function frameAt(m: Meeting, index: number): Frame {
  const key = `${m.name}:${index}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const session = restoreSession(m.events.slice(0, m.diffEnds[index]), { updater: async () => ({ ops: [] }), log: () => {} });
  const snapshot = session.snapshot();
  const at = m.diffAt[index]!;
  const closed = new Set<string>();
  for (const c of m.closes) {
    if (c.at > at) break;
    if (c.type === "close") closed.add(c.node);
    if (c.type === "reopen") closed.delete(c.node);
  }
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const lastTouched: Record<string, number> = {};
  let current: string | null = null;
  for (const c of snapshot.changes) {
    const t = topicOf(byId, c.node);
    if (!t) continue;
    lastTouched[t] = c.at;
    current = t; // 直近の反映が当たった議題（同じ反映で複数なら最後のもの）
  }
  const frame = { index, at, snapshot, closed, lastTouched, current };
  cache.set(key, frame);
  return frame;
}

// 畳む: 既定は済みの議題・論点。open は人（と、ここでは根拠を見るための選択）の上書きで開いているもの。
// 将来の人の開閉は「上書きがあればそれ、なければ済みから」（#129）。今回は上書きを選択からだけ作る。
export function foldedIds(frame: Frame, open: ReadonlySet<string>): Set<string> {
  return new Set([...frame.closed].filter((id) => !open.has(id)));
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
