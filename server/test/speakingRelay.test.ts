import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { CaptionsFrame, SettledRemark } from "../src/core/index.ts";
import { createSpeakingRelay, SPEAKING_INTERVAL_MS } from "../src/speakingRelay.ts";
import { lastTexts, partialOf, spoken } from "./fixtures/speakingRelay.ts";

// 字幕のフレーム（CaptionsFrame）の途中結果を、偽の send と TestClock だけで間引くこと（Issue #1022）。
// 間引きの間隔（SPEAKING_INTERVAL_MS）と clear / stop の意味は、書き換え前と同じ。単位がトラックごとからフレーム全体の 1 本になった。

describe("途中結果の間引き（フレーム全体で SPEAKING_INTERVAL_MS に 1 回まで）", () => {
  const setup = Effect.fn("setup")(function* () {
    const frames: CaptionsFrame[] = [];
    let unreflected: { id: string; remark: SettledRemark }[] = [];
    const relay = yield* createSpeakingRelay({
      context: Effect.sync(() => ({ unreflected, held: [], intervals: [], previewLabel: () => "相手 A" })),
      send: (f) => Effect.sync(() => frames.push(f)),
    });
    return { relay, frames, setUnreflected: (r: typeof unreflected) => (unreflected = r) };
  });

  it.effect("間隔内に続けて届いた途中結果は、先頭の 1 件をすぐ送り、残りは間隔が過ぎたときに最後の値を 1 件だけ送る", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();

      yield* relay.partial(partialOf("相手", "あ"));
      expect(frames.map(lastTextsOf)).toEqual([["あ"]]); // 先頭はすぐ
      yield* TestClock.adjust(100);
      yield* relay.partial(partialOf("相手", "あい"));
      yield* TestClock.adjust(100);
      yield* relay.partial(partialOf("相手", "あいう"));
      expect(frames).toHaveLength(1); // 間隔内なので増えない

      yield* TestClock.adjust(SPEAKING_INTERVAL_MS - 200 - 1);
      expect(frames).toHaveLength(1); // 間隔の直前まではまだ送らない
      yield* TestClock.adjust(1);
      expect(frames.map(lastTextsOf)).toEqual([["あ"], ["あいう"]]); // 途中の「あい」は送らず、最後の値だけ

      yield* TestClock.adjust(SPEAKING_INTERVAL_MS * 3);
      expect(frames).toHaveLength(2); // 予約は 1 回だけ
    }));

  it.effect("間隔が過ぎてから届いた途中結果は、待たずにすぐ送る", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();

      yield* relay.partial(partialOf("相手", "あ"));
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);
      yield* relay.partial(partialOf("相手", "あい"));

      expect(frames.map(lastTextsOf)).toEqual([["あ"], ["あい"]]);
    }));

  it.effect("両トラックの吹き出しを 1 本のフレームで送る。どちらのトラックの途中結果も、1 本の間引きに数える", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();

      yield* relay.partial(partialOf("相手", "あ", 10));
      yield* TestClock.adjust(100);
      yield* relay.partial(partialOf("自分", "い", 11));
      expect(frames).toHaveLength(1); // 自分の途中結果も、相手の送信から間隔内なので待つ
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);

      expect(lastTexts(frames)).toEqual(["あ", "い"]);
      expect(frames).toHaveLength(2);
    }));

  it.effect("予約した送信は、予約した時点ではなく送る時点の最新の未反映の発言と途中結果を合成する", () =>
    Effect.gen(function* () {
      const { relay, frames, setUnreflected } = yield* setup();

      yield* relay.partial(partialOf("相手", "あ", 50));
      yield* TestClock.adjust(100);
      yield* relay.partial(partialOf("相手", "あい", 50));
      setUnreflected([spoken(1, "相手", "確定した発言")]); // 予約してから送るまでの間に、発言が増えた
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS);

      expect(lastTexts(frames)).toEqual(["確定した発言", "あい"]);
    }));

  it.effect("発言が届いたときは、間隔を待たずにすぐ送る", () =>
    Effect.gen(function* () {
      const { relay, frames, setUnreflected } = yield* setup();
      yield* relay.partial(partialOf("相手", "あ", 50));
      yield* TestClock.adjust(10);
      const item = spoken(1, "相手", "確定した発言");
      setUnreflected([item]);

      yield* relay.remark(item.remark.track);

      expect(lastTexts(frames)).toContain("確定した発言");
    }));

  it.effect("clear は予約を取り消して空の並びを送り、以後も送れる。stop は空の並びを送り、以後は何も送らない", () =>
    Effect.gen(function* () {
      const { relay, frames } = yield* setup();
      yield* relay.partial(partialOf("相手", "あ"));
      yield* TestClock.adjust(100);
      yield* relay.partial(partialOf("相手", "あい")); // 予約中
      frames.length = 0;

      yield* relay.clear;
      expect(frames).toEqual([{ type: "captions", bubbles: [] }]);
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS * 2);
      expect(frames).toHaveLength(1); // 予約は取り消された
      yield* relay.partial(partialOf("相手", "う"));
      expect(lastTexts(frames)).toEqual(["う"]); // clear の後も送れる

      frames.length = 0;
      yield* relay.stop;
      expect(frames).toEqual([{ type: "captions", bubbles: [] }]);
      frames.length = 0;
      yield* TestClock.adjust(SPEAKING_INTERVAL_MS * 5);
      yield* relay.partial(partialOf("相手", "え"));
      yield* relay.flushAll;
      expect(frames).toEqual([]);
    }));
});

const lastTextsOf = (frame: CaptionsFrame) => frame.bubbles.map((b) => b.text);
