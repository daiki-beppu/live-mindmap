import { Result } from "effect";
import { diffMaps } from "./changes.ts";
import { applyOps, type AppliedOps, type MeetingMap } from "./map.ts";
import { hasContent, type Remark } from "./remark.ts";
import type { DiffEvent } from "./session.ts";
import type { ChangeEntry } from "./snapshot.ts";
import { lastChangedNode, nextCurrentTopic } from "./topic.ts";

type History = {
  readonly round: number;
  readonly changes: readonly ChangeEntry[];
  readonly currentTopic: string | undefined;
  readonly lastChanged: string | undefined;
};

export type ReflectionState = {
  readonly criteria?: readonly string[];
  readonly map: MeetingMap;
  readonly history: History;
  readonly ledger: {
    readonly byId: ReadonlyMap<string, Remark>;
    readonly known: ReadonlySet<string>;
    readonly processed: readonly Remark[];
  };
};

const stampOf = (history: { round: number }, fresh: readonly Remark[]) => ({ round: history.round + 1, at: Math.max(...fresh.map((r) => r.end)) });

export function recordRound(history: History, before: MeetingMap, applied: Pick<AppliedOps, "map" | "changeOrder" | "combined">, stamp: { round: number; at: number }): History {
  const { round, at } = stamp;
  const added = diffMaps(before, applied).map((c): ChangeEntry => ({ ...c, round, at }));
  const lastChanged = lastChangedNode(applied.map, applied.changeOrder);
  return {
    round,
    changes: [...history.changes, ...added],
    lastChanged,
    currentTopic: nextCurrentTopic(applied.map, lastChanged, history.currentTopic),
  };
}

export function reflectDiff(before: ReflectionState, event: typeof DiffEvent.Type): Result.Result<{ readonly state: ReflectionState; readonly reflectedAt: number } & Pick<AppliedOps, "dropped" | "refs">, string> {
  const fresh: Remark[] = [];
  for (const id of event.input.fresh) {
    const remark = before.ledger.byId.get(id);
    if (!remark) return Result.fail(`ログに発言がありません: ${id}`);
    fresh.push(remark);
  }
  const count = event.error !== undefined ? fresh.length : event.processedRemarks ?? fresh.length;
  if (count > fresh.length) return Result.fail("diff の反映数が入力の発言数を超えています");
  const consumed = fresh.slice(0, count);
  const known = new Set([...before.ledger.known, ...consumed.map((r) => r.id)]);
  const processed = [...before.ledger.processed, ...consumed.filter((r) => hasContent(r.text))];
  const stamp = stampOf(before.history, consumed);
  const applied = applyOps(before.map, event.ops, known, stamp, before.ledger.byId, before.criteria);
  const history = event.error === undefined ? recordRound(before.history, before.map, applied, stamp) : before.history;
  return Result.succeed({
    reflectedAt: stamp.at,
    state: { ...(before.criteria?.length ? { criteria: before.criteria } : {}), map: applied.map, history, ledger: { byId: before.ledger.byId, known, processed } },
    dropped: applied.dropped,
    refs: applied.refs,
  });
}
