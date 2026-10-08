import type { Remark, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { foldView } from "./folding.ts";

export type Evidence = { node: SnapshotNode; remarks: Remark[] };

// 選んだノードと、その根拠の発言（開始時刻の昇順）。ノードが今のマップになければ null。
// 「議題 N 件」（まとめのノード）はスナップショットに無いので、マップと同じ入力（選んだ ID と、人が開いた・畳んだ集合を渡す）の畳む見せ方から引き、根拠の発言は無しで返す。
// 統合すると evidence が時系列順でなくなるので、並べ直す。スナップショットは書き換えない。
export function evidenceOf(snapshot: Snapshot, nodeId: string, opened: ReadonlySet<string>, humanFolded: ReadonlySet<string>): Evidence | null {
  const node = snapshot.nodes.find((n) => n.id === nodeId);
  if (!node) {
    const summary = foldView(snapshot, opened, nodeId, humanFolded).nodes.find((n) => n.id === nodeId);
    return summary ? { node: summary, remarks: [] } : null;
  }
  const ids = new Set(node.evidence);
  const remarks = snapshot.remarks.filter((r) => ids.has(r.id)).sort((a, b) => a.start - b.start);
  return { node, remarks };
}
