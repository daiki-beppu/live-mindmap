import { expect } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

const wait = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

export const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000 && !condition(); i++) yield* wait(5);
    expect(condition(), what).toBe(true);
  });

// sleep だけを包んだ Clock。登録中の sleep の終点（仮想時刻の ms）を pending に持つ。TestClock が公開していない sleep の登録を観測するため
export const trackingClock = (pending: number[]) =>
  TestClock.testClockWith((testClock) =>
    Effect.succeed<Clock.Clock>({
      ...testClock,
      sleep: (duration) =>
        Effect.suspend(() => {
          const end = testClock.currentTimeMillisUnsafe() + Duration.toMillis(duration);
          pending.push(end);
          return testClock.sleep(duration).pipe(
            Effect.ensuring(Effect.sync(() => void pending.splice(pending.indexOf(end), 1))),
          );
        }),
    }),
  );

export const virtualNow = TestClock.testClockWith((testClock) => Effect.succeed(testClock.currentTimeMillisUnsafe()));

export const advanceTo = (pending: number[], target: number, observed: () => boolean) =>
  Effect.gen(function* () {
    yield* eventually(() => pending.includes(target), `仮想時刻 ${target} ms に終わる sleep が登録される`);
    expect(observed()).toBe(false);
    yield* TestClock.adjust(target - 1 - (yield* virtualNow));
    expect(observed()).toBe(false);
    yield* TestClock.adjust(1);
    yield* eventually(observed, `仮想時刻 ${target} ms で観測できる`);
    expect(yield* virtualNow).toBe(target);
  });

export const runToEnd = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    let done = false;
    const fiber = yield* effect.pipe(Effect.ensuring(Effect.sync(() => { done = true; })), Effect.forkChild);
    for (let i = 0; i < 2000 && !done; i++) {
      yield* TestClock.adjust(1000);
      yield* wait(5);
    }
    expect(done, "effect が仮想時計を進めて終わる").toBe(true);
    return yield* Fiber.join(fiber);
  });
