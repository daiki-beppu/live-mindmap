import { Schema, Tuple } from "effect";
import { Change } from "./changes.ts";
import { MapNode, PointStatus } from "./map.ts";
import { Remark } from "./remark.ts";

export const SnapshotNode = Schema.Struct({
  ...MapNode.fields,
  pointStatus: Schema.optionalKey(Schema.mutableKey(PointStatus)),
});
export type SnapshotNode = typeof SnapshotNode["Type"];
export const ChangeEntry = Change.mapMembers(Tuple.map(Schema.fieldsAssign({
  round: Schema.mutableKey(Schema.Finite),
  at: Schema.mutableKey(Schema.Finite),
})));
export type ChangeEntry = typeof ChangeEntry["Type"];
export const Snapshot = Schema.Struct({
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  nodes: Schema.mutableKey(Schema.mutable(Schema.Array(SnapshotNode))),
  round: Schema.mutableKey(Schema.Finite),
  changes: Schema.mutableKey(Schema.mutable(Schema.Array(ChangeEntry))),
  remarks: Schema.mutableKey(Schema.mutable(Schema.Array(Remark))),
  currentTopic: Schema.optionalKey(Schema.mutableKey(Schema.String)),
  lastChanged: Schema.optionalKey(Schema.mutableKey(Schema.String)),
  now: Schema.optionalKey(Schema.mutableKey(Schema.Finite)),
});
export type Snapshot = typeof Snapshot["Type"];
export const SnapshotFrame = Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: Snapshot });
export type SnapshotFrame = typeof SnapshotFrame["Type"];

