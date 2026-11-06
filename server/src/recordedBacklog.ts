import { Cause, Deferred, Effect, Fiber, Queue, Ref } from "effect";

export const createRecordedBacklog = Effect.fnUntraced(function* <A, E = never>({ deliver, pace, hold }: { deliver: (item: A) => Effect.Effect<void, E>; pace?: (item: A) => Effect.Effect<void>; hold?: Effect.Effect<void> }) {
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
    // 最後の発言の呼び出しも一時停止しうるので、溜まりが空でも解けるまで待ってから終える
    finish: Effect.andThen(Queue.end(queue), Effect.andThen(Fiber.join(worker), hold === undefined ? Effect.void : Effect.raceFirst(hold, Deferred.await(discarded)))),
    discard: Effect.andThen(Ref.set(discarding, true), Effect.andThen(Deferred.succeed(discarded, undefined), Queue.end(queue))),
  };
});
