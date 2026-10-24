import { Cause, Deferred, Effect, Fiber, Queue, Ref } from "effect";

export const createRecordedBacklog = Effect.fnUntraced(function* <A>({ deliver, pace, hold }: { deliver: (item: A) => Effect.Effect<void>; pace?: (item: A) => Effect.Effect<void>; hold?: Effect.Effect<void> }) {
  const queue = yield* Queue.unbounded<A, Cause.Done>();
  const discarding = yield* Ref.make(false);
  const discarded = yield* Deferred.make<void>();
  const worker = yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        if (yield* Ref.get(discarding)) return;
        const item = yield* Queue.take(queue);
        if (hold !== undefined) yield* Effect.raceFirst(hold, Deferred.await(discarded));
        if (pace !== undefined) yield* Effect.raceFirst(pace(item), Deferred.await(discarded));
        if (hold !== undefined) yield* Effect.raceFirst(hold, Deferred.await(discarded));
        if (yield* Ref.get(discarding)) return;
        yield* deliver(item);
      }
    }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void)),
  );
  return {
    offer: (item: A): Effect.Effect<void> => Effect.asVoid(Queue.offer(queue, item)),
    finish: Effect.andThen(Queue.end(queue), Fiber.join(worker)),
    discard: Effect.andThen(Ref.set(discarding, true), Effect.andThen(Deferred.succeed(discarded, undefined), Queue.end(queue))),
  };
});
