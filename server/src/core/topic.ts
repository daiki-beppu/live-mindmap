// 今の議題: 直近の反映で最後に変わったノードの、自身を含む最も近い議題。純粋関数（Node の実行環境に依存しない）。
import type { MeetingMap } from "./map.ts";

// id のノード自身を含め、parent をたどって最初に見つかる議題の ID
export function topicOf(map: MeetingMap, id: string): string | undefined {
  for (let cur = map.nodes[id]; cur; cur = cur.parent ? map.nodes[cur.parent] : undefined) {
    if (cur.kind === "議題") return cur.id;
  }
  return undefined;
}

// 今の反映で最後に変わったノード: changeOrder（操作の適用順）のうち、反映後のマップに残っている最後のもの。
// 表示用の変更履歴（diffMaps）が記録しない変化（案の状態を検討中に戻す等）も、実際に値が変わったので数える
export function lastChangedNode(map: MeetingMap, changeOrder: readonly string[]): string | undefined {
  return changeOrder.findLast((id) => map.nodes[id] !== undefined);
}

// 最後に変わったノードの議題を返す。変わったノードが無い、または議題が見つからなければ previous のまま
export function nextCurrentTopic(map: MeetingMap, lastChanged: string | undefined, previous: string | undefined): string | undefined {
  return (lastChanged !== undefined && topicOf(map, lastChanged)) || previous;
}
