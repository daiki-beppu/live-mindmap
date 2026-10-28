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
export type JsonExport = { root: ExportNode; criteria?: readonly string[]; speakerNames?: Readonly<Record<string, string>> };

const ExportNode: Schema.Codec<ExportNode> = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([...KINDS, "会議"]),
  text: Schema.mutableKey(Schema.String),
  planStatus: Schema.optionalKey(Schema.mutableKey(Schema.Literals(PLAN_STATUSES))),
  proposer: Schema.optionalKey(Schema.String),
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  assignee: Schema.optionalKey(Schema.String),
  assigneeSpeaker: Schema.optionalKey(Schema.String),
  due: Schema.optionalKey(Schema.String),
  pointStatus: Schema.optionalKey(Schema.Literals(["未決", "決定済み"])),
  evidence: Schema.mutable(Schema.Array(Remark)),
  children: Schema.mutable(Schema.Array(Schema.suspend((): Schema.Codec<ExportNode> => ExportNode))),
});

export const JsonExport: Schema.Codec<JsonExport> = Schema.Struct({ root: ExportNode, criteria: Schema.optionalKey(Schema.Array(Schema.String)), speakerNames: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) });

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
  return { root: build(snapshot.nodes.find((n) => n.id === ROOT_ID)!), ...(snapshot.criteria?.length ? { criteria: [...snapshot.criteria] } : {}), ...(names && names.size > 0 ? { speakerNames: Object.fromEntries(names) } : {}) };
}

export function exportFiles(exp: JsonExport): Record<"map.md" | "map.json" | "map.drawnix", string> {
  return {
    "map.md": toMarkdown(exp),
    "map.json": JSON.stringify(exp, null, 2),
    "map.drawnix": JSON.stringify(toDrawnix(exp), null, 2),
  };
}
