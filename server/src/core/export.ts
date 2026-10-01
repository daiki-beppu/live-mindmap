// エクスポート（JSON）: マップの木に、根拠の発言の本文・トラック・時刻を添える
import { ROOT_ID } from "./map.ts";
import type { Remark, Snapshot, SnapshotNode } from "./session.ts";

export type ExportNode = Omit<SnapshotNode, "parent" | "evidence"> & {
  evidence: Remark[];
  children: ExportNode[];
};
export type JsonExport = { root: ExportNode };

export function toJsonExport(snapshot: Snapshot, remarks: Iterable<Remark>): JsonExport {
  const byId = new Map([...remarks].map((r) => [r.id, r]));
  const build = (node: SnapshotNode): ExportNode => {
    const { parent: _parent, evidence, ...rest } = node;
    return {
      ...rest,
      evidence: evidence.flatMap((id) => byId.get(id) ?? []),
      children: snapshot.nodes.filter((n) => n.parent === node.id).map(build),
    };
  };
  return { root: build(snapshot.nodes.find((n) => n.id === ROOT_ID)!) };
}
