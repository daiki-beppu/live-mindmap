import { describe, expect, it } from "vitest";
import { createRemarkSettler, SETTLE_QUIET_MS, type HelperPartial, type SettledRemark } from "../src/core/index.ts";

// 途中結果が T 秒変わらなければ発言として出す規則（Issue #99。参照実装は bench/sttLatency.ts の settleVolatile、lateFinal: "discard"）。
// 時刻 now は呼び出し側が渡す（中核は実行環境のタイマーを使わない。ADR 0003）。単位はミリ秒。
const T = SETTLE_QUIET_MS;

const partial = (track: HelperPartial["track"], start: number, end: number, text: string): HelperPartial => ({ track, start, end, text, duplicate: false });
const final = (track: SettledRemark["track"], start: number, end: number, text: string, extra: Partial<SettledRemark> = {}): SettledRemark => ({
  track,
  start,
  end,
  text,
  ...extra,
});
const brief = (rs: SettledRemark[]) => rs.map((r) => [r.track, r.start, r.end, r.text]);

describe("途中結果から発言を出す時刻", () => {
  it("T は 1 秒", () => {
    expect(SETTLE_QUIET_MS).toBe(1000);
  });

  it("更新が続いた発話は、最後の途中結果が届いてから T 経ったとき、最後の本文・区間で 1 件だけ出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"), 0);
    s.partial(partial("相手", 10, 12, "あい"), 400);
    s.partial(partial("相手", 10, 13, "あいう"), 900);

    expect(s.due(900 + T - 1)).toEqual([]); // 最後の到着から T に 1ms 足りない
    expect(brief(s.due(900 + T))).toEqual([["相手", 10, 13, "あいう"]]);
    expect(s.due(900 + T * 5)).toEqual([]); // 出した発話は二度と出ない
  });

  it("次に出す時刻は、open な発話のうち最も早いものの（最後の到着 + T）。なければ undefined", () => {
    const s = createRemarkSettler();
    expect(s.nextDue()).toBeUndefined();

    s.partial(partial("相手", 10, 11, "あ"), 100);
    s.partial(partial("相手", 20, 21, "い"), 300);
    expect(s.nextDue()).toBe(100 + T);

    s.partial(partial("相手", 10, 12, "ああ"), 800); // 先の発話が更新されて遅くなる
    expect(s.nextDue()).toBe(300 + T);

    s.due(300 + T);
    s.due(800 + T);
    expect(s.nextDue()).toBeUndefined();
  });

  it("更新の間隔がちょうど T なら、まだ同じ発話の更新", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"), 0);
    s.partial(partial("相手", 10, 12, "あい"), T);

    expect(brief(s.due(T * 2))).toEqual([["相手", 10, 12, "あい"]]);
  });

  it("発話が open のまま更新の間隔が T を超えたら、先の本文・区間は 1 件の発言として出て、後の途中結果は同じ start でも別の発話になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"), 0);
    s.partial(partial("相手", 10, 15, "あいうえお"), T + 1); // 間に due を呼ばない。先の発話はまだ open

    expect(brief(s.due(T + 1))).toEqual([["相手", 10, 11, "あ"]]); // 先の発話は上書きされず、その本文・区間で出る
    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 10, 15, "あいうえお"]]); // 後の途中結果は、もう 1 件の発言
  });

  it("更新の間隔が T を超えたら、その時点の本文で出し、後の途中結果は同じ start でも別の発話になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 11, "あ"]]); // 間隔が T を超える前に、その時点の本文が出る
    s.partial(partial("相手", 10, 15, "あいうえお"), T + 1);

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 10, 15, "あいうえお"]]); // 後の途中結果は、もう 1 件の発言
  });

  it("同じ本文でも start が違う途中結果は、別の発言になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "はい"), 0);
    s.partial(partial("相手", 20, 21, "はい"), 100);

    expect(brief(s.due(100 + T))).toEqual([
      ["相手", 10, 11, "はい"],
      ["相手", 20, 21, "はい"],
    ]);
  });

  it("同じ start でもトラックが違えば別の発話。互いの更新にならない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "相手の本文"), 0);
    s.partial(partial("自分", 10, 11, "自分の本文"), 100);
    s.partial(partial("相手", 10, 12, "相手の本文の続き"), 200);

    // 自分の途中結果は発言にならない（下の「自分トラック」）。相手の発話は最後の本文で 1 件だけ
    expect(brief(s.due(200 + T))).toEqual([["相手", 10, 12, "相手の本文の続き"]]);
  });
});

describe("確定結果が先に届いた発話", () => {
  it("T 経つ前に確定結果が届いたら、途中結果からは出さず、確定結果を 1 件だけ出す。その後タイマーが来ても増えない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あい"), 0);

    const finals = s.final(final("相手", 10.5, 12.5, "あいう。"), T - 1);

    expect(brief(finals)).toEqual([["相手", 10.5, 12.5, "あいう。"]]);
    expect(s.nextDue()).toBeUndefined();
    expect(s.due(T * 10)).toEqual([]);
    expect(s.drain()).toEqual([]);
  });

  it("確定結果が覆うのは、同じトラックで区間の中央が確定結果の区間に入る発話だけ", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 9, 10, "手前で外れる"), 0); // 中央 9.5 は [10.5, 13] の手前
    s.partial(partial("相手", 11, 13, "覆われる"), 0); // 中央 12 は内側
    s.partial(partial("相手", 14, 16, "後ろで外れる"), 0); // 中央 15 は [10.5, 13] の後ろ

    const finals = s.final(final("相手", 10.5, 13, "確定"), 100);

    expect(brief(finals)).toEqual([["相手", 10.5, 13, "確定"]]);
    // 覆われなかった 2 件だけが、T 経って出る
    expect(brief(s.due(T))).toEqual([
      ["相手", 9, 10, "手前で外れる"],
      ["相手", 14, 16, "後ろで外れる"],
    ]);
  });

  it("別のトラックの発話は覆わない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "相手の途中"), 0);

    expect(brief(s.final(final("自分", 10, 12, "自分の確定"), 100))).toEqual([["自分", 10, 12, "自分の確定"]]);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "相手の途中"]]);
  });

  it("覆われた発話の start と同じ start の途中結果が確定結果の後に届いたら、新しい発話になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 10.8, "はい"), 0);
    s.final(final("相手", 10, 10.8, "はい。"), 500);
    s.partial(partial("相手", 10, 11.5, "はいそれで"), 1000);

    expect(brief(s.due(1000 + T))).toEqual([["相手", 10, 11.5, "はいそれで"]]);
  });
});

describe("出した後に届いた確定結果", () => {
  it("覆われた発話がすでに出ていたら、確定結果は捨てる。本文が違っても発言は増えず、あとで出ることもない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あしたの会議"), 0);
    expect(s.due(T)).toHaveLength(1);

    const finals = s.final(final("相手", 10.5, 12.5, "明日の会議は十時です。"), T + 500);

    expect(finals).toEqual([]);
    expect(s.due(T * 10)).toEqual([]);
    expect(s.drain()).toEqual([]);
  });

  it("区間の一部だけが先に出ていた確定結果は、確定結果を捨て、出ていない発話を途中結果の本文で、確定結果の到着時に出す", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "ひとつめ"), 0);
    s.partial(partial("相手", 12, 13, "ふたつめ"), 700); // ひとつめが出る時（T）に、まだ T 経っていない
    expect(brief(s.due(T))).toEqual([["相手", 10, 11, "ひとつめ"]]);

    const finals = s.final(final("相手", 10, 13, "ひとつめ、ふたつめ。"), T + 100);

    expect(brief(finals)).toEqual([["相手", 12, 13, "ふたつめ"]]); // 確定結果の本文は出ない
    expect(s.due(T * 10)).toEqual([]); // 出した発話は T 経っても再び出ない
  });

  it("確定結果に覆われた発話は 1 回の確定結果で使い切る。同じ区間の次の確定結果は、覆うものがないので 1 件として出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あ"), 0);
    s.due(T);
    expect(s.final(final("相手", 10, 12, "あ。"), T + 1)).toEqual([]);

    expect(brief(s.final(final("相手", 10, 12, "あ。もう一度"), T + 2))).toEqual([["相手", 10, 12, "あ。もう一度"]]);
  });
});

describe("自分トラック", () => {
  it("自分の途中結果は、T を超えても発言にならない（ヘルパーの重複判定を通らないため）。相手の同じ入力は出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"), 0);
    s.partial(partial("自分", 10, 11, "あ"), 0);

    // 守っている状態に到達したことを先に確かめる: 時間が進めば相手は出る
    expect(brief(s.due(T * 10))).toEqual([["相手", 10, 11, "あ"]]);
    expect(s.due(T * 20)).toEqual([]);
    expect(s.nextDue()).toBeUndefined();
    expect(s.drain()).toEqual([]);
  });

  it("自分の確定結果は、そのまま 1 件になる。重複の印も保たれる", () => {
    const s = createRemarkSettler();
    s.partial(partial("自分", 0, 2, "明日の会議"), 0);

    const finals = s.final(final("自分", 0, 2, "明日の会議。", { duplicate: true }), T * 3);

    expect(finals).toEqual([{ track: "自分", start: 0, end: 2, text: "明日の会議。", duplicate: true }]);
  });
});

describe("停止時（drain）", () => {
  it("まだ出ていない発話を、T を待たずにすべて出す。出したものは再び出ない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"), 0);
    s.partial(partial("相手", 20, 21, "い"), 100);
    s.partial(partial("相手", 30, 31, "覆われる"), 100);
    s.final(final("相手", 30, 31, "確定"), 200); // 30 の発話は確定結果が出る

    expect(brief(s.drain())).toEqual([
      ["相手", 10, 11, "あ"],
      ["相手", 20, 21, "い"],
    ]);
    expect(s.drain()).toEqual([]);
    expect(s.due(T * 10)).toEqual([]);
    expect(s.nextDue()).toBeUndefined();
  });

  it("すでに出た発話は、drain で再び出ない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"), 0);
    s.due(T);

    expect(s.drain()).toEqual([]);
  });
});
