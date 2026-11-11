import { Effect, Semaphore } from "effect";
import type { SessionWriteFailed } from "./sessionWriteFailed.ts";

export const makeScreenTransitions = Effect.fnUntraced(function* (notify: Effect.Effect<void, SessionWriteFailed>) {
  const lock = yield* Semaphore.make(1);
  const transition = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SessionWriteFailed, R> =>
    lock.withPermit(effect.pipe(Effect.tap(() => notify))).pipe(Effect.uninterruptible);
  const notifyDiscussionIfIdle = lock.withPermitsIfAvailable(1)(notify).pipe(Effect.uninterruptible);
  return { transition, notifyDiscussionIfIdle, readExclusive: lock.withPermit };
});
