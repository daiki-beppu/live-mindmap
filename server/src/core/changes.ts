// 変わったこと: 反映の前後のマップを比べて、今回変わったノードと変化の種類を導く。
// 差分操作（ops）ではなくマップの比較から導く。Node の実行環境に依存しない（ADR 0003）。
import { children, pointStatus, ROOT_ID, type Kind, type MapNode, type MeetingMap } from "./map.ts";

export type ChangeType = "追加" | "更新" | "決定済み化" | "却下" | "移動" | "統合";

// kind と text は反映後の値（統合では統合先の値）
export type Change = { change: ChangeType; node: string; kind: Kind | "会議"; text: string };

const hasNew = (before: readonly string[], after: readonly string[]) => after.some((u) => !before.includes(u));

// 消えたノード R の統合先を探す。反映後のマップを作られた順にたどり、最初に次をすべて満たすノード。
// - 反映前にもあった / R と同じ種別 / R の根拠をすべて持つ
// - R の根拠を新しく得た、または R の子を引き取った
// 見つからなければ削除（記録しない）。
function combinedInto(removed: MapNode, before: MeetingMap, after: MeetingMap): string | undefined {
  const kidIds = children(before, removed.id).map((k) => k.id);
  for (const id of after.order) {
    const t = after.nodes[id]!;
    const prev = before.nodes[id];
    if (!prev || id === ROOT_ID || t.kind !== removed.kind) continue;
    if (!removed.evidence.every((u) => t.evidence.includes(u))) continue;
    const gained = removed.evidence.some((u) => !prev.evidence.includes(u));
    const tookKids = kidIds.some((k) => after.nodes[k]?.parent === id);
    if (gained || tookKids) return id;
  }
  return undefined;
}

export function diffMaps(before: MeetingMap, after: MeetingMap): Change[] {
  const mergedInto = new Map<string, string>(); // 消えたノード → 統合先
  for (const id of before.order) {
    if (after.nodes[id]) continue;
    const into = combinedInto(before.nodes[id]!, before, after);
    if (into) mergedInto.set(id, into);
  }
  const combinedTargets = new Set(mergedInto.values());

  const changes: Change[] = [];
  for (const id of after.order) {
    if (id === ROOT_ID) continue;
    const n = after.nodes[id]!;
    const old = before.nodes[id];
    const push = (change: ChangeType) => changes.push({ change, node: id, kind: n.kind, text: n.text });
    if (!old) {
      push("追加");
      continue;
    }

    const decided = n.kind === "論点" && pointStatus(before, id) === "未決" && pointStatus(after, id) === "決定済み";
    const rejected = n.kind === "案" && old.planStatus !== "却下" && n.planStatus === "却下";
    // 元の親が統合で消え、今の親がその統合先なら、引き取られただけで移動ではない
    const moved = old.parent !== n.parent && !(old.parent !== null && mergedInto.get(old.parent) === n.parent);
    const combined = combinedTargets.has(id);
    const textChanged = old.text !== n.text;
    const evidenceOnly = hasNew(old.evidence, n.evidence) && !decided && !rejected && !moved && !combined;

    if (textChanged || evidenceOnly) push("更新");
    if (decided) push("決定済み化");
    if (rejected) push("却下");
    if (moved) push("移動");
    if (combined) push("統合");
  }
  return changes;
}
