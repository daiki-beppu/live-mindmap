import type { Remark, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";

export type Evidence = { node: SnapshotNode; remarks: Remark[] };

// 選んだノードと、その根拠の発言（開始時刻の昇順）。ノードが今のマップになければ null。
// 統合すると evidence が時系列順でなくなるので、並べ直す。スナップショットは書き換えない。
export function evidenceOf(snapshot: Snapshot, nodeId: string): Evidence | null {
  const node = snapshot.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const ids = new Set(node.evidence);
  const remarks = snapshot.remarks.filter((r) => ids.has(r.id)).sort((a, b) => a.start - b.start);
  return { node, remarks };
}
