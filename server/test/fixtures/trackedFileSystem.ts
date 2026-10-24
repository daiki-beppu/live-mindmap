import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";

// 実物の FileSystem（NodeFileSystem）の操作は libuv の I/O で終わる。I/O の完了は Effect のスケジューラの外なので、
// Effect.yieldNow を何回譲っても、その間に終わる保証はない（遅い CI では終わらない）。TestClock で時間を進めるテストは、
// 「書き込みの後に始まる待ち」を時間を進める前に始めておく必要があるので、実行中の操作の数を数えて、0 になるまで待てるようにする
export const trackedFileSystem = () => {
  const io = { inFlight: 0 };
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return new Proxy(fs, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const result = value.apply(target, args);
            if (!Effect.isEffect(result)) return result;
            return Effect.suspend(() => {
              io.inFlight++;
              return result.pipe(Effect.ensuring(Effect.sync(() => { io.inFlight--; })));
            });
          };
        },
      });
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

  const tick = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));
  const settle = Effect.gen(function* () {
    const deadline = Date.now() + 5000;
    for (;;) {
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
      if (io.inFlight === 0 || Date.now() > deadline) return;
      while (io.inFlight > 0 && Date.now() <= deadline) yield* tick;
    }
  });
  const settleUntil = (condition: () => boolean) =>
    Effect.gen(function* () {
      const deadline = Date.now() + 5000;
      while (!condition() && Date.now() <= deadline) yield* settle;
    });
  return { layer, settle, settleUntil };
};
