import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { makeSession, playback, type DiffInput, type DiffOutput, type Remark } from "../src/core/index.ts";
import { logLayer, updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

const remarks: Remark[] = [
  { id: "r1", track: "相手", start: 0.5, end: 9.8, text: "a" },
  { id: "r2", track: "相手", start: 9.8, end: 19.2, text: "b" },
  { id: "r3", track: "相手", start: 19.2, end: 28.0, text: "c" },
];

// 発言のログと差分更新の呼び出しを、起きた順に order へ書く
const setup = Effect.fn("setup")(function* (order: string[]) {
  const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
    Effect.sync(() => {
      order.push(`diff:${input.fresh.map((u) => u.id).join("+")}`);
      return { ops: [] };
    });
  const log = logLayer((e) =>
    Effect.sync(() => {
      if (e.type === "remark") order.push(`push:${e.remark.id}`);
    }),
  );
  return yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), log)));
});

describe("再生", () => {
  it.effect("等速: 発言の end の差だけ待ってから流す（最初は 0 からの差）", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const sleep = (ms: number) =>
        Effect.sync(() => {
          order.push(`sleep:${Math.round(ms)}`);
        });
      yield* playback(yield* setup(order), remarks, { sleep });
      const sleeps = order.filter((s) => s.startsWith("sleep:"));
      expect(sleeps).toEqual(["sleep:9800", "sleep:9400", "sleep:8800"]);
      // 待ってから流す順
      expect(order.filter((s) => !s.startsWith("diff:"))).toEqual([
        "sleep:9800", "push:r1", "sleep:9400", "push:r2", "sleep:8800", "push:r3",
      ]);
    }));

  it.effect("等速: 流した発言は最後の flush で取りこぼさず差分更新に渡る", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      yield* playback(yield* setup(order), remarks, { sleep: () => Effect.void });
      const diffs = order.filter((s) => s.startsWith("diff:")).join(",").replaceAll("diff:", "").split(/[,+]/);
      expect(diffs.sort()).toEqual(["r1", "r2", "r3"]);
    }));

  it.effect("等速: 差分更新の呼び出しの完了を待たずに次の待ちへ進む（ライブと同じ呼び出し方）", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const calls: string[][] = [];
      let sleepCount = 0;
      const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
        Effect.gen(function* () {
          calls.push(input.fresh.map((u) => u.id));
          yield* Deferred.await(gate);
          return { ops: [] };
        });
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), logLayer(() => Effect.void))));
      yield* playback(session, remarks, {
        sleep: () =>
          Effect.gen(function* () {
            sleepCount++;
            if (sleepCount === 3) yield* Deferred.succeed(gate, undefined); // 3 つ目の待ちに入った時点で、最初の呼び出しはまだ終わっていない
          }),
      });
      expect(sleepCount).toBe(3);
      expect(calls[0]).toEqual(["r1", "r2"]);
    }));

  it.effect("待ち時間なし（sleep を渡さない）: sleep せず、1 発言ごとに呼び出しの終わりを待つ", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      yield* playback(yield* setup(order), remarks);
      expect(order).toEqual(["push:r1", "push:r2", "diff:r1+r2", "push:r3", "diff:r3"]);
    }));
});
