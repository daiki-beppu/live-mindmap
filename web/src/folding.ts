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
  // まとめのノードの ID → まとめに入っている議題の ID（並び順）
  runs: Record<string, readonly string[]>;
};

// まとめのノード（run:X）の最初の議題の ID。まとめでなければ null
export function runStartOf(id: string): string | null {
  return id.startsWith("run:") ? id.slice("run:".length) : null;
}

// 見せ方を決める。純粋な関数: snapshot を変えず、opened（人が開いたもの）に入れたノードは畳まず、humanFolded（人が畳んだもの）に入れた議題・論点は畳む。
// 畳む集合 =（済みの議題・論点 ∪ 15 分触れていない話し中の議題 ∪ 人が畳んだもの）−（人が開いたもの ∪ 今の議題と祖先 ∪ 選んだノードの祖先）。
// ただし人が畳んだものは、選んだノードの祖先でも畳む（今の議題と祖先は、人が畳んでも畳まない）。
// 選んだノード（selectedId）の祖先は畳まない（選んだノード自身は、畳む条件に当たれば畳む）。選んだ畳んだ議題は「議題 N 件」にまとめない。選んだまとめ（run:X）は X から始まるまとめとして残し、X の祖先も畳まない。
// unbundled（人が解いた「議題 N 件」に入っていた議題）に入れた議題は、畳んだまま「議題 N 件」にまとめない
export function foldView(
  snapshot: Snapshot,
  opened: ReadonlySet<string>,
  selectedId: string | null,
  humanFolded: ReadonlySet<string>,
  unbundled: ReadonlySet<string>,
): FoldView {
  const { nodes, now, currentTopic } = snapshot;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, SnapshotNode[]>();
  for (const n of nodes) if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);

  // 今の議題とその祖先は、何があっても畳まない
  const currentChain = new Set<string>();
  if (currentTopic !== undefined) {
    for (let cur = byId.get(currentTopic); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) currentChain.add(cur.id);
  }
  // 選んだノードの祖先は、人が畳んでいなければ畳まない
  // 選んだまとめ（run:X）は X として扱い、X の祖先を畳まない（まとめはスナップショットに無いので、ID のままでは引けない）
  const selectionAncestors = new Set<string>();
  const selectedRunStart = selectedId === null ? null : runStartOf(selectedId);
  const selected = selectedId === null ? undefined : byId.get(selectedRunStart ?? selectedId);
  if (selected?.parent) {
    for (let cur = byId.get(selected.parent); cur; cur = cur.parent ? byId.get(cur.parent) : undefined) selectionAncestors.add(cur.id);
  }

  const isFolded = (n: SnapshotNode): boolean => {
    if (currentChain.has(n.id)) return false;
    if (n.kind !== "議題" && n.kind !== "論点") return false;
    if (opened.has(n.id)) return false;
    if (humanFolded.has(n.id)) return true;
    if (selectionAncestors.has(n.id)) return false;
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
  const runs: Record<string, readonly string[]> = {};
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
        runs[id] = run.map((m) => m.id);
        folds[id] = { hint: `${first.text} 〜 ${last.text}`, hidden: run.reduce((sum, m) => sum + 1 + descendants(m.id).length, 0) };
      }
      run = [];
    };
    for (const kid of children.get(parent) ?? []) {
      // 選んだまとめ（run:X）は、X から始まるまとめとして切り直す（選んだ前後の分かれ目が消えても、同じ ID のまとめが残る）
      if (kid.id === selectedRunStart) close();
      if (folded.has(kid.id) && kid.kind === "議題" && kid.id !== selectedId && !unbundled.has(kid.id)) run.push(kid);
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

  return { nodes: shown, folds, summaries: new Set([...summaryNodes.values()].map((s) => s.id)), blink, shownAs, runs };
}

// 位置を保つ基準にするノード: 見せないノードは隠している見せるノードに、解いて無くなったまとめ（run:X）は最初の議題 X に置き換える
export function keepTargetOf(view: Pick<FoldView, "nodes" | "shownAs"> | null, id: string): string {
  if (view === null) return id;
  return view.shownAs[id] ?? (view.nodes.some((n) => n.id === id) ? id : (runStartOf(id) ?? id));
}

// 「変わったこと」から指したノードの、見せるために解く祖先と、人が開いた集合に足すか。
// 指したノードの祖先は選択の保護で開くが、人が畳んだ祖先は保護より強いので、ancestors を人が畳んだ集合から外して見せる。
// open: その状態で指したノード自身が畳まれているか（畳む条件は foldView に任せる）。スナップショットに無い ID は null
export function pointedNode(
  snapshot: Snapshot,
  id: string,
  opened: ReadonlySet<string>,
  humanFolded: ReadonlySet<string>,
  unbundled: ReadonlySet<string>,
): { ancestors: string[]; open: boolean } | null {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const target = byId.get(id);
  if (!target) return null;
  const ancestors: string[] = [];
  for (let cur = target.parent ? byId.get(target.parent) : undefined; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) ancestors.push(cur.id);
  const folded = new Set(humanFolded);
  for (const a of ancestors) folded.delete(a);
  return { ancestors, open: id in foldView(snapshot, opened, id, folded, unbundled).folds };
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
