import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { Remark, SpeakingFrame } from "../src/core/index.ts";
import { createSpeakingRelay, SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { remark, textsOf } from "./fixtures/speakingRelay.ts";

// いま話している文字（SpeakingFrame）の途中結果を、偽の send と TestClock だけで間引くこと。
// 期待値は書き換え前のこのファイルと同じにする（order.md:49「期待値は変えない」）。

describe("途中結果の間引き（トラックごとに SPEAKING_INTERVAL_MS に 1 回まで）", () => {
  const setup = Effect.fn("setup")(function* (initial: Remark[] = []) {
    const frames: SpeakingFrame[] = [];
    let unreflected = initial;
    const relay = yield* createSpeakingRelay({ unreflected: Effect.sync(() => unreflected), send: (f) => Effect.sync(() => frames.push(f)) });
    return { relay, frames, setUnreflected: (r: Remark[]) => (unreflected = r) };
  });

  it.effect("間隔内に続けて届いた途中結果は、先頭の 1 件をすぐ送り、残りは間隔が過ぎたときに最後の値を 1 件だけ送る", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();

      yield* relay.partial("相手", "あ", false);
      expect(textsOf(frames, "相手")).toEqual(["あ"]); // 先頭はすぐ
      yield* TestClock.adjust(100);
      yield* relay.partial("相手", "あい", false);
      yield* TestClock.adjust(100);
      yield* relay.partial("相手", "あいう", false);
      expect(textsOf(frames, "相手")).toEqual(["あ"]); // 間隔内なので増えない

      yield* TestClock.adjust(SPEAKING_INTERVAL_MS - 200 - 1);
      expect(textsOf(frames, "相手")).toEqual(["あ"]); // 間隔の直前まではまだ送らない
      yield* TestClock.adjust(1);
      expect(textsOf(frames, "相手")).toEqual(["あ", "あいう"]); // 途中の「あい」は送らず、最後の値だけ

      yield* TestClock.adjust(SPEAKING_INTERVAL_MS * 3);
      expect(textsOf(frames, "相手")).toEqual(["あ", "あいう"]); // 予約は 1 回だけ
    }));

  it.effect("間隔が過ぎてから届いた途中結果は、待たずにすぐ送る", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();

      yield* relay.partial("相手", "あ", false);
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* relay.partial("相手", "あい", false);

      expect(textsOf(frames, "相手")).toEqual(["あ", "あい"]);
    }));

  it.effect("トラックごとに独立して間引く（片方の送信が、もう片方を待たせない）", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();

      yield* relay.partial("相手", "あ", false);
      yield* TestClock.adjust(100);
      yield* relay.partial("自分", "い", false);

      expect(textsOf(frames, "自分")).toEqual(["い"]);
      expect(textsOf(frames, "相手")).toEqual(["あ"]);
    }));

  it.effect("予約した送信は、予約した時点ではなく送る時点の最新の未反映の発言と途中結果を合成する", () =>
    Effect.gen(function* () {
      const { relay, frames, setUnreflected } = yield* setup();

      yield* relay.partial("相手", "あ", false);
      yield* TestClock.adjust(100);
      yield* relay.partial("相手", "あい", false);
      setUnreflected([remark(1, "相手", "確定した発言")]); // 予約してから送るまでの間に、発言が増えた
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);

      expect(textsOf(frames, "相手").at(-1)).toBe("確定した発言 あい");
    }));

  it.effect("stop で予約を取り消し、両トラックの空の frame を送る。stop の後は、予約も途中結果も送らない", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();
      yield* relay.partial("相手", "あ", false);
      yield* TestClock.adjust(100);
      yield* relay.partial("相手", "あい", false); // 予約中
      frames.length = 0;

      yield* relay.stop;

      expect(textsOf(frames, "相手")).toEqual([""]);
      expect(textsOf(frames, "自分")).toEqual([""]);
      frames.length = 0;
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS * 5);
      yield* relay.partial("相手", "う", false);
      yield* relay.remark("相手");
      yield* relay.flushAll;
      expect(frames).toEqual([]);
    }));
});
