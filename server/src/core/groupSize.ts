import { ROOT_ID, type MapNode } from "./map.ts";

export type GroupNode = Pick<MapNode, "id" | "parent" | "kind" | "talkStatus">;
export type GroupSize = { size: number; topicId: string };

// 親ごとの子の一覧（入力の順）。親を持たないノードと、子のないノードは載らない。ノードはコピーしない。
export function childrenByParent<N extends { readonly id: string; readonly parent: string | null }>(nodes: readonly N[]): Map<string, N[]> {
  const kids = new Map<string, N[]>();
  for (const n of nodes) {
    if (n.parent === null) continue;
    const siblings = kids.get(n.parent);
    if (siblings) siblings.push(n);
    else kids.set(n.parent, [n]);
  }
  return kids;
}

// 入力は既存のマップと同じ木。本文・根拠・実行環境を必要としない。
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
    // 論点起点では派生・済みだけが境界。他の種別では論点を独立したまとまりとして扱う。
    if (child.kind === "論点" && (
      origin.kind !== "論点" || byId.get(child.parent!)!.kind === "論点" || child.talkStatus === "済み"
    )) continue;
    pending.push(...(kids.get(child.id) ?? []));
  }
  return { size, topicId };
}
