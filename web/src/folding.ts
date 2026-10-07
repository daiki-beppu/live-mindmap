import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { changedNodeIds } from "./changes.ts";

// 話し中の議題を畳む、最後に触れてからの秒数（15 分）
export const STALE_SECONDS = 900;

// 畳んだノード（まとめのノードを含む）の描き方に使う値
export type Fold = { hint: string | null; hidden: number };

export type FoldView = {
  // 見せるノードの並び（まとめのノードを含む）
  nodes: SnapshotNode[];
  // 見せる畳んだノード・まとめのノードごとの手がかりと隠れた数
  folds: Record<string, Fold>;
  // まとめのノードの ID
  summaries: ReadonlySet<string>;
  // 点滅させるノード（見せるノードのうち、今回変わったもの。中が変わった畳んだノード・まとめのノードを含む）
  blink: ReadonlySet<string>;
  // 見せないノード → それを隠している見せるノード（畳んだノードかまとめのノード）
  shownAs: Record<string, string>;
};

// 見せ方を決める。純粋な関数: snapshot を変えず、opened（開く上書き）に入れたノードは畳まない
export function foldView(snapshot: Snapshot, opened: ReadonlySet<string>): FoldView {
  const { nodes, now, currentTopic } = snapshot;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, SnapshotNode[]>();
  for (const n of nodes) if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);

  // 今の議題とその祖先は畳まない
  const kept = new Set<string>();
  if (currentTopic !== undefined) {
    for (let cur = byId.get(currentTopic); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) kept.add(cur.id);
  }

  const isFolded = (n: SnapshotNode): boolean => {
    if (kept.has(n.id) || opened.has(n.id)) return false;
    if (n.kind !== "議題" && n.kind !== "論点") return false;
    if (n.talkStatus === "済み") return true;
    return n.kind === "議題" && now !== undefined && n.touchedAt !== undefined && now - n.touchedAt >= STALE_SECONDS;
  };

  // 親が畳まれているか隠れているノードは隠す。移動で親が子より後ろに並ぶことがあるので、木を上から辿る
  const folded = new Set<string>();
  const hidden = new Set<string>();
  const walk = (n: SnapshotNode, covered: boolean) => {
    const foldedNow = !covered && isFolded(n);
    if (covered) hidden.add(n.id);
    if (foldedNow) folded.add(n.id);
    for (const c of children.get(n.id) ?? []) walk(c, covered || foldedNow);
  };
  for (const n of nodes) if (!n.parent || !byId.has(n.parent)) walk(n, false);

  const descendants = (id: string): SnapshotNode[] => (children.get(id) ?? []).flatMap((c) => [c, ...descendants(c.id)]);

  // 同じ親の下で続く、畳んだ議題の並び（2 つ以上）をまとめる
  const runOf = new Map<string, string>(); // まとめた議題 → まとめのノードの ID
  const summaryNodes = new Map<string, SnapshotNode>(); // 最初の議題の ID → まとめのノード
  const folds: Record<string, Fold> = {};
  const parents = new Set(nodes.flatMap((n) => (n.parent ? [n.parent] : [])));
  for (const parent of parents) {
    if (hidden.has(parent) || folded.has(parent)) continue;
    let run: SnapshotNode[] = [];
    const close = () => {
      if (run.length >= 2) {
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const id = `run:${first.id}`;
        for (const m of run) runOf.set(m.id, id);
        summaryNodes.set(first.id, { id, parent, kind: "議題", text: `議題 ${run.length} 件`, evidence: [] });
        folds[id] = { hint: `${first.text} 〜 ${last.text}`, hidden: run.reduce((sum, m) => sum + 1 + descendants(m.id).length, 0) };
      }
      run = [];
    };
    for (const kid of children.get(parent) ?? []) {
      if (folded.has(kid.id) && kid.kind === "議題") run.push(kid);
      else close();
    }
    close();
  }

  const shown: SnapshotNode[] = [];
  for (const n of nodes) {
    if (hidden.has(n.id)) continue;
    const summary = summaryNodes.get(n.id);
    if (summary) shown.push(summary);
    else if (!runOf.has(n.id)) shown.push(n);
  }
  const shownIds = new Set(shown.map((n) => n.id));

  for (const id of folded) {
    if (runOf.has(id)) continue;
    const below = descendants(id);
    folds[id] = { hint: hintOf(below), hidden: below.length };
  }

  const shownAs: Record<string, string> = {};
  for (const n of nodes) {
    if (shownIds.has(n.id)) continue;
    for (let cur: SnapshotNode | undefined = n; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
      const run = runOf.get(cur.id);
      const target = run ?? (shownIds.has(cur.id) ? cur.id : undefined);
      if (target) {
        shownAs[n.id] = target;
        break;
      }
    }
  }

  const blink = new Set<string>();
  for (const id of changedNodeIds(snapshot)) {
    if (shownIds.has(id)) blink.add(id);
    else if (shownAs[id]) blink.add(shownAs[id]);
  }

  return { nodes: shown, folds, summaries: new Set([...summaryNodes.values()].map((s) => s.id)), blink, shownAs };
}

// 手がかりの文字。0 の項目は書かず、3 つとも 0 なら null
function hintOf(below: SnapshotNode[]): string | null {
  const parts = [
    ["決定", below.filter((n) => n.kind === "決定").length],
    ["TODO", below.filter((n) => n.kind === "TODO").length],
    ["未決", below.filter((n) => n.kind === "論点" && n.pointStatus === "未決").length],
  ] as const;
  const text = parts.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
  return text.length > 0 ? text.join("・") : null;
}
