import { Effect } from "effect";

// 等速の「今の時刻」（音声の秒）を持ち、時刻 t まで待つ。play --realtime と cli recorded --realtime が共有する。
// 起点は 0。すでに過ぎた時刻は待たず、時計も戻さない。sleep が無ければ（待ち時間なし）何も待たない
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
