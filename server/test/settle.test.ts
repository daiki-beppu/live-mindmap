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

  it("発話が open のまま更新の間隔が T を超えたら、先の本文・区間は 1 件の発言として出て、後の途中結果は延びた分だけの発言になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"), 0);
    s.partial(partial("相手", 10, 15, "あいうえお"), T + 1); // 間に due を呼ばない。先の発話はまだ open

    expect(brief(s.due(T + 1))).toEqual([["相手", 10, 11, "あ"]]); // 先の発話は上書きされず、その本文・区間で出る
    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 11, 15, "いうえお"]]); // 後の途中結果は、出した分を除いた残りが別の発言になる
  });

  it("更新の間隔が T を超えたら、その時点の本文で出し、後の途中結果は延びた分だけの発言になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 11, "あ"]]); // 間隔が T を超える前に、その時点の本文が出る
    s.partial(partial("相手", 10, 15, "あいうえお"), T + 1);

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 11, 15, "いうえお"]]);
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
    // 手前で外れる発話は、確定結果より先に出しておく（出した発言より前の区間は発言にならないため。issue #186）
    s.partial(partial("相手", 9, 10, "手前で外れる"), 0); // 中央 9.5 は [10.5, 13] の手前
    expect(brief(s.due(T))).toEqual([["相手", 9, 10, "手前で外れる"]]);
    s.partial(partial("相手", 11, 13, "覆われる"), T); // 中央 12 は内側
    s.partial(partial("相手", 14, 16, "後ろで外れる"), T); // 中央 15 は [10.5, 13] の後ろ

    const finals = s.final(final("相手", 10.5, 13, "確定"), T + 100);

    // 手前の発話は覆われていないので、確定結果が捨てられずそのまま出る
    expect(brief(finals)).toEqual([["相手", 10.5, 13, "確定"]]);
    // 覆われなかった後ろの発話だけが、T 経って出る
    expect(brief(s.due(T * 2 + 100))).toEqual([["相手", 14, 16, "後ろで外れる"]]);
  });

  it("別のトラックの発話は覆わない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "相手の途中"), 0);

    expect(brief(s.final(final("自分", 10, 12, "自分の確定"), 100))).toEqual([["自分", 10, 12, "自分の確定"]]);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "相手の途中"]]);
  });

  it("覆われた発話の start と同じ start の途中結果が確定結果の後に届いたら、延びた分だけが新しい発言になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 10.8, "はい"), 0);
    s.final(final("相手", 10, 10.8, "はい。"), 500);
    s.partial(partial("相手", 10, 11.5, "はいそれで"), 1000);

    expect(brief(s.due(1000 + T))).toEqual([["相手", 10.8, 11.5, "それで"]]);
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
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "あ"]]);
    expect(s.final(final("相手", 10, 12, "あ。"), T + 1)).toEqual([]);

    // 覆うものがないので捨てられず、出した分（"あ"）を除いた残りが発言になる
    expect(brief(s.final(final("相手", 10, 14, "あ。もう一度"), T + 2))).toEqual([["相手", 12, 14, "もう一度"]]);
  });
});

// 同じトラックの発言どうしは会議の中の時刻が重ならず、出した本文と重なる分は出さない（Issue #186、GLOSSARY.md の「発言」）。
// 「直前に出した発言」はトラックごとに 1 件なので、どのケースも 1 個の settler 上で「出す → 次が届く」を続けて観測する。
describe("出した発言と重なる発言", () => {
  it("直前に出した発言の end と同じ時刻から始まる発言は、本文が重なって見えても切らない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "あいう"]]);

    s.partial(partial("相手", 12, 15, "あいうえお"), T + 1); // start 12 は直前の end より前ではない

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 12, 15, "あいうえお"]]);
  });

  it("同じ始まりのまま延びた発言は、直前に出した本文の分を除いた残りが、直前の end から始まる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "あいう"]]);

    s.partial(partial("相手", 10, 15, "あいうえお"), T + 1);

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 12, 15, "えお"]]);
  });

  // 補助平面の文字（"𠮷" など）は 1 文字が UTF-16 の 2 コード単位になる。切り出し位置を文字数で数えると、
  // 出した本文をもう一度出したり、出していない文字を落としたりする
  it("補助平面の文字を含む本文でも、直前に出した本文の分を除いた残りが出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "𠮷"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "𠮷"]]);

    s.partial(partial("相手", 10, 15, "𠮷野"), T + 1);

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 12, 15, "野"]]);
  });

  it("補助平面の文字の後に 2 文字続くときも、出した本文の分だけを除く", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "𠮷"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "𠮷"]]);

    s.partial(partial("相手", 10, 15, "𠮷野家"), T + 1);

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 12, 15, "野家"]]);
  });

  it("出した本文が補助平面の文字を含む 2 文字でも、残りの先頭の文字を落とさない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "𠮷田"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "𠮷田"]]);

    s.partial(partial("相手", 10, 15, "𠮷田さん"), T + 1);

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 12, 15, "さん"]]);
  });

  describe.each(["due", "final の途中結果出力", "final の確定結果出力", "drain"])("切り出し後の本文検証: %s", (exit) => {
    it.each([
      { name: "不対サロゲートとの重なりで空になる本文は出さず、直前状態を保持する", first: "\uD842", second: "𠮷野", out: [], nextStart: 14, nextText: "野山" },
      { name: "正常なサロゲートペアとの重なりは残りの本文を出す", first: "𠮷", second: "𠮷野", out: [final("相手", 12, 15, "野")], nextStart: 15, nextText: "山" },
      { name: "重ならない本文が通過したときは直前状態を更新する", first: "\uD842", second: "花", out: [final("相手", 12, 15, "花")], nextStart: 15, nextText: "野山" },
    ])("$name", ({ first, second, out, nextStart, nextText }) => {
      const s = createRemarkSettler();
      if (exit === "final の確定結果出力") {
        expect(s.final(final("相手", 10, 12, first), 0)).toEqual([final("相手", 10, 12, first)]);
      } else {
        s.partial(partial("相手", 10, 12, first), 0);
        expect(s.due(T)).toEqual([final("相手", 10, 12, first)]);
        s.partial(partial("相手", 10, 15, second), T + 1);
      }

      switch (exit) {
        case "due":
          expect(s.due(T * 2 + 1)).toEqual(out);
          break;
        case "final の途中結果出力":
          expect(s.final(final("相手", 9.5, 15.5, `${second}。`), T + 2)).toEqual(out);
          break;
        case "final の確定結果出力":
          expect(s.final(final("相手", 10, 15, second), T + 1)).toEqual(out);
          break;
        case "drain":
          expect(s.drain()).toEqual(out);
          break;
      }

      expect(s.due(T * 3)).toEqual([]);
      expect(s.drain()).toEqual([]);
      s.partial(partial("相手", 14, 18, "野山"), T * 3);
      expect(s.due(T * 4)).toEqual([final("相手", nextStart, 18, nextText)]);
      expect(s.due(T * 10)).toEqual([]);
      expect(s.drain()).toEqual([]);
    });
  });

  it("1 回の due で 2 件出るときも、先に出た発言が後の発言の「直前」になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    s.partial(partial("相手", 14, 18, "えおかき"), 0);

    expect(brief(s.due(T))).toEqual([
      ["相手", 10, 15, "あいうえお"],
      ["相手", 15, 18, "かき"],
    ]);
  });

  it("出した発言の本文に丸ごと含まれる発言は出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいうえお"]]); // 守っている状態（直前の発言が出ている）に到達したことを先に確かめる

    s.partial(partial("相手", 12, 14, "うえ"), T + 1);

    expect(s.due(T + 1 + T)).toEqual([]);
  });

  it("start をずらした結果 end が start より前になる発言は、本文が重なっていなくても出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいうえお"]]);

    s.partial(partial("相手", 12, 14, "かきく"), T + 1); // 本文は重ならないが、区間が直前の発言の中に収まる

    expect(s.due(T + 1 + T)).toEqual([]);
  });

  it("start をずらした結果 end が start と同じになる発言も出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいうえお"]]);

    s.partial(partial("相手", 12.5, 15, "かきく"), T + 1); // ずらすと start も end も 15 になる

    expect(s.due(T + 1 + T)).toEqual([]);
  });

  it("直前の本文の末尾と次の本文の頭が重なるときは、重なる最長の部分を除いて出す", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいうえお"]]);

    s.partial(partial("相手", 14, 18, "えおかき"), T + 1);

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 15, 18, "かき"]]);
  });

  it("区間の端だけが食い込み本文が重ならないときは、本文をそのまま、start だけずらして出す", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいう"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいう"]]);

    s.partial(partial("相手", 14.7, 18, "かきく"), T + 1);

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 15, 18, "かきく"]]);
  });

  it("本文を比べるときは句読点・空白を無視し、出す本文は元のまま切り出す", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう、"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "あいう、"]]);

    s.partial(partial("相手", 10, 15, "あいうえお。"), T + 1);

    expect(brief(s.due(T + 1 + T))).toEqual([["相手", 12, 15, "えお。"]]);
  });

  it("切った結果、句読点・空白だけになる発言は出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "あいう"]]);

    s.partial(partial("相手", 10, 13, "あいう。"), T + 1);

    expect(s.due(T + 1 + T)).toEqual([]);
  });

  it("final が覆った途中結果をまとめて出すときも、同じ切り方になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 12, "あいう"]]);
    s.partial(partial("相手", 10, 15, "あいうえお"), T + 1); // まだ出ていない。確定結果がこれと出した発話の両方を覆う

    expect(brief(s.final(final("相手", 9.5, 15.5, "あいうえお。"), T + 2))).toEqual([["相手", 12, 15, "えお"]]);
  });

  it("確定結果そのものを出すときも、同じ切り方になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいうえお"]]);

    expect(brief(s.final(final("相手", 14, 18, "えおかき"), T + 1))).toEqual([["相手", 15, 18, "かき"]]);
  });

  it("drain で出す発言も、同じ切り方になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいうえお"]]);
    s.partial(partial("相手", 14, 18, "えおかき"), T + 1);

    expect(brief(s.drain())).toEqual([["相手", 15, 18, "かき"]]);
  });

  it("出さなかった発言は「直前に出した発言」にならない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいうえお"]]);
    s.partial(partial("相手", 12, 14, "うえ"), T + 1);
    expect(s.due(T + 1 + T)).toEqual([]);

    s.partial(partial("相手", 14, 18, "えおかき"), T * 3);

    // 出さなかった (12, 14, "うえ") が「直前」なら、start 14 は重ならず (14, 18, "えおかき") のまま出る
    expect(brief(s.due(T * 4))).toEqual([["相手", 15, 18, "かき"]]);
  });

  it("出さなかった発言は、あとの due / drain でも出てこない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいうえお"]]);
    s.partial(partial("相手", 12, 14, "うえ"), T + 1);

    expect(s.due(T + 1 + T)).toEqual([]);
    expect(s.due(T * 10)).toEqual([]);
    expect(s.nextDue()).toBeUndefined();
    expect(s.drain()).toEqual([]);
  });

  it("切った発言でも、重複の印はそのまま残る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"), 0);
    expect(brief(s.due(T))).toEqual([["相手", 10, 15, "あいうえお"]]);

    expect(s.final(final("相手", 14, 18, "えおかき", { duplicate: true }), T + 1)).toEqual([
      { track: "相手", start: 15, end: 18, text: "かき", duplicate: true },
    ]);
  });

  it("自分のトラックは重なっても切らない。相手の同じ入力は切られる", () => {
    const s = createRemarkSettler();

    const mineFirst = s.final(final("自分", 10, 15, "あいうえお"), 0);
    const mineSecond = s.final(final("自分", 12, 16, "うえおかき"), 100);
    const theirsFirst = s.final(final("相手", 10, 15, "あいうえお"), 200);
    const theirsSecond = s.final(final("相手", 12, 16, "うえおかき"), 300);

    expect(brief(mineFirst)).toEqual([["自分", 10, 15, "あいうえお"]]);
    expect(brief(mineSecond)).toEqual([["自分", 12, 16, "うえおかき"]]); // 本文も時刻もそのまま
    expect(brief(theirsFirst)).toEqual([["相手", 10, 15, "あいうえお"]]);
    expect(brief(theirsSecond)).toEqual([["相手", 15, 16, "かき"]]); // 同じ入力でも相手は切られる
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
    // 覆われる発話を会議の中で最初に置く（出した発言より前の区間は発言にならないため。issue #186）
    s.partial(partial("相手", 10, 11, "覆われる"), 0);
    s.partial(partial("相手", 20, 21, "あ"), 100);
    s.partial(partial("相手", 30, 31, "い"), 100);
    s.final(final("相手", 10, 11, "確定"), 200); // 10 の発話は確定結果が出る

    expect(brief(s.drain())).toEqual([
      ["相手", 20, 21, "あ"],
      ["相手", 30, 31, "い"],
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
