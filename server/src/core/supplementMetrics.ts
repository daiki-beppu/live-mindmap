import { DateTime, Effect } from "effect";
import type { ExportNode } from "./export.ts";
import { emptyMap } from "./map.ts";
import { reflectDiff, reflectSupplement, type ReflectionState } from "./reflection.ts";
import type { Remark } from "./remark.ts";
import { InvalidLogEvent, type LogEvent, type SupplementEvent } from "./session.ts";

export type EvaluationLogEvent = LogEvent & { readonly loggedAt?: DateTime.Utc };
type Metadata = { category: typeof SupplementEvent.Type.category; term?: string };

function addedTimes(before: ReflectionState, after: ReflectionState, at: DateTime.Utc | undefined, added: Map<string, number>) {
  if (at === undefined) return;
  for (const id of after.map.order) {
    if (before.map.nodes[id] === undefined) added.set(id, DateTime.toEpochMillis(at));
  }
}

function recordSupplement(
  before: ReflectionState, after: ReflectionState, event: typeof SupplementEvent.Type & { loggedAt?: DateTime.Utc },
  metadata: Map<string, Metadata>, added: Map<string, number>, delays: number[],
) {
  const op = event.op;
  if (op === null || event.error !== undefined) return;
  if (op.op === "delete") {
    metadata.delete(op.node);
    return;
  }
  const id = op.op === "update" ? op.node : after.map.order.find((id) => before.map.nodes[id] === undefined)!;
  metadata.set(id, { category: event.category, term: event.term ?? metadata.get(id)?.term });
  if (op.op !== "add" || event.loggedAt === undefined) return;
  const parentAt = added.get(op.parent);
  if (parentAt !== undefined) delays.push((DateTime.toEpochMillis(event.loggedAt) - parentAt) / 1000);
}

const supplementHistory = Effect.fnUntraced(function* (events: readonly EvaluationLogEvent[]) {
  const metadata = new Map<string, Metadata>();
  const added = new Map<string, number>();
  const delays: number[] = [];
  const byId = new Map<string, Remark>();
  let progress: ReflectionState | undefined;
  for (const [index, event] of events.entries()) {
    const invalid = (reason: string) => new InvalidLogEvent({ index, reason });
    switch (event.type) {
      case "start": {
        metadata.clear();
        added.clear();
        progress = {
          map: emptyMap(event.title), criteria: event.criteria, explainedTerms: new Map(),
          history: progress?.history ?? { round: 0, changes: [], currentTopic: undefined, lastChanged: undefined },
          ledger: progress?.ledger ?? { byId, known: new Set(), processed: [] },
        };
        break;
      }
      case "remark":
        byId.set(event.remark.id, event.remark);
        break;
      case "diff": {
        if (progress === undefined) return yield* invalid("ログの diff より前に start がありません");
        const { state } = yield* Effect.fromResult(reflectDiff(progress, event)).pipe(Effect.mapError(invalid));
        addedTimes(progress, state, event.loggedAt, added);
        progress = state;
        break;
      }
      case "supplement": {
        if (progress === undefined) return yield* invalid("ログの supplement より前に start がありません");
        const { state, dropped } = yield* Effect.fromResult(reflectSupplement(progress, event)).pipe(Effect.mapError(invalid));
        if (dropped.length === 0) recordSupplement(progress, state, event, metadata, added, delays);
        progress = state;
        break;
      }
    }
  }
  return { metadata, delays };
});

function termDuplicates(nodes: readonly ExportNode[], metadata: ReadonlyMap<string, Metadata>): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const node of nodes) {
    const term = metadata.get(node.id)?.term;
    if (term === undefined) continue;
    const normalized = term.normalize("NFKC").replace(/\s/g, "");
    if (seen.has(normalized)) duplicates++;
    seen.add(normalized);
  }
  return duplicates;
}

export const supplementMetrics = Effect.fnUntraced(function* (nodes: readonly ExportNode[], log: readonly EvaluationLogEvent[] | undefined) {
  const supplements = nodes.filter((node) => node.kind === "補足");
  const regular = nodes.filter((node) => node.kind !== "補足" && node.kind !== "会議");
  const attached = regular.filter((node) => node.children.some((child) => child.kind === "補足")).length;
  const origins = new Map<string, number>();
  for (const node of supplements) {
    if (node.kind === "補足") origins.set(node.origin, (origins.get(node.origin) ?? 0) + 1);
  }
  const history = log === undefined ? undefined : yield* supplementHistory(log);
  const categories = new Map<string, number>();
  for (const node of supplements) {
    const category = history?.metadata.get(node.id)?.category;
    if (category !== undefined && category !== null) categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const duration = log?.reduce((end, event) => event.type === "remark" ? Math.max(end, event.remark.end) : end, 0);
  const delays = history?.delays.toSorted((a, b) => a - b);
  const percentile = (p: number) => delays === undefined || delays.length === 0 ? undefined : delays[Math.ceil(p * delays.length) - 1];
  return {
    count: supplements.length,
    perHour: duration === undefined || duration === 0 ? undefined : supplements.length * 3600 / duration,
    attachedRatio: regular.length === 0 ? 0 : attached / regular.length,
    duplicates: history === undefined ? undefined : termDuplicates(supplements, history.metadata),
    categories: history === undefined ? undefined : categories,
    origins,
    delayCount: delays?.length,
    p50: percentile(0.5), p90: percentile(0.9),
  };
});
