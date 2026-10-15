// 回帰評価の 3 指標。セッションのログ（log.jsonl）を順に当て直して数える関数（ADR 0007）。ログの不整合は InvalidLogEvent の失敗で返す。
// 当て方は復元（session.ts の restoreState）と同じ: 反映ごとに applyOps を当て、error のない反映だけ round を進める。
import { Effect } from "effect";
import { applyOps, emptyMap, type MeetingMap } from "./map.ts";
import { InvalidLogEvent, stampOf, type LogEvent } from "./session.ts";
import type { Remark } from "./remark.ts";

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

type DiffLogEvent = Extract<LogEvent, { readonly type: "diff" }>;

// diff が受け取った発言のうち、反映に使った（または通常失敗で消費した）先頭の何件か
const freshOf = Effect.fnUntraced(function* (
  event: DiffLogEvent,
  byId: ReadonlyMap<string, Remark>,
  invalid: (reason: string) => InvalidLogEvent,
): Effect.fn.Return<Remark[], InvalidLogEvent> {
  const input: Remark[] = [];
  for (const id of event.input.fresh) {
    const r = byId.get(id);
    if (!r) return yield* invalid(`ログに発言がありません: ${id}`);
    input.push(r);
  }
  const count = event.error !== undefined ? event.input.fresh.length : event.processedRemarks ?? event.input.fresh.length;
  return input.slice(0, count);
});

// 操作を前から 1 つずつ増やして当て、update の前後で本文が変わったノードの ID を、書き換えの起きた順に返す（同じ応答の中の仮 ID も applyOps が解決する）
function rewrittenIds(start: MeetingMap, ops: DiffLogEvent["ops"], known: ReadonlySet<string>, stamp: { round: number; at: number }, byId: ReadonlyMap<string, Remark>): string[] {
  const ids: string[] = [];
  let before = start;
  ops.forEach((op, i) => {
    const after = applyOps(start, ops.slice(0, i + 1), known, stamp, byId).map;
    if (op.op === "update") {
      for (const [id, node] of Object.entries(before.nodes)) {
        if (after.nodes[id] && after.nodes[id].text !== node.text) ids.push(id);
      }
    }
    before = after;
  });
  return ids;
}

type Progress = { readonly map: MeetingMap; readonly round: number; readonly known: Set<string> };
// known は logMetrics が所有する蓄積用の Set で、diff ごとに追記する（全コピーすると O(N²) になる）

// diff を 1 回分当てる。書き換えの起きたノードの ID も返す。error のない反映だけ round を進める
const applyDiff = Effect.fnUntraced(function* (
  progress: Progress,
  event: DiffLogEvent,
  byId: ReadonlyMap<string, Remark>,
  invalid: (reason: string) => InvalidLogEvent,
): Effect.fn.Return<Progress & { readonly rewritten: string[] }, InvalidLogEvent> {
  const fresh = yield* freshOf(event, byId, invalid);
  const known = progress.known;
  for (const r of fresh) known.add(r.id);
  const stamp = stampOf({ round: progress.round }, fresh);
  const rewritten = rewrittenIds(progress.map, event.ops, known, stamp, byId);
  const applied = applyOps(progress.map, event.ops, known, stamp, byId);
  return { map: applied.map, round: event.error === undefined ? stamp.round : progress.round, known, rewritten };
});

export const logMetrics = Effect.fnUntraced(function* (events: readonly LogEvent[]): Effect.fn.Return<LogMetrics, InvalidLogEvent> {
  let progress: Progress | undefined;
  let remarks = 0;
  let maxOpenSiblings = 0;
  let index = -1;
  const invalid = (reason: string) => new InvalidLogEvent({ index, reason });
  const byId = new Map<string, Remark>();
  const rewritesOf = new Map<string, number>();

  for (const event of events) {
    index++;
    if (event.type === "start") {
      // start が重なっても、round と known は引き継ぐ（マップだけ作り直す）
      progress = { map: emptyMap(event.title), round: progress?.round ?? 0, known: progress?.known ?? new Set() };
    } else if (event.type === "remark") {
      remarks++;
      byId.set(event.remark.id, event.remark);
    } else if (event.type === "diff") {
      if (!progress) return yield* invalid("ログの diff より前に start がありません");
      const next = yield* applyDiff(progress, event, byId, invalid);
      for (const id of next.rewritten) rewritesOf.set(id, (rewritesOf.get(id) ?? 0) + 1);
      progress = next;
      maxOpenSiblings = Math.max(maxOpenSiblings, openSiblings(next.map));
    }
  }
  return {
    remarks,
    rewrites: [...rewritesOf.values()].reduce((a, b) => a + b, 0),
    maxRewritesPerNode: Math.max(0, ...rewritesOf.values()),
    maxOpenSiblings,
  };
});
