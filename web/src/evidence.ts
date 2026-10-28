import type { Remark, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { foldView, type HumanFolds } from "./folding.ts";

export type Evidence = { node: SnapshotNode; remarks: Remark[] };

export function evidenceOf(snapshot: Snapshot, nodeId: string, humanFolds: HumanFolds | undefined): Evidence | null {
  const node = snapshot.nodes.find((n) => n.id === nodeId);
  if (!node) {
    const summary = foldView(snapshot, humanFolds, nodeId).nodes.find((n) => n.id === nodeId);
    return summary ? { node: summary, remarks: [] } : null;
  }
  const ids = new Set(node.evidence);
  const remarks = snapshot.remarks.filter((r) => ids.has(r.id)).sort((a, b) => a.start - b.start);
  return { node, remarks };
}
