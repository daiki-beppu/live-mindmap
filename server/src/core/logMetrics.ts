import { Effect } from "effect";
import { applyOps, emptyMap, type MeetingMap } from "./map.ts";
import { InvalidLogEvent, stampOf, type LogEvent } from "./session.ts";
import type { Remark } from "./remark.ts";

export type LogMetrics = {
  remarks: number;
  rewrites: number;
  maxRewritesPerNode: number;
  maxOpenSiblings: number;
};

export function openChildCounts(map: MeetingMap): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of Object.values(map.nodes)) {
    if (node.parent === null || node.talkStatus === "済み") continue;
    counts.set(node.parent, (counts.get(node.parent) ?? 0) + 1);
  }
  return counts;
}

function openSiblings(map: MeetingMap): number {
  return Math.max(0, ...openChildCounts(map).values());
}

type DiffLogEvent = Extract<LogEvent, { readonly type: "diff" }>;

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
