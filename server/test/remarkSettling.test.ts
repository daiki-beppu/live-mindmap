import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { SETTLE_QUIET_MS, type HelperPartial, type SettledRemark } from "../src/core/index.ts";
import { createRemarkSettling } from "../src/remarkSettling.ts";

// 途中結果が T 秒変わらなければ発言として出す規則に、タイマーをつなぐ層（Node 層。中核は実行環境のタイマーを使わない。ADR 0003）。
// 段 3（Issue #240）で、setTimeout/clearTimeout を Effect の Clock と Effect.sleep のファイバーに置き換える（order.md:62）。
// 期待値は書き換え前のこのファイルと同じにする（order.md:49「期待値は変えない」）。
// 「タイマーが 0 本」（vi.getTimerCount() === 0）だった既存の主張は、「予約のファイバーが無い」（settling.scheduled が false）
// で確かめる（order.md:62 が方式まで指定）。scheduled は、この置き換えのために新しく観測できる口として足す。

const T = SETTLE_QUIET_MS;
const partial = (track: HelperPartial["track"], start: number, end: number, text: string): HelperPartial => ({ track, start, end, text, duplicate: false });
const final = (track: SettledRemark["track"], start: number, end: number, text: string): SettledRemark => ({ track, start, end, text });
const texts = (emitted: SettledRemark[]) => emitted.map((r) => r.text);

const setup = Effect.fn("setup")(function* () {
  const emitted: SettledRemark[] = [];
  const settling = yield* createRemarkSettling({ emit: (r) => Effect.sync(() => emitted.push(r)) });
  return { settling, emitted };
});

describe("途中結果のタイマー", () => {
  it.effect("最後の途中結果が届いてから T 経つまでは出ず、T 経ったとき、最後の本文・区間で 1 件だけ出る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "あ"));
      yield* TestClock.adjust(600);
      yield* settling.partial(partial("相手", 10, 12, "あい")); // 更新で、出す時刻が後ろにずれる
      yield* TestClock.adjust(T - 1);
      expect(emitted).toEqual([]);

      yield* TestClock.adjust(1);
      expect(emitted).toEqual([{ track: "相手", start: 10, end: 12, text: "あい" }]);

      yield* TestClock.adjust(T * 10);
      expect(emitted).toHaveLength(1); // 予約は 1 回だけ
    }));

  it.effect("start が違う発話は、それぞれ最後の到着から T 経ったときに出る（先の発話の予約が、後の発話を取りこぼさない）", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "ひとつめ"));
      yield* TestClock.adjust(300);
      yield* settling.partial(partial("相手", 20, 21, "ふたつめ"));

      yield* TestClock.adjust(T - 300);
      expect(texts(emitted)).toEqual(["ひとつめ"]);
      yield* TestClock.adjust(300);
      expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);
    }));

  it.effect("T 経つ前に確定結果が届いたら、確定結果を届いた時刻に 1 件だけ出し、その後 T が過ぎても増えない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 12, "あい"));
      yield* TestClock.adjust(T - 100);
      yield* settling.final(final("相手", 10.5, 12.5, "あいう。"));

      expect(emitted).toEqual([{ track: "相手", start: 10.5, end: 12.5, text: "あいう。" }]);
      yield* TestClock.adjust(T * 5);
      expect(emitted).toHaveLength(1);
    }));

  it.effect("出した後に届いた確定結果は捨てる。発言は増えない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 12, "あしたの"));
      yield* TestClock.adjust(T);
      expect(texts(emitted)).toEqual(["あしたの"]); // 先に出ている
      yield* settling.final(final("相手", 10.5, 12.5, "明日の会議。"));

      yield* TestClock.adjust(T * 5);
      expect(texts(emitted)).toEqual(["あしたの"]);
    }));

  it.effect("区間の一部だけが先に出ていた確定結果は、出ていない発話を確定結果の届いた時刻に出し、T が過ぎても二度出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "ひとつめ"));
      yield* TestClock.adjust(700);
      yield* settling.partial(partial("相手", 12, 13, "ふたつめ"));
      yield* TestClock.adjust(T - 700); // ひとつめだけ出る
      expect(texts(emitted)).toEqual(["ひとつめ"]);

      yield* settling.final(final("相手", 10, 13, "ひとつめ、ふたつめ。"));
      expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);

      yield* TestClock.adjust(T * 5);
      expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);
    }));

  it.effect("自分の確定結果は、そのまま 1 件出る（重複の印も保たれる）。自分の途中結果は、T が過ぎても出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "相手の途中"));
      yield* settling.partial(partial("自分", 10, 11, "自分の途中"));
      yield* settling.final({ track: "自分", start: 0, end: 2, text: "自分の確定。", duplicate: true });
      expect(emitted).toEqual([{ track: "自分", start: 0, end: 2, text: "自分の確定。", duplicate: true }]);

      // 守っている状態に到達したことを確かめる: 同じ時間で、相手の途中結果は出る
      yield* TestClock.adjust(T * 5);
      expect(texts(emitted)).toEqual(["自分の確定。", "相手の途中"]);
    }));
});

describe("停止", () => {
  it.effect("drain で、まだ出ていない発話を T を待たずにすべて出す。その後 T が過ぎても二度出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();
      yield* settling.partial(partial("相手", 10, 11, "あ"));
      yield* settling.partial(partial("相手", 20, 21, "い"));

      yield* settling.drain;

      expect(texts(emitted)).toEqual(["あ", "い"]);
      yield* TestClock.adjust(T * 5);
      expect(texts(emitted)).toEqual(["あ", "い"]);
    }));

  it.effect("stop で予約を取り消す。stop の後は、途中結果・確定結果・drain を受け付けず、何も出さない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();
      yield* settling.partial(partial("相手", 10, 11, "あ")); // 予約中
      expect(yield* settling.scheduled).toBe(true);

      yield* settling.stop;

      expect(yield* settling.scheduled).toBe(false);
      yield* TestClock.adjust(T * 5);
      expect(emitted).toEqual([]);

      yield* settling.partial(partial("相手", 20, 21, "い"));
      yield* settling.final(final("相手", 30, 31, "う。"));
      yield* settling.drain;
      expect(yield* settling.scheduled).toBe(false);
      yield* TestClock.adjust(T * 5);
      expect(emitted).toEqual([]);
    }));

  it.effect("予約が残らない: 出し終えた後と、確定結果で出し終えた後は、予約のファイバーが無い", () =>
    Effect.gen(function* () {
      const { settling } = yield* setup();
      yield* settling.partial(partial("相手", 10, 11, "あ"));
      yield* TestClock.adjust(T);
      expect(yield* settling.scheduled).toBe(false);

      yield* settling.partial(partial("相手", 20, 21, "い"));
      yield* settling.final(final("相手", 20, 21, "い。"));
      expect(yield* settling.scheduled).toBe(false);
    }));
});
