// 停止の印。立てたあとは、unlessStopped で包んだ処理を何もせずに終える（remarkSettling と speakingRelay が共有する）。
import { Effect, Ref } from "effect";

export const createStopGate = Effect.gen(function* () {
  const stopped = yield* Ref.make(false);
  return {
    stop: Ref.set(stopped, true),
    // 停止後は何も受け付けない
    unlessStopped: (effect: Effect.Effect<void>) =>
      Effect.flatMap(Ref.get(stopped), (isStopped) => (isStopped ? Effect.void : effect)),
  };
});
