import { Effect } from "effect";

// テストの準備・後片付けの Promise。reject は想定外なので defect にする
export const promiseOrDie = <A>(thunk: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(thunk).pipe(Effect.orDie);
