import { Schema } from "effect";
import { NodeKind, pointStatus, ROOT_ID, type MapNode, type AppliedOps, type MeetingMap } from "./map.ts";

export const ChangeType = Schema.Literals(["追加", "更新", "決定済み化", "却下", "移動", "統合"]);
export type ChangeType = typeof ChangeType["Type"];

const ChangeBody = {
  node: Schema.mutableKey(Schema.String),
  kind: Schema.mutableKey(NodeKind),
  text: Schema.mutableKey(Schema.String),
};
export const Change = Schema.Union([
  Schema.Struct({ change: Schema.mutableKey(Schema.Literals(["追加", "更新", "決定済み化", "却下", "移動"])), ...ChangeBody }),
  Schema.Struct({ change: Schema.mutableKey(Schema.Literal("統合")), ...ChangeBody, from: Schema.mutableKey(Schema.mutable(Schema.Array(Schema.String))) }),
]);
export type Change = typeof Change["Type"];

type CombineRecord = Pick<AppliedOps, "map" | "combined">;

const hasNew = (before: readonly string[], after: readonly string[]) => after.some((u) => !before.includes(u));

function adoptedByCombine(old: MapNode, n: MapNode, combined: AppliedOps["combined"]): boolean {
  if (old.parent === null || n.parent === null) return false;
  return combined.get(n.parent)?.includes(old.parent) ?? false;
}

function changedValue(old: MapNode, n: MapNode): boolean {
  return old.text !== n.text || old.assignee !== n.assignee || old.assigneeSpeaker !== n.assigneeSpeaker
    || JSON.stringify(old.criteria ?? []) !== JSON.stringify(n.criteria ?? [])
    || !!old.digression !== !!n.digression;
}

function changeTypesOf(id: string, old: MapNode, n: MapNode, before: MeetingMap, applied: CombineRecord): ChangeType[] {
  const after = applied.map;
  const decided = n.kind === "論点" && pointStatus(before, id) === "未決" && pointStatus(after, id) === "決定済み";
  const rejected = n.kind === "案" && old.planStatus !== "却下" && n.planStatus === "却下";
  const moved = old.parent !== n.parent && !adoptedByCombine(old, n, applied.combined);
  const combined = applied.combined.has(id);
  const textChanged = changedValue(old, n);
  const evidenceOnly = hasNew(old.evidence, n.evidence) && !decided && !rejected && !moved && !combined;
  const types: ChangeType[] = [];
  if (textChanged || evidenceOnly) types.push("更新");
  if (decided) types.push("決定済み化");
  if (rejected) types.push("却下");
  if (moved) types.push("移動");
  if (combined) types.push("統合");
  return types;
}

export function diffMaps(before: MeetingMap, applied: CombineRecord): Change[] {
  const changes: Change[] = [];
  for (const id of applied.map.order) {
    if (id === ROOT_ID) continue;
    const n = applied.map.nodes[id]!;
    const old = before.nodes[id];
    const types: ChangeType[] = old ? changeTypesOf(id, old, n, before, applied) : ["追加"];
    const body = { node: id, kind: n.kind, text: n.text };
    for (const change of types) changes.push(change === "統合" ? { change, ...body, from: [...applied.combined.get(id)!] } : { change, ...body });
  }
  return changes;
}
