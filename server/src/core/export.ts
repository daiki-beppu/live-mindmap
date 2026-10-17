// エクスポート（JSON・3 ファイルの書き出し内容）: マップの木に、根拠の発言の本文・トラック・時刻を添える
import { Schema } from "effect";
import { toDrawnix } from "./drawnix.ts";
import { KINDS, PLAN_STATUSES, ROOT_ID } from "./map.ts";
import { toMarkdown } from "./markdown.ts";
import { Remark } from "./remark.ts";
import type { Snapshot, SnapshotNode } from "./snapshot.ts";

export type ExportNode = Omit<SnapshotNode, "parent" | "evidence" | "touchedAt" | "evidenceRound" | "talkStatus"> & {
  evidence: Remark[];
  children: ExportNode[];
};
// speakerNames は話者のラベル → 名前の対応表（名前が付いたラベルだけ。無ければキーごと省く）。ノードの人の欄はラベルのまま持つ
export type JsonExport = { root: ExportNode; speakerNames?: Readonly<Record<string, string>> };

// 保存した export.json を読むときの形。型は上の手書きの型を正本にし、Schema はその型注釈に合わせる
// （core と web が同じ ExportNode を使うので、型を Schema から導くと型同一性が両方へ波及する）。
// parent は持たず（木の形で表す）、evidence は ID ではなく発言そのもの、pointStatus は保存した値
const ExportNode: Schema.Codec<ExportNode> = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([...KINDS, "会議"]),
  text: Schema.mutableKey(Schema.String),
  planStatus: Schema.optionalKey(Schema.mutableKey(Schema.Literals(PLAN_STATUSES))),
  proposer: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  assigneeSpeaker: Schema.optionalKey(Schema.String),
  due: Schema.optionalKey(Schema.String),
  pointStatus: Schema.optionalKey(Schema.Literals(["未決", "決定済み"])),
  evidence: Schema.mutable(Schema.Array(Remark)),
  children: Schema.mutable(Schema.Array(Schema.suspend((): Schema.Codec<ExportNode> => ExportNode))),
});

export const JsonExport: Schema.Codec<JsonExport> = Schema.Struct({ root: ExportNode, speakerNames: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) });

export function toJsonExport(snapshot: Snapshot, remarks: Iterable<Remark>, names?: ReadonlyMap<string, string>): JsonExport {
  const byId = new Map([...remarks].map((r) => [r.id, r]));
  const build = (node: SnapshotNode): ExportNode => {
    const { parent: _parent, evidence, touchedAt: _touchedAt, evidenceRound: _evidenceRound, talkStatus: _talkStatus, ...rest } = node;
    return {
      ...rest,
      evidence: evidence.flatMap((id) => byId.get(id) ?? []),
      children: snapshot.nodes.filter((n) => n.parent === node.id).map(build),
    };
  };
  return { root: build(snapshot.nodes.find((n) => n.id === ROOT_ID)!), ...(names && names.size > 0 ? { speakerNames: Object.fromEntries(names) } : {}) };
}

// セッション終了時に書き出す 3 つのファイルの中身。すべて同じ JsonExport から作る。
// map.json は export --format json に、名前の対応表（speakerNames。名前は書き出しの時点のもの）が加わった文字列。
export function exportFiles(exp: JsonExport): Record<"map.md" | "map.json" | "map.drawnix", string> {
  return {
    "map.md": toMarkdown(exp),
    "map.json": JSON.stringify(exp, null, 2),
    "map.drawnix": JSON.stringify(toDrawnix(exp), null, 2),
  };
}
