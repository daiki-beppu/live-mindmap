import { Schema } from "effect";
import { children, MapNode, pointStatus, ROOT_ID, type MeetingMap } from "./map.ts";

export const ChangeType = Schema.Literals(["追加", "更新", "決定済み化", "却下", "移動", "統合"]);
export type ChangeType = typeof ChangeType["Type"];

export const Change = Schema.Struct({
  change: Schema.mutableKey(ChangeType),
  node: Schema.mutableKey(Schema.String),
  kind: Schema.mutableKey(MapNode.fields.kind),
  text: Schema.mutableKey(Schema.String),
});
export type Change = typeof Change["Type"];

const hasNew = (before: readonly string[], after: readonly string[]) => after.some((u) => !before.includes(u));

function combinedInto(removed: MapNode, before: MeetingMap, after: MeetingMap): string | undefined {
  const kidIds = children(before, removed.id).map((k) => k.id);
  for (const id of after.order) {
    const t = after.nodes[id]!;
    const prev = before.nodes[id];
    if (!prev || id === ROOT_ID || t.kind !== removed.kind) continue;
    if (!removed.evidence.every((u) => t.evidence.includes(u))) continue;
    const gained = removed.evidence.some((u) => !prev.evidence.includes(u));
    const tookKids = kidIds.some((k) => after.nodes[k]?.parent === id);
    if (gained || tookKids) return id;
  }
  return undefined;
}

function mergeTargets(before: MeetingMap, after: MeetingMap): Map<string, string> {
  const mergedInto = new Map<string, string>();
  for (const id of before.order) {
    if (after.nodes[id]) continue;
    const into = combinedInto(before.nodes[id]!, before, after);
    if (into) mergedInto.set(id, into);
  }
  return mergedInto;
}

function changeTypesOf(id: string, old: MapNode, n: MapNode, before: MeetingMap, after: MeetingMap, mergedInto: ReadonlyMap<string, string>, combinedTargets: ReadonlySet<string>): ChangeType[] {
  const decided = n.kind === "論点" && pointStatus(before, id) === "未決" && pointStatus(after, id) === "決定済み";
  const rejected = n.kind === "案" && old.planStatus !== "却下" && n.planStatus === "却下";
  const moved = old.parent !== n.parent && !(old.parent !== null && mergedInto.get(old.parent) === n.parent);
  const combined = combinedTargets.has(id);
  const textChanged = old.text !== n.text || old.assignee !== n.assignee || old.assigneeSpeaker !== n.assigneeSpeaker;
  const evidenceOnly = hasNew(old.evidence, n.evidence) && !decided && !rejected && !moved && !combined;
  const types: ChangeType[] = [];
  if (textChanged || evidenceOnly) types.push("更新");
  if (decided) types.push("決定済み化");
  if (rejected) types.push("却下");
  if (moved) types.push("移動");
  if (combined) types.push("統合");
  return types;
}

export function diffMaps(before: MeetingMap, after: MeetingMap): Change[] {
  const mergedInto = mergeTargets(before, after);
  const combinedTargets = new Set(mergedInto.values());

  const changes: Change[] = [];
  for (const id of after.order) {
    if (id === ROOT_ID) continue;
    const n = after.nodes[id]!;
    const old = before.nodes[id];
    const types: ChangeType[] = old ? changeTypesOf(id, old, n, before, after, mergedInto, combinedTargets) : ["追加"];
    for (const change of types) changes.push({ change, node: id, kind: n.kind, text: n.text });
  }
  return changes;
}
