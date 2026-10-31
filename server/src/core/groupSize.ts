import { childrenByParent, ROOT_ID, type MapNode } from "./map.ts";

export type GroupNode = Pick<MapNode, "id" | "parent" | "kind" | "talkStatus">;
export type GroupSize = { size: number; topicId: string };

export function groupSize(nodes: readonly GroupNode[], id: string): GroupSize {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const origin = byId.get(id)!;
  let topicId = ROOT_ID;
  for (let parent = origin.parent; parent !== null;) {
    const ancestor = byId.get(parent)!;
    if (ancestor.kind === "議題") { topicId = ancestor.id; break; }
    parent = ancestor.parent;
  }
  if (origin.kind === "論点" && origin.talkStatus === "済み") return { size: 0, topicId };

  const kids = childrenByParent(nodes);
  let size = 0;
  const pending = [...(kids.get(id) ?? [])];
  while (pending.length) {
    const child = pending.pop()!;
    if (child.kind === "議題") continue;
    size++;
    if (child.kind === "論点" && (
      origin.kind !== "論点" || byId.get(child.parent!)!.kind === "論点" || child.talkStatus === "済み"
    )) continue;
    pending.push(...(kids.get(child.id) ?? []));
  }
  return { size, topicId };
}
