import { Cause, Deferred, Effect, Fiber, Queue, Ref } from "effect";

export const createRecordedBacklog = Effect.fnUntraced(function* <A, E = never>({ deliver, pace, untilUnpaused }: { deliver: (item: A) => Effect.Effect<void, E>; pace?: (item: A) => Effect.Effect<void>; untilUnpaused?: Effect.Effect<void> }) {
  const queue = yield* Queue.unbounded<A, Cause.Done>();
  const discarding = yield* Ref.make(false);
  const discarded = yield* Deferred.make<void>();
  const untilUnpausedOrDiscarded = untilUnpaused === undefined ? Effect.void : Effect.raceFirst(untilUnpaused, Deferred.await(discarded));
  const worker = yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        if (yield* Ref.get(discarding)) return;
        const item = yield* Queue.take(queue);
        yield* untilUnpausedOrDiscarded;
        if (pace !== undefined) yield* Effect.raceFirst(pace(item), Deferred.await(discarded));
        yield* untilUnpausedOrDiscarded;
        if (yield* Ref.get(discarding)) return;
        yield* deliver(item);
      }
    }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void)),
  );
  const settleLastDelivery = untilUnpausedOrDiscarded;
  return {
    offer: (item: A): Effect.Effect<void> => Effect.asVoid(Queue.offer(queue, item)),
    finish: Effect.gen(function* () {
      yield* Queue.end(queue);
      yield* Fiber.join(worker);
      yield* settleLastDelivery;
    }),
    discard: Effect.andThen(Ref.set(discarding, true), Effect.andThen(Deferred.succeed(discarded, undefined), Queue.end(queue))),
  };
});
