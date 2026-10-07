import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { makeSession, playback, type DiffInput, type DiffOutput, type PlaybackScreen, type Remark } from "../src/core/index.ts";
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

  describe("共有画面の変化（screens）", () => {
    const shot = (start: number, onLoad: () => void = () => {}): PlaybackScreen<never> => ({
      start,
      image: { id: `s${start}`, load: Effect.sync(() => { onLoad(); return new Uint8Array([start]); }) },
    });

    // 変化の受け取り（log の screen）・発言の受け取り・差分更新の呼び出しを、起きた順に order へ書く
    const setupWithScreens = Effect.fn("setupWithScreens")(function* (order: string[]) {
      const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
        Effect.sync(() => {
          order.push(`diff:${input.fresh.map((u) => u.id).join("+")}${input.screens ? `[${input.screens.map((s) => s.start).join(",")}]` : ""}`);
          return { ops: [] };
        });
      const log = logLayer((e) =>
        Effect.sync(() => {
          if (e.type === "remark") order.push(`push:${e.remark.id}`);
          if (e.type === "screen") order.push(`screen:${e.start}`);
        }),
        () => Effect.void,
        () => Effect.succeed(new Uint8Array()), // 差分更新に添える画像の読み戻し（中身はこのテストの対象ではない）
      );
      return yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), log)));
    });

    it.effect("待ち時間なし: 発言を入れる前に、その発言の start までに映り始めた変化をすべて入れる（start ちょうども含む）。残りは最後の発言の後、flush の前に入る", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        // 発言の start は 0.5・9.8・19.2。end の最大は 9.8・19.2・28.0
        yield* playback(yield* setupWithScreens(order), remarks, { screens: [shot(0), shot(9.8), shot(10), shot(25)] });
        expect(order).toEqual([
          "screen:0", "push:r1",
          "screen:9.8", "push:r2", "diff:r1+r2[0,9.8]",
          "screen:10", "push:r3",
          "screen:25", "diff:r3[10,25]",
        ]);
      }));

    it.effect("画像は変化を入れる直前に作る（全件を先にまとめて作らない）", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        const loading = (start: number) => shot(start, () => order.push(`load:${start}`));
        yield* playback(yield* setupWithScreens(order), remarks, { screens: [loading(0), loading(9.8), loading(10), loading(25)] });
        expect(order).toEqual([
          "load:0", "screen:0", "push:r1",
          "load:9.8", "screen:9.8", "push:r2", "diff:r1+r2[0,9.8]",
          "load:10", "screen:10", "push:r3",
          "load:25", "screen:25", "diff:r3[10,25]",
        ]);
      }));

    it.effect("渡す変化は start の昇順でなくても、時刻の早いものから入る", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        yield* playback(yield* setupWithScreens(order), remarks, { screens: [shot(9), shot(1)] });
        expect(order.filter((s) => s.startsWith("screen:"))).toEqual(["screen:1", "screen:9"]);
      }));

    it.effect("変化を入れた後は呼び出しの終わりを待たない（等速でも、呼び出し中に変化が入って先へ進む）", () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const calls: string[][] = [];
        const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
          Effect.gen(function* () {
            calls.push(input.fresh.map((u) => u.id));
            yield* Deferred.await(gate);
            return { ops: [] };
          });
        // 3 つ目の発言をログに書く（push する）時点で、最初の呼び出しの門を開く。r3 の前に変化 9.9 を入れるときに
        // 呼び出しの終わりを待つと、r3 まで進めず門が開かないので、ここで止まる
        const log = logLayer(
          (e) => (e.type === "remark" && e.remark.id === "r3" ? Deferred.succeed(gate, undefined).pipe(Effect.asVoid) : Effect.void),
          () => Effect.void,
          () => Effect.succeed(new Uint8Array()), // 後続の差分更新に添える画像の読み戻し
        );
        const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), log)));
        yield* playback(session, remarks, { sleep: () => Effect.void, screens: [shot(9.9)] });
        expect(calls[0]).toEqual(["r1", "r2"]);
        // 後続の r3 の差分更新も、画像の読み戻しで止まらずに updater へ届く
        expect(calls[1]).toEqual(["r3"]);
      }), 3000);

    it.effect("screens を渡さない再生は今までと同じ（変化の口を呼ばない）", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        yield* playback(yield* setupWithScreens(order), remarks);
        expect(order).toEqual(["push:r1", "push:r2", "diff:r1+r2", "push:r3", "diff:r3"]);
      }));
  });
});
