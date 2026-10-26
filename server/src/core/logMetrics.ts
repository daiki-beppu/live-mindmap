import { Effect, Result } from "effect";
import { emptyMap, type MeetingMap } from "./map.ts";
import { InvalidLogEvent, type LogEvent } from "./session.ts";
import { reflectDiff, type ReflectionState } from "./reflection.ts";
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

function rewrittenIds(start: ReflectionState, event: DiffLogEvent): Result.Result<string[], string> {
  const ids: string[] = [];
  let before = start.map;
  for (const [i, op] of event.ops.entries()) {
    const reflected = reflectDiff(start, { ...event, ops: event.ops.slice(0, i + 1) });
    if (Result.isFailure(reflected)) return Result.fail(reflected.failure);
    const after = reflected.success.state.map;
    if (op.op === "update") {
      for (const [id, node] of Object.entries(before.nodes)) {
        if (after.nodes[id] && after.nodes[id].text !== node.text) ids.push(id);
      }
    }
    before = after;
  }
  return Result.succeed(ids);
}

export const logMetrics = Effect.fnUntraced(function* (events: readonly LogEvent[]): Effect.fn.Return<LogMetrics, InvalidLogEvent> {
  let progress: ReflectionState | undefined;
  let remarks = 0;
  let maxOpenSiblings = 0;
  let index = -1;
  const invalid = (reason: string) => new InvalidLogEvent({ index, reason });
  const byId = new Map<string, Remark>();
  const ledger: ReflectionState["ledger"] = { byId, known: new Set(), processed: [] };
  const rewritesOf = new Map<string, number>();

  for (const event of events) {
    index++;
    if (event.type === "start") {
      progress = {
        map: emptyMap(event.title),
        history: progress?.history ?? { round: 0, changes: [], currentTopic: undefined, lastChanged: undefined },
        ledger: progress?.ledger ?? ledger,
      };
    } else if (event.type === "remark") {
      remarks++;
      byId.set(event.remark.id, event.remark);
    } else if (event.type === "diff") {
      if (!progress) return yield* invalid("ログの diff より前に start がありません");
      const { state } = yield* Effect.fromResult(reflectDiff(progress, event)).pipe(Effect.mapError(invalid));
      const rewritten = yield* Effect.fromResult(rewrittenIds(progress, event)).pipe(Effect.mapError(invalid));
      for (const id of rewritten) rewritesOf.set(id, (rewritesOf.get(id) ?? 0) + 1);
      progress = state;
      maxOpenSiblings = Math.max(maxOpenSiblings, openSiblings(state.map));
    }
  }
  return {
    remarks,
    rewrites: [...rewritesOf.values()].reduce((a, b) => a + b, 0),
    maxRewritesPerNode: Math.max(0, ...rewritesOf.values()),
    maxOpenSiblings,
  };
});
