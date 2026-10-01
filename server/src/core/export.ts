// エクスポート（JSON・3 ファイルの書き出し内容）: マップの木に、根拠の発言の本文・トラック・時刻を添える
import { toDrawnix } from "./drawnix.ts";
import { ROOT_ID } from "./map.ts";
import { toMarkdown } from "./markdown.ts";
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

// セッション終了時に書き出す 3 つのファイルの中身。すべて同じ JsonExport から作る。
// map.json は export --format json と同じ文字列。
export function exportFiles(exp: JsonExport): Record<"map.md" | "map.json" | "map.drawnix", string> {
  return {
    "map.md": toMarkdown(exp),
    "map.json": JSON.stringify(exp, null, 2),
    "map.drawnix": JSON.stringify(toDrawnix(exp), null, 2),
  };
}
