import { Effect, Ref } from "effect";

export const createStopGate = Effect.gen(function* () {
  const stopped = yield* Ref.make(false);
  return {
    stop: Ref.set(stopped, true),
    unlessStopped: (effect: Effect.Effect<void>) =>
      Effect.flatMap(Ref.get(stopped), (isStopped) => (isStopped ? Effect.void : effect)),
  };
});
