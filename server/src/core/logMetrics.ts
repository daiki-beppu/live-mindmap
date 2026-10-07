// 回帰評価の 3 指標。セッションのログ（log.jsonl）を順に当て直して数える純粋関数（ADR 0007）。
// 当て方は復元（session.ts の restoreState）と同じ: 反映ごとに applyOps を当て、error のない反映だけ round を進める。
import { applyOps, emptyMap, type MeetingMap } from "./map.ts";
import { stampOf, type LogEvent, type Remark } from "./session.ts";

export type LogMetrics = {
  remarks: number; // 発言の数（ログの remark の行の数）
  rewrites: number; // 本文の書き換えの回数（当て直して本文が実際に変わった update の数）
  maxRewritesPerNode: number; // 1 つのノードへの書き換えの最多回数
  maxOpenSiblings: number; // 話し中の兄弟の最多数（すべての親・すべての反映後のマップ。済みは数えない）
};

// 親ごとの話し中の子の数（ルートの子も含む）。指標と、Claude に渡す議題の一覧が同じ数え方を使うので、ここに 1 つだけ置く
export function openChildCounts(map: MeetingMap): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of Object.values(map.nodes)) {
    if (node.parent === null || node.talkStatus === "済み") continue;
    counts.set(node.parent, (counts.get(node.parent) ?? 0) + 1);
  }
  return counts;
}

// 1 つの親の下の話し中の子の数の最大
function openSiblings(map: MeetingMap): number {
  return Math.max(0, ...openChildCounts(map).values());
}

export function logMetrics(events: readonly LogEvent[]): LogMetrics {
  let map: MeetingMap | undefined;
  let round = 0;
  let remarks = 0;
  let maxOpenSiblings = 0;
  const byId = new Map<string, Remark>();
  const known = new Set<string>();
  const rewritesOf = new Map<string, number>();

  for (const event of events) {
    if (event.type === "start") {
      map = emptyMap(event.title);
    } else if (event.type === "remark") {
      remarks++;
      byId.set(event.remark.id, event.remark);
    } else if (event.type === "diff") {
      if (!map) throw new Error("ログの diff より前に start がありません");
      const fresh: Remark[] = [];
      for (const id of event.input.fresh) {
        const r = byId.get(id);
        if (!r) throw new Error(`ログに発言がありません: ${id}`);
        known.add(id);
        fresh.push(r);
      }
      const stamp = stampOf({ round }, fresh);
      // 操作を前から 1 つずつ増やして当て、update の前後で本文が変わったノードを書き換えと数える（同じ応答の中の仮 ID も applyOps が解決する）
      let before = map;
      event.ops.forEach((op, i) => {
        const after = applyOps(map!, event.ops.slice(0, i + 1), known, stamp).map;
        if (op.op === "update") {
          for (const [id, node] of Object.entries(before.nodes)) {
            if (after.nodes[id] && after.nodes[id].text !== node.text) rewritesOf.set(id, (rewritesOf.get(id) ?? 0) + 1);
          }
        }
        before = after;
      });
      const applied = applyOps(map, event.ops, known, stamp);
      if (event.error === undefined) round = stamp.round;
      map = applied.map;
      maxOpenSiblings = Math.max(maxOpenSiblings, openSiblings(map));
    }
  }
  return {
    remarks,
    rewrites: [...rewritesOf.values()].reduce((a, b) => a + b, 0),
    maxRewritesPerNode: Math.max(0, ...rewritesOf.values()),
    maxOpenSiblings,
  };
}
