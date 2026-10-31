import type { MeetingMap } from "./map.ts";

export function topicOf(map: MeetingMap, id: string): string | undefined {
  for (let cur = map.nodes[id]; cur; cur = cur.parent ? map.nodes[cur.parent] : undefined) {
    if (cur.kind === "議題") return cur.id;
  }
  return undefined;
}

export function lastChangedNode(map: MeetingMap, changeOrder: readonly string[]): string | undefined {
  return changeOrder.findLast((id) => map.nodes[id] !== undefined && map.nodes[id]!.kind !== "補足");
}

export function nextCurrentTopic(map: MeetingMap, lastChanged: string | undefined, previous: string | undefined): string | undefined {
  return (lastChanged !== undefined && topicOf(map, lastChanged)) || previous;
}
