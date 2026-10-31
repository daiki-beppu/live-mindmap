import { Result } from "effect";
import { diffMaps } from "./changes.ts";
import { applyOps, cloneNode, type AppliedOps, type MeetingMap } from "./map.ts";
import { hasContent, type Remark } from "./remark.ts";
import type { DiffEvent, SupplementEvent } from "./session.ts";
import type { SupplementOperation } from "./supplement.ts";
import type { ChangeEntry } from "./snapshot.ts";
import { lastChangedNode, nextCurrentTopic } from "./topic.ts";

type History = {
  readonly round: number;
  readonly changes: readonly ChangeEntry[];
  readonly currentTopic: string | undefined;
  readonly lastChanged: string | undefined;
};

export type ReflectionState = {
  readonly explainedTerms: ReadonlyMap<string, string>;
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
    state: { ...before, map: applied.map, history, ledger: { byId: before.ledger.byId, known, processed } },
    dropped: applied.dropped,
    refs: applied.refs,
  });
}

function supplementAddError(before: ReflectionState, parent: string): string | undefined {
  const target = before.map.nodes[parent]!;
  if (target.kind === "会議" || target.kind === "補足") return "会議・補足には添えられない";
  if (Object.values(before.map.nodes).some((n) => n.parent === target.id && n.kind === "補足")) return "既に補足がある";
  return;
}

function supplementError(before: ReflectionState, event: typeof SupplementEvent.Type, op: SupplementOperation): string | undefined {
  const target = before.map.nodes[op.op === "add" ? op.parent : op.node];
  if (!target) return "添える先または補足が無い";
  if (op.op === "add") {
    const reason = supplementAddError(before, target.id);
    if (reason !== undefined) return reason;
  } else if (target.kind !== "補足") return "対象は補足ではない";
  if (op.op === "delete") return;
  const explainedBy = event.term === undefined ? undefined : before.explainedTerms.get(event.term);
  if (explainedBy !== undefined && (op.op === "add" || explainedBy !== target.id)) return "この語は説明済み";
  const parent = op.op === "add" ? target : before.map.nodes[target.parent!];
  if (!parent) return "添える先が無い";
  if (op.evidence.length === 0) return "根拠が無い";
  if (op.evidence.some((id) => !before.ledger.byId.has(id) || !parent.evidence.includes(id))) return "根拠は添える先の発言から選ぶ";
  return;
}

function supplementEvidence(map: MeetingMap, op: Exclude<SupplementOperation, { op: "delete" }>): string[] {
  if (op.op === "add") return [...op.evidence];
  return [...new Set([...map.nodes[op.node]!.evidence, ...op.evidence])];
}

export function reflectSupplement(before: ReflectionState, event: typeof SupplementEvent.Type): Result.Result<{
  readonly state: ReflectionState;
  readonly dropped: readonly { readonly op: SupplementOperation; readonly reason: string }[];
}, string> {
  const op = event.op;
  if (event.error !== undefined || op === null) return Result.succeed({ state: before, dropped: [] });
  if (op.op !== "delete" && event.category === "用語" && event.term === undefined) return Result.fail("用語の補足には説明した語が必要");
  const reason = supplementError(before, event, op);
  if (reason !== undefined) return Result.succeed({ state: before, dropped: [{ op, reason }] });
  const nodes = Object.fromEntries(Object.entries(before.map.nodes).map(([id, node]) => [id, cloneNode(node)]));
  const map: MeetingMap = { nodes, order: [...before.map.order], nextId: before.map.nextId };
  const explainedTerms = new Map(before.explainedTerms);
  if (op.op === "delete") {
    delete nodes[op.node];
    map.order = map.order.filter((id) => id !== op.node);
  } else {
    const id = op.op === "add" ? `n${map.nextId++}` : op.node;
    const parent = op.op === "add" ? op.parent : nodes[id]!.parent!;
    const evidence = supplementEvidence(before.map, op);
    nodes[id] = { id, parent, kind: "補足", text: op.text, evidence, origin: op.origin };
    if (op.op === "add") map.order.push(id);
    if (event.term !== undefined) explainedTerms.set(event.term, id);
  }
  return Result.succeed({ state: { ...before, map, explainedTerms }, dropped: [] });
}
