import { assert } from "@effect/vitest";
import { Effect, Result, type Schema } from "effect";

export function expectDecodeSuccess<A, R>(effect: Effect.Effect<A, Schema.SchemaError, R>) {
  return Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    if (Result.isFailure(result)) assert.fail(`decode に失敗した: ${result.failure.message}`);
    return result.success;
  });
}
