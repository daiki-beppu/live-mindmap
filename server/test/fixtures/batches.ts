import { Effect, Layer } from "effect";
import { makeSession, restoreSession, type DiffInput, type DiffOutput, type LogEvent, type Op, type Remark, type Session } from "../../src/core/index.ts";
import { collectLog, updaterLayer, type UpdateFailure } from "./sessionLayers.ts";

const waitForCall = (calls: readonly DiffInput[], count: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5000;
    while (calls.length < count) {
      if (Date.now() > deadline) throw new Error(`差分更新の ${count} 回目の呼び出しが始まるのを待ったが、期限内に始まらなかった（呼び出し ${calls.length} 回）`);
      yield* Effect.yieldNow;
    }
  });

export type BatchStep = Op[] | UpdateFailure;

export function gatedScripted(...script: BatchStep[]) {
  const calls: DiffInput[] = [];
  const replies: (() => void)[] = [];
  const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
    Effect.callback<DiffOutput, UpdateFailure>((resume) => {
      const step = script[calls.length] ?? [{ op: "noop" as const, reason: "台本切れ" }];
      calls.push(input);
      replies.push(() => resume(Array.isArray(step) ? Effect.succeed({ ops: step }) : Effect.fail(step as UpdateFailure)));
    });
  return { calls, update, replies };
}

type FirstCall = { readonly held: readonly Remark[]; readonly trigger: Remark };

const firstCallOf = (batches: readonly (readonly Remark[])[]): FirstCall => {
  const first = batches[0];
  if (!first || first.length === 0) throw new Error("最初の組には発言が要る");
  return { held: first.slice(0, -1), trigger: first.at(-1)! };
};

const openHolding = (title: string, held: readonly Remark[], events: LogEvent[]) => {
  if (held.length === 0) return makeSession({ title });
  const log: LogEvent[] = [{ type: "start", title }, ...held.map((remark): LogEvent => ({ type: "remark", remark }))];
  events.push(...log);
  return restoreSession(log);
};

export const playBatches = Effect.fn("playBatches")(function* (
  batches: readonly (readonly Remark[])[],
  script: readonly BatchStep[],
  options: {
    readonly events?: LogEvent[];
    readonly onApplied?: (k: number, session: Session) => Effect.Effect<void>;
  } = {},
) {
  const title = "定例";
  const events = options.events ?? [];
  const { calls, update, replies } = gatedScripted(...script);
  const layer = Layer.merge(updaterLayer(update), collectLog(events));
  const { held, trigger } = firstCallOf(batches);
  const session = yield* openHolding(title, held, events).pipe(Effect.provide(layer));
  yield* session.push(trigger);
  for (const [k] of batches.entries()) {
    const following = batches[k + 1];
    if (following) for (const r of following) yield* session.push(r);
    replies[k]!();
    if (following) yield* waitForCall(calls, k + 2);
    else yield* session.idle;
    if (options.onApplied) yield* options.onApplied(k, session);
  }
  return { session, calls, events };
});
