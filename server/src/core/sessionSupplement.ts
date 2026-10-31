import { Clock, Deferred, Effect, Queue, Ref, Schema } from "effect";
import { cloneNode, type MeetingMap } from "./map.ts";
import { speakerNameMap } from "./speakerNames.ts";
import type { SessionState, SupplementEvent } from "./session.ts";
import { SupplementOutput, type SupplementAsk, type SupplementContext, type SupplementInput } from "./supplement.ts";

type Trigger = { readonly input: Omit<SupplementInput, "explainedTerms">; readonly ask: SupplementAsk; readonly done: Deferred.Deferred<void> };
type Pending = { readonly row: Omit<typeof SupplementEvent.Type, "reflectedAt">; readonly targets: readonly SupplementContext[] };
type Retained = { readonly pending: Pending | undefined; readonly lastAddedAt: number | undefined };

export function supplementTargets(before: MeetingMap, after: MeetingMap): string[] {
  return after.order.filter((id) => {
    const node = after.nodes[id]!;
    const old = before.nodes[id];
    const hasSupplement = after.order.some((child) => after.nodes[child]!.parent === id && after.nodes[child]!.kind === "補足");
    if (hasSupplement) return old !== undefined && old.text !== node.text;
    return (old === undefined && (node.kind === "議題" || node.kind === "論点" || node.kind === "決定"))
      || (node.kind === "案" && node.planStatus === "却下" && old?.planStatus !== "却下");
  });
}

function contextOf(state: SessionState, id: string): SupplementContext {
  const node = state.map.nodes[id]!;
  const ancestors = [];
  let parent = node.parent;
  while (parent !== null) {
    const ancestor = state.map.nodes[parent]!;
    ancestors.push(cloneNode(ancestor));
    parent = ancestor.parent;
  }
  const names = speakerNameMap(state.speakerNames);
  const supplement = state.map.order.map((id) => state.map.nodes[id]!).find((n) => n.kind === "補足" && n.parent === id);
  return {
    node: cloneNode(node), ancestors,
    siblings: state.map.order.map((id) => state.map.nodes[id]!).filter((n) => n.parent === node.parent && n.id !== id).map(cloneNode),
    supplement: supplement === undefined ? undefined : cloneNode(supplement),
    evidence: state.remarks.filter((r) => node.evidence.includes(r.id)).map((r) => {
      const name = names.get(r.speaker ?? r.track);
      return { ...r, ...(name === undefined ? {} : { speakerName: name }) };
    }),
  };
}

export class SupplementInvalid extends Schema.TaggedError<SupplementInvalid>()("SupplementInvalid", { message: Schema.String }) {}

export function validateSupplement(pending: Pending, state: SessionState) {
  const op = pending.row.op;
  if (op === null) return;
  const target = pending.targets.find((t) => op.op === "add" ? t.node.id === op.parent : t.supplement?.id === op.node);
  if (target === undefined) return "補足の操作が問い合わせの対象を指していない";
  const current = state.map.nodes[target.node.id];
  if (current === undefined || current.text !== target.node.text || current.planStatus !== target.node.planStatus) return "補足を待つ間に添える先が変わった";
  return;
}

// 独立した1本のworkerと容量1の待機列で、diffのinFlightに触れず最新の引き金だけを扱う。
export const makeSessionSupplement = Effect.fnUntraced(function* (
  read: Effect.Effect<SessionState>,
  carriedTerms: readonly string[],
  synchronized: <A>(effect: Effect.Effect<A>) => Effect.Effect<A>,
) {
  const scope = yield* Effect.scope;
  const triggers = yield* Queue.sliding<Trigger>(1);
  const latest = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const retained = yield* Ref.make<Retained>({ pending: undefined, lastAddedAt: undefined });
  const run = Effect.fnUntraced(function* (trigger: Trigger) {
    const input = yield* synchronized(Effect.gen(function* () {
      const state = yield* read;
      const { pending } = yield* Ref.get(retained);
      const explainedTerms = [...new Set([...state.explainedTerms.keys(), ...(pending?.row.term === undefined ? [] : [pending.row.term])])];
      return { ...trigger.input, explainedTerms };
    }));
    const startedAt = yield* Clock.currentTimeMillis;
    const answer = yield* trigger.ask(input);
    const decoded = yield* Schema.decodeUnknownEffect(SupplementOutput)(answer);
    const ms = (yield* Clock.currentTimeMillis) - startedAt;
    const result: Pending = { row: { type: "supplement", ...decoded, ...(answer.usage === undefined ? {} : { usage: answer.usage }), ms }, targets: trigger.input.targets };
    const invalid = validateSupplement(result, yield* read);
    if (invalid !== undefined) return yield* new SupplementInvalid({ message: invalid });
    if (decoded.op !== null) yield* Ref.update(retained, (s) => ({ ...s, pending: result }));
  });
  const worker = Effect.forever(Effect.gen(function* () {
    const trigger = yield* Queue.take(triggers);
    yield* run(trigger).pipe(
      Effect.ignore({ log: "Warn", message: "この回の補足の生成を諦めます" }),
      Effect.ensuring(Deferred.succeed(trigger.done, undefined)),
    );
  }));
  yield* Effect.forkIn(worker, scope);
  return {
    enqueue: Effect.fnUntraced(function* (before: MeetingMap, state: SessionState, ask: SupplementAsk | undefined) {
      if (ask === undefined) return;
      const targets = supplementTargets(before, state.map).map((id) => contextOf(state, id));
      if (targets.length === 0) return;
      const done = yield* Deferred.make<void>();
      yield* Ref.set(latest, done);
      yield* Queue.offer(triggers, { input: { targets, carriedTerms }, ask, done });
    }),
    take: Effect.fnUntraced(function* (force: boolean) {
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(retained, (s): [Pending | undefined, Retained] => {
        const pending = s.pending;
        if (pending === undefined || (!force && pending.row.op !== null && pending.row.op.op !== "delete" && s.lastAddedAt !== undefined && now - s.lastAddedAt < 60_000)) return [undefined, s];
        return [pending, { ...s, pending: undefined }];
      });
    }),
    added: Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.update(retained, (s) => ({ ...s, lastAddedAt: now }))),
    drained: Effect.flatMap(Ref.get(latest), (done) => done === undefined ? Effect.void : Deferred.await(done)),
  };
});
