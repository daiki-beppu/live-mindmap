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

  // 共有画面を見ていない印（screen-off）と、等速での変化の待ち
  describe("screen-off と等速の変化", () => {
    const shot = (start: number): PlaybackScreen<never> => ({
      start,
      image: { id: `s${start}`, load: Effect.succeed(new Uint8Array([start])) },
    });
    const off = (start: number, reason: "指定" | "許可なし"): PlaybackScreen<never> => ({ start, reason });

    // 変化の受け取り（screen・screen-off の行）・発言の受け取り・差分更新の呼び出しを、起きた順に order へ書く
    const setupWithOff = Effect.fn("setupWithOff")(function* (order: string[]) {
      const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
        Effect.sync(() => {
          order.push(`diff:${input.fresh.map((u) => u.id).join("+")}${input.screens ? `[${input.screens.map((s) => s.start).join(",")}]` : ""}`);
          return { ops: [] };
        });
      const log = logLayer(
        (e) =>
          Effect.sync(() => {
            if (e.type === "remark") order.push(`push:${e.remark.id}`);
            if (e.type === "screen") order.push(`screen:${e.start}`);
            if (e.type === "screen-off") order.push(`off:${e.start}:${e.reason}`);
          }),
        () => Effect.void,
        () => Effect.succeed(new Uint8Array()),
      );
      return yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), log)));
    });

    it.effect("待ち時間なし: screen-off は渡した start・reason のまま、screen と同じ並びで発言の前に入り、差分更新に添える画面には載らない", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        // 発言の start は 0.5・9.8・19.2
        yield* playback(yield* setupWithOff(order), remarks, {
          screens: [shot(0), off(9.8, "指定"), off(10, "許可なし"), shot(25)],
        });
        expect(order).toEqual([
          "screen:0", "push:r1",
          "off:9.8:指定", "push:r2", "diff:r1+r2[0]",
          "off:10:許可なし", "push:r3",
          "screen:25", "diff:r3[25]",
        ]);
      }));

    it.effect("同じ start の screen と screen-off は、渡した順のまま入る（どちらが先でも）", () =>
      Effect.gen(function* () {
        const first: string[] = [];
        yield* playback(yield* setupWithOff(first), remarks, { screens: [off(5, "指定"), shot(5)] });
        expect(first.filter((s) => s.startsWith("screen:") || s.startsWith("off:"))).toEqual(["off:5:指定", "screen:5"]);

        const second: string[] = [];
        yield* playback(yield* setupWithOff(second), remarks, { screens: [shot(5), off(5, "許可なし")] });
        expect(second.filter((s) => s.startsWith("screen:") || s.startsWith("off:"))).toEqual(["screen:5", "off:5:許可なし"]);
      }));

    it.effect("最後の発言の後に残る screen-off も、flush の前に入る", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        yield* playback(yield* setupWithOff(order), remarks, { screens: [off(100, "許可なし")] });
        expect(order).toEqual(["push:r1", "push:r2", "diff:r1+r2", "push:r3", "off:100:許可なし", "diff:r3"]);
      }));

    // 発言の間に隙間がある再生。r1 は 0〜2 秒、r2 は 10〜12 秒
    const gapped: Remark[] = [
      { id: "r1", track: "相手", start: 0, end: 2, text: "a" },
      { id: "r2", track: "相手", start: 10, end: 12, text: "b" },
    ];
    const sleeper = (order: string[]) => (ms: number) =>
      Effect.sync(() => {
        order.push(`sleep:${Math.round(ms)}`);
      });
    const withoutDiff = (order: string[]) => order.filter((s) => !s.startsWith("diff:"));

    for (const [name, change, line] of [
      ["screen", shot(6), "screen:6"],
      ["screen-off", off(6, "指定"), "off:6:指定"],
    ] as const) {
      it.effect(`等速: ${name} は、発言と同じ時計で start まで待ってから入る（待ちの合計は発言の end と変わらない）`, () =>
        Effect.gen(function* () {
          const order: string[] = [];
          yield* playback(yield* setupWithOff(order), gapped, { sleep: sleeper(order), screens: [change] });
          expect(withoutDiff(order)).toEqual(["sleep:2000", "push:r1", "sleep:4000", line, "sleep:6000", "push:r2"]);
        }));
    }

    it.effect("等速: すでに過ぎた時刻の変化は待たず、時計も戻さない", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        // 変化 1 は、r1 を流した後（時計は 2）に入る。待たず、後ろの発言の待ちは 12 - 2 のまま
        yield* playback(yield* setupWithOff(order), gapped, { sleep: sleeper(order), screens: [shot(1)] });
        expect(withoutDiff(order)).toEqual(["sleep:2000", "push:r1", "screen:1", "sleep:10000", "push:r2"]);
      }));

    it.effect("等速: 終了時刻が逆順の発言の後でも、負の待ちをせず時計も戻さない（変化は時刻の差の分だけ待って入る）", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        const unordered: Remark[] = [
          { id: "rA", track: "相手", start: 0, end: 10, text: "a" },
          { id: "rB", track: "相手", start: 1, end: 2, text: "b" },
          { id: "rC", track: "相手", start: 13, end: 14, text: "c" },
        ];
        yield* playback(yield* setupWithOff(order), unordered, { sleep: sleeper(order), screens: [shot(12), off(13, "指定")] });
        expect(withoutDiff(order)).toEqual([
          "sleep:10000", "push:rA",
          "push:rB",
          "sleep:2000", "screen:12",
          "sleep:1000", "off:13:指定",
          "sleep:1000", "push:rC",
        ]);
      }));

    it.effect("等速: 最後の発言の後に残る変化も start まで待ってから入り、flush はその後", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        yield* playback(yield* setupWithOff(order), gapped, { sleep: sleeper(order), screens: [shot(15), off(20, "許可なし")] });
        // 差分更新の呼び出しの位置は中核（セッション）が決める。ここでは待ちと変化の順番、flush が最後であること（呼び出しが全部済んでいること）を見る
        expect(withoutDiff(order)).toEqual([
          "sleep:2000", "push:r1",
          "sleep:10000", "push:r2",
          "sleep:3000", "screen:15",
          "sleep:5000", "off:20:許可なし",
        ]);
        expect(order.filter((s) => s.startsWith("diff:"))).toHaveLength(1);
      }));

    it.effect("等速: 変化を渡さないときの待ちは今までと同じ", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        yield* playback(yield* setupWithOff(order), gapped, { sleep: sleeper(order), screens: [] });
        expect(withoutDiff(order)).toEqual(["sleep:2000", "push:r1", "sleep:10000", "push:r2"]);
      }));

    it.effect("待ち時間なし: 変化があっても sleep は呼ばない（変化の start が遠くても待たない）", () =>
      Effect.gen(function* () {
        const order: string[] = [];
        yield* playback(yield* setupWithOff(order), gapped, { screens: [shot(6), off(500, "指定")] });
        expect(order.some((s) => s.startsWith("sleep:"))).toBe(false);
        expect(withoutDiff(order)).toEqual(["push:r1", "screen:6", "push:r2", "off:500:指定"]);
        expect(order.filter((s) => s.startsWith("diff:"))).toHaveLength(1);
      }));
  });
});
