// エクスポート（JSON）: マップの木に、根拠の発言の本文・トラック・時刻を添える
import type { Snapshot, SnapshotNode, Utterance } from "./session.ts";

export type ExportNode = Omit<SnapshotNode, "parent" | "evidence"> & {
  evidence: Utterance[];
  children: ExportNode[];
};

export function toJsonExport(snapshot: Snapshot, utterances: Iterable<Utterance>): { root: ExportNode } {
  const byId = new Map([...utterances].map((u) => [u.id, u]));
  const build = (node: SnapshotNode): ExportNode => {
    const { parent: _parent, evidence, ...rest } = node;
    return {
      ...rest,
      evidence: evidence.flatMap((id) => byId.get(id) ?? []),
      children: snapshot.nodes.filter((n) => n.parent === node.id).map(build),
    };
  };
  return { root: build(snapshot.nodes.find((n) => n.id === snapshot.rootId)!) };
}
