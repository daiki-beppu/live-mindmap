import { Effect } from "effect";

export const createPacer = (sleep?: (ms: number) => Effect.Effect<void>) => {
  let now = 0;
  return {
    waitUntil: Effect.fnUntraced(function* (t: number) {
      if (sleep && t > now) {
        yield* sleep((t - now) * 1000);
        now = t;
      }
    }),
  };
};
