import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTLE_QUIET_MS, type HelperPartial, type SettledRemark } from "../src/core/index.ts";
import { createRemarkSettling } from "../src/remarkSettling.ts";

// 途中結果が T 秒変わらなければ発言として出す規則に、タイマーをつなぐ層（Node 層。中核は実行環境のタイマーを使わない。ADR 0003）。
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const T = SETTLE_QUIET_MS;
const partial = (track: HelperPartial["track"], start: number, end: number, text: string): HelperPartial => ({ track, start, end, text, duplicate: false });
const final = (track: SettledRemark["track"], start: number, end: number, text: string): SettledRemark => ({ track, start, end, text });
const texts = (emitted: SettledRemark[]) => emitted.map((r) => r.text);

function setup() {
  const emitted: SettledRemark[] = [];
  const settling = createRemarkSettling({ emit: (r) => emitted.push(r) });
  return { settling, emitted };
}

describe("途中結果のタイマー", () => {
  it("最後の途中結果が届いてから T 経つまでは出ず、T 経ったとき、最後の本文・区間で 1 件だけ出る", () => {
    const { settling, emitted } = setup();

    settling.partial(partial("相手", 10, 11, "あ"));
    vi.advanceTimersByTime(600);
    settling.partial(partial("相手", 10, 12, "あい")); // 更新で、出す時刻が後ろにずれる
    vi.advanceTimersByTime(T - 1);
    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(emitted).toEqual([{ track: "相手", start: 10, end: 12, text: "あい" }]);

    vi.advanceTimersByTime(T * 10);
    expect(emitted).toHaveLength(1); // 予約は 1 回だけ
  });

  it("start が違う発話は、それぞれ最後の到着から T 経ったときに出る（先の発話の予約が、後の発話を取りこぼさない）", () => {
    const { settling, emitted } = setup();

    settling.partial(partial("相手", 10, 11, "ひとつめ"));
    vi.advanceTimersByTime(300);
    settling.partial(partial("相手", 20, 21, "ふたつめ"));

    vi.advanceTimersByTime(T - 300);
    expect(texts(emitted)).toEqual(["ひとつめ"]);
    vi.advanceTimersByTime(300);
    expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);
  });

  it("T 経つ前に確定結果が届いたら、確定結果を届いた時刻に 1 件だけ出し、その後 T が過ぎても増えない", () => {
    const { settling, emitted } = setup();

    settling.partial(partial("相手", 10, 12, "あい"));
    vi.advanceTimersByTime(T - 100);
    settling.final(final("相手", 10.5, 12.5, "あいう。"));

    expect(emitted).toEqual([{ track: "相手", start: 10.5, end: 12.5, text: "あいう。" }]);
    vi.advanceTimersByTime(T * 5);
    expect(emitted).toHaveLength(1);
  });

  it("出した後に届いた確定結果は捨てる。発言は増えない", () => {
    const { settling, emitted } = setup();

    settling.partial(partial("相手", 10, 12, "あしたの"));
    vi.advanceTimersByTime(T);
    expect(texts(emitted)).toEqual(["あしたの"]); // 先に出ている
    settling.final(final("相手", 10.5, 12.5, "明日の会議。"));

    vi.advanceTimersByTime(T * 5);
    expect(texts(emitted)).toEqual(["あしたの"]);
  });

  it("区間の一部だけが先に出ていた確定結果は、出ていない発話を確定結果の届いた時刻に出し、T が過ぎても二度出ない", () => {
    const { settling, emitted } = setup();

    settling.partial(partial("相手", 10, 11, "ひとつめ"));
    vi.advanceTimersByTime(700);
    settling.partial(partial("相手", 12, 13, "ふたつめ"));
    vi.advanceTimersByTime(T - 700); // ひとつめだけ出る
    expect(texts(emitted)).toEqual(["ひとつめ"]);

    settling.final(final("相手", 10, 13, "ひとつめ、ふたつめ。"));
    expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);

    vi.advanceTimersByTime(T * 5);
    expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);
  });

  it("自分の確定結果は、そのまま 1 件出る（重複の印も保たれる）。自分の途中結果は、T が過ぎても出ない", () => {
    const { settling, emitted } = setup();

    settling.partial(partial("相手", 10, 11, "相手の途中"));
    settling.partial(partial("自分", 10, 11, "自分の途中"));
    settling.final({ track: "自分", start: 0, end: 2, text: "自分の確定。", duplicate: true });
    expect(emitted).toEqual([{ track: "自分", start: 0, end: 2, text: "自分の確定。", duplicate: true }]);

    // 守っている状態に到達したことを確かめる: 同じ時間で、相手の途中結果は出る
    vi.advanceTimersByTime(T * 5);
    expect(texts(emitted)).toEqual(["自分の確定。", "相手の途中"]);
  });
});

describe("停止", () => {
  it("drain で、まだ出ていない発話を T を待たずにすべて出す。その後 T が過ぎても二度出ない", () => {
    const { settling, emitted } = setup();
    settling.partial(partial("相手", 10, 11, "あ"));
    settling.partial(partial("相手", 20, 21, "い"));

    settling.drain();

    expect(texts(emitted)).toEqual(["あ", "い"]);
    vi.advanceTimersByTime(T * 5);
    expect(texts(emitted)).toEqual(["あ", "い"]);
  });

  it("stop で予約を取り消す。stop の後は、途中結果・確定結果・drain を受け付けず、何も出さない", () => {
    const { settling, emitted } = setup();
    settling.partial(partial("相手", 10, 11, "あ")); // 予約中
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    settling.stop();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(T * 5);
    expect(emitted).toEqual([]);

    settling.partial(partial("相手", 20, 21, "い"));
    settling.final(final("相手", 30, 31, "う。"));
    settling.drain();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(T * 5);
    expect(emitted).toEqual([]);
  });

  it("予約が残らない: 出し終えた後と、確定結果で出し終えた後は、タイマーが 0 本", () => {
    const { settling } = setup();
    settling.partial(partial("相手", 10, 11, "あ"));
    vi.advanceTimersByTime(T);
    expect(vi.getTimerCount()).toBe(0);

    settling.partial(partial("相手", 20, 21, "い"));
    settling.final(final("相手", 20, 21, "い。"));
    expect(vi.getTimerCount()).toBe(0);
  });
});
