import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import type { VisibleTree } from "./viewing.ts";

export type ViewState = { tree: VisibleTree; snapshot: Snapshot };

// 消えたノード R の統合先。新しいスナップショットを並び順にたどり、最初に次をすべて満たすノード
// （サーバーの中核が統合を記録する規則と同じ。ルートは parent === null で判定する）。
// - 前にもあった / R と同じ種別 / R の根拠をすべて持つ
// - R の根拠を新しく得た、または R の子を引き取った
function mergedInto(removed: SnapshotNode, before: Snapshot, after: Snapshot): string | undefined {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
  const kidIds = before.nodes.filter((n) => n.parent === removed.id).map((n) => n.id);
  const afterById = new Map(after.nodes.map((n) => [n.id, n]));
  for (const t of after.nodes) {
    const prev = beforeById.get(t.id);
    if (!prev || t.parent === null || t.kind !== removed.kind) continue;
    if (!removed.evidence.every((u) => t.evidence.includes(u))) continue;
    const gained = removed.evidence.some((u) => !prev.evidence.includes(u));
    const tookKids = kidIds.some((k) => afterById.get(k)?.parent === t.id);
    if (gained || tookKids) return t.id;
  }
  return undefined;
}

// 前の commit の状態。選んでいたノードは、人の畳みで前の木から隠れていても移り先を求めるために持つ
export type PreviousView = ViewState & { selectedId: string | null };

// 前の見えている木（と、選んでいたノード）にあって、新しいスナップショットにも新しい木にも無いノード → 選択の移り先。
// round が進んでいれば統合先を探し、無ければ（時刻を戻した場合を含め）前の親をたどって、新しい側にある最初の祖先にする。
// 親は前のスナップショットの親に、前の木の親（まとめのノードなど木にだけある親）を重ねて引く
export function relocations(before: PreviousView, after: ViewState): Record<string, string> {
  const exists = new Set([...after.snapshot.nodes.map((n) => n.id), ...after.tree.ids]);
  const beforeById = new Map(before.snapshot.nodes.map((n) => [n.id, n]));
  const parents = new Map<string, string | null>(before.snapshot.nodes.map((n) => [n.id, n.parent]));
  for (const [id, parent] of Object.entries(before.tree.parents)) parents.set(id, parent);
  const advanced = after.snapshot.round > before.snapshot.round;
  const out: Record<string, string> = {};
  const candidates = new Set(before.tree.ids);
  if (before.selectedId !== null) candidates.add(before.selectedId);
  for (const id of candidates) {
    if (exists.has(id)) continue;
    const removed = beforeById.get(id);
    const into = advanced && removed ? mergedInto(removed, before.snapshot, after.snapshot) : undefined;
    if (into) {
      out[id] = into;
      continue;
    }
    for (let cur = parents.get(id); cur != null; cur = parents.get(cur)) {
      if (exists.has(cur)) {
        out[id] = cur;
        break;
      }
    }
  }
  return out;
}
