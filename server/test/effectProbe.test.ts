// ツールチェーンの確認用（#194）。@effect/vitest の it.effect と TestClock が vitest 5 で動くか
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { Clock2, InvalidRemark, stamp } from "../src/core/effectProbe.ts";

describe("effect probe", () => {
  it.effect("型付きのエラーで失敗する", () =>
    Effect.gen(function* () {
      const error = yield* stamp({ speaker: "nobody" }).pipe(Effect.provide(Clock2.fixed(1)), Effect.flip);
      assert.instanceOf(error, InvalidRemark);
    }),
  );

  it.effect("TestClock で 5 秒の猶予を進めると SIGKILL に切り替わる", () =>
    Effect.gen(function* () {
      const signals: Array<string> = [];
      const exited = yield* Deferred.make<void>();
      // SIGTERM を無視し、SIGKILL で終わる偽の子プロセス
      const kill = (signal: string) =>
        Effect.sync(() => signals.push(signal)).pipe(
          Effect.andThen(signal === "SIGKILL" ? Deferred.succeed(exited, undefined) : Effect.void),
        );
      const terminate = Effect.gen(function* () {
        yield* kill("SIGTERM");
        const done = yield* Deferred.await(exited).pipe(Effect.timeoutOption("5 seconds"));
        if (done._tag === "None") yield* kill("SIGKILL");
      });
      const fiber = yield* Effect.forkChild(terminate);
      yield* TestClock.adjust("4999 millis");
      assert.deepStrictEqual(signals, ["SIGTERM"]);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
    }),
  );
});
