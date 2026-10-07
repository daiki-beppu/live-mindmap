// エクスポート（JSON・3 ファイルの書き出し内容）: マップの木に、根拠の発言の本文・トラック・時刻を添える
import { Schema } from "effect";
import { toDrawnix } from "./drawnix.ts";
import { KINDS, PLAN_STATUSES, ROOT_ID } from "./map.ts";
import { toMarkdown } from "./markdown.ts";
import { Remark, type Snapshot, type SnapshotNode } from "./session.ts";

export type ExportNode = Omit<SnapshotNode, "parent" | "evidence" | "touchedAt" | "evidenceRound" | "talkStatus"> & {
  evidence: Remark[];
  children: ExportNode[];
};
export type JsonExport = { root: ExportNode };

// 保存した export.json を読むときの形。型は上の手書きの型を正本にし、Schema はその型注釈に合わせる
// （core と web が同じ ExportNode を使うので、型を Schema から導くと型同一性が両方へ波及する）。
// parent は持たず（木の形で表す）、evidence は ID ではなく発言そのもの、pointStatus は保存した値
const ExportNode: Schema.Codec<ExportNode> = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([...KINDS, "会議"]),
  text: Schema.mutableKey(Schema.String),
  planStatus: Schema.optionalKey(Schema.mutableKey(Schema.Literals(PLAN_STATUSES))),
  assignee: Schema.optionalKey(Schema.String),
  due: Schema.optionalKey(Schema.String),
  pointStatus: Schema.optionalKey(Schema.Literals(["未決", "決定済み"])),
  // session.ts と互いに import するので、Remark も suspend で遅らせる（どちらが先に読み込まれても初期化順で壊れない）
  evidence: Schema.mutable(Schema.Array(Schema.suspend((): Schema.Codec<Remark> => Remark))),
  children: Schema.mutable(Schema.Array(Schema.suspend((): Schema.Codec<ExportNode> => ExportNode))),
});

export const JsonExport: Schema.Codec<JsonExport> = Schema.Struct({ root: ExportNode });

export function toJsonExport(snapshot: Snapshot, remarks: Iterable<Remark>): JsonExport {
  const byId = new Map([...remarks].map((r) => [r.id, r]));
  const build = (node: SnapshotNode): ExportNode => {
    const { parent: _parent, evidence, touchedAt: _touchedAt, evidenceRound: _evidenceRound, talkStatus: _talkStatus, ...rest } = node;
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
