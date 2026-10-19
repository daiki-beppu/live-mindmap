// 録画からのセッションで、ヘルパーが先に文字にした発言を溜め、1 件ずつセッションへ入れる。
// 入れる処理（deliver）が終わってから次の 1 件を取る（play の待ち時間なしと同じ順）。
// hold → pace → hold の順で待つ。時刻や空きを待つ間に一時停止へ変わった場合も、投入直前に見直す。
// どちらの待ちも、待っている間に discard されたら、その 1 件は入れない。
// 溜まりを閉じて全部入れ切るのが finish、溜まりを捨てて入れ途中の 1 件だけで止めるのが discard。
import { Cause, Deferred, Effect, Fiber, Queue, Ref } from "effect";

export const createRecordedBacklog = Effect.fnUntraced(function* <A>({ deliver, pace, hold }: { deliver: (item: A) => Effect.Effect<void>; pace?: (item: A) => Effect.Effect<void>; hold?: Effect.Effect<void> }) {
  const queue = yield* Queue.unbounded<A, Cause.Done>();
  const discarding = yield* Ref.make(false);
  // discard で完了する。pace の待ちを打ち切る
  const discarded = yield* Deferred.make<void>();
  // 呼び出し側の Scope の fiber。Scope を閉じると止まる
  const worker = yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        if (yield* Ref.get(discarding)) return;
        const item = yield* Queue.take(queue);
        // 取った後に捨てる印が立っていたら、入れない
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
    // 溜まりを閉じ、溜まっている分をすべて入れ終えるまで待つ
    finish: Effect.andThen(Queue.end(queue), Fiber.join(worker)),
    // 溜まっている分を捨てる。時刻を待っている 1 件は入れない。入れている途中の 1 件は待たずに、以後は何も入れない（入れ終えるのは finish で待つ）
    discard: Effect.andThen(Ref.set(discarding, true), Effect.andThen(Deferred.succeed(discarded, undefined), Queue.end(queue))),
  };
});
