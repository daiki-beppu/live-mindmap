import { Schema, Struct } from "effect";
import { toDrawnix } from "./drawnix.ts";
import { ROOT_ID } from "./map.ts";
import { toMarkdown } from "./markdown.ts";
import { Remark } from "./remark.ts";
import { SnapshotNode, type Snapshot } from "./snapshot.ts";

type HiddenFields = "parent" | "evidence" | "touchedAt" | "evidenceRound" | "talkStatus";
export type ExportNode = (Omit<Exclude<SnapshotNode, { kind: "補足" }>, HiddenFields> | Omit<Extract<SnapshotNode, { kind: "補足" }>, HiddenFields>) & {
  evidence: Remark[];
  children: ExportNode[];
};
export type JsonExport = { root: ExportNode; criteria?: readonly string[]; speakerNames?: Readonly<Record<string, string>> };

const HIDDEN_FIELDS = ["parent", "evidence", "touchedAt", "evidenceRound", "talkStatus"] as const;
const ExportFields = {
  evidence: Schema.mutable(Schema.Array(Remark)),
  children: Schema.mutable(Schema.Array(Schema.suspend((): Schema.Codec<ExportNode> => ExportNode))),
};
const ExportNode: Schema.Codec<ExportNode> = SnapshotNode.mapMembers(([regular, supplement]) => [
  regular.mapFields(Struct.omit(HIDDEN_FIELDS)).mapFields(Struct.assign(ExportFields)),
  supplement.mapFields(Struct.omit(HIDDEN_FIELDS)).mapFields(Struct.assign({ ...ExportFields, evidence: ExportFields.evidence.check(Schema.isMinLength(1)) })),
]);

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
