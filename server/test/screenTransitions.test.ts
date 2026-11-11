import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Result } from "effect";
import { makeScreenTransitions } from "../src/core/screenTransitions.ts";
import { SessionWriteFailed } from "../src/core/sessionWriteFailed.ts";

const barrier = Effect.fnUntraced(function* () {
  const entered = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  return {
    hold: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))),
    entered: Deferred.await(entered),
    release: Deferred.succeed(released, undefined),
  };
});

const waitForInterruption = Effect.fnUntraced(function* (completed: Deferred.Deferred<void>) {
  const deadline = Date.now() + 2000;
  while (!(yield* Deferred.isDone(completed))) {
    if (Date.now() >= deadline) return yield* Effect.die(new Error("排他読み取りの中断が期限内に完了しなかった"));
    yield* Effect.yieldNow;
  }
});

describe("画面の遷移の排他操作", () => {
  it.effect("遷移の成功値を返し、再判定が終わるまで次の遷移と読み取りを開始しない", () => Effect.gen(function* () {
    const notifying = yield* barrier();
    const events: string[] = [];
    const notify = Effect.gen(function* () {
      events.push("notify");
      yield* notifying.hold;
      events.push("notified");
    });
    const screen = yield* makeScreenTransitions(notify);
    const first = yield* screen.transition(Effect.sync(() => { events.push("first"); return 42; }))
      .pipe(Effect.forkChild({ startImmediately: true }));
    try {
      yield* notifying.entered;
      const second = yield* screen.transition(Effect.sync(() => { events.push("second"); }))
        .pipe(Effect.forkChild({ startImmediately: true }));
      const reading = yield* screen.readExclusive(Effect.sync(() => { events.push("read"); return "snapshot"; }))
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(events).toEqual(["first", "notify"]);
      yield* notifying.release;
      expect(yield* Fiber.join(first)).toBe(42);
      yield* Fiber.join(second);
      expect(yield* Fiber.join(reading)).toBe("snapshot");
      expect(events.indexOf("second")).toBeGreaterThan(events.indexOf("notified"));
      expect(events.indexOf("read")).toBeGreaterThan(events.indexOf("notified"));
    } finally {
      yield* notifying.release;
    }
  }));

  it.effect("遷移が失敗したら再判定せず、失敗を返して後続の遷移に解放する", () => Effect.gen(function* () {
    let notifications = 0;
    const screen = yield* makeScreenTransitions(Effect.sync(() => { notifications++; }));
    const failure = { _tag: "TransitionFailed" };
    expect(yield* screen.transition(Effect.fail(failure)).pipe(Effect.result)).toEqual(Result.fail(failure));
    expect(notifications).toBe(0);
    expect(yield* screen.transition(Effect.succeed("next"))).toBe("next");
    expect(notifications).toBe(1);
  }));

  it.effect("再判定の失敗を返し、後続の読み取りに解放する", () => Effect.gen(function* () {
    const failure = new SessionWriteFailed({ path: "log.jsonl", cause: new Error("通知の保存失敗") });
    const screen = yield* makeScreenTransitions(Effect.fail(failure));
    expect(yield* screen.transition(Effect.succeed(42)).pipe(Effect.result)).toEqual(Result.fail(failure));
    expect(yield* screen.readExclusive(Effect.succeed("next"))).toBe("next");
  }));

  it.effect("使用中の再判定は解放を待たずに戻り、読み取りの解放後にも通知を予約しない", () => Effect.gen(function* () {
    const reading = yield* barrier();
    let notifications = 0;
    const screen = yield* makeScreenTransitions(Effect.sync(() => { notifications++; }));
    const reader = yield* screen.readExclusive(reading.hold).pipe(Effect.forkChild({ startImmediately: true }));
    try {
      yield* reading.entered;
      const returned = yield* Deferred.make<void>();
      const idle = yield* screen.notifyDiscussionIfIdle.pipe(
        Effect.andThen(Deferred.succeed(returned, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
      expect(yield* Deferred.isDone(returned)).toBe(true);
      expect(notifications).toBe(0);
      yield* reading.release;
      yield* Fiber.join(reader);
      yield* Fiber.join(idle);
      expect(yield* screen.readExclusive(Effect.succeed("after"))).toBe("after");
      expect(notifications).toBe(0);
      yield* screen.notifyDiscussionIfIdle;
      expect(notifications).toBe(1);
    } finally {
      yield* reading.release;
    }
  }));

  it.effect("空いているときの再判定も完了まで排他を保つ", () => Effect.gen(function* () {
    const notifying = yield* barrier();
    const screen = yield* makeScreenTransitions(notifying.hold);
    const idle = yield* screen.notifyDiscussionIfIdle.pipe(Effect.forkChild({ startImmediately: true }));
    try {
      yield* notifying.entered;
      const entered = yield* Deferred.make<void>();
      const reader = yield* screen.readExclusive(Deferred.succeed(entered, undefined))
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(yield* Deferred.isDone(entered)).toBe(false);
      yield* notifying.release;
      yield* Fiber.join(idle);
      yield* Fiber.join(reader);
      expect(yield* Deferred.isDone(entered)).toBe(true);
    } finally {
      yield* notifying.release;
    }
  }));

  it.effect("読み取りを中断でき、中断後は通知なしで後続の遷移に解放する", () => Effect.gen(function* () {
    const reading = yield* barrier();
    let notifications = 0;
    const screen = yield* makeScreenTransitions(Effect.sync(() => { notifications++; }));
    const reader = yield* screen.readExclusive(reading.hold).pipe(Effect.forkChild({ startImmediately: true }));
    try {
      yield* reading.entered;
      const interrupted = yield* Deferred.make<void>();
      const interrupting = yield* Fiber.interrupt(reader).pipe(
        Effect.andThen(Deferred.succeed(interrupted, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* waitForInterruption(interrupted);
      yield* Fiber.join(interrupting);
      expect(notifications).toBe(0);
      expect(yield* screen.transition(Effect.succeed("next"))).toBe("next");
      expect(notifications).toBe(1);
    } finally {
      yield* reading.release;
    }
  }));
});
