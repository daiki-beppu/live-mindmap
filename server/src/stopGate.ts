import { Effect, Ref } from "effect";

export const createStopGate = Effect.gen(function* () {
  const stopped = yield* Ref.make(false);
  return {
    stop: Ref.set(stopped, true),
    unlessStopped: <E, R>(effect: Effect.Effect<void, E, R>) =>
      Effect.flatMap(Ref.get(stopped), (isStopped) => (isStopped ? Effect.void : effect)),
  };
});
