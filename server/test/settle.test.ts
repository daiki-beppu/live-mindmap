import { describe, expect, it } from "vitest";
import { createRemarkSettler, SETTLE_QUIET_MS, SETTLE_SENTENCE_MS, type HelperPartial, type SettledRemark } from "../src/core/index.ts";

// 途中結果が T 秒変わらなければ発言として出す規則（Issue #99）。
// 発言を締める時計は、届いた結果の end の最大値（会議の音声の時刻。Issue #1083）。壁時計も、結果が届いた時刻も使わない。
// 時計は partial / final が受け取る結果の end（秒）でだけ進む（中核は実行環境のタイマーを使わない。ADR 0003）。テストでは、自分の途中結果（発言にならない）で時計だけを進める。
// partial / final は、時計を進めて期限の来た発話を出してから、入力を当てはめる。出た発言は戻り値で返す。
const T = SETTLE_QUIET_MS;
const S = SETTLE_SENTENCE_MS;

// 音声の時刻（ミリ秒）を結果の end（秒）に直す。*1000 で元のミリ秒に戻らない値は、期限の判定が丸め誤差で決まるので使わない
const sec = (ms: number): number => {
  const value = ms / 1000;
  if (value * 1000 !== ms) throw new Error(`${ms} ms は秒に直すと *1000 で戻らない`);
  return value;
};
// 結果の end（秒）から T 経った音声の時刻（ミリ秒）
const quiet = (end: number) => end * 1000 + T;

const partial = (track: HelperPartial["track"], start: number, end: number, text: string): HelperPartial => ({ track, start, end, text, duplicate: false });
const final = (track: SettledRemark["track"], start: number, end: number, text: string, extra: Partial<SettledRemark> = {}): SettledRemark => ({
  track,
  start,
  end,
  text,
  ...extra,
});
// 音声の時計だけを ms（ミリ秒）まで進める。自分の途中結果は発言にならず、時計だけを進める
const tick = (s: ReturnType<typeof createRemarkSettler>, ms: number): SettledRemark[] => {
  let end = ms / 1000;
  while (end * 1000 < ms) end *= 1 + Number.EPSILON; // *1000 で ms に届かない丸め誤差を、1 ulp ずつ上げて消す
  return s.partial(partial("自分", 0, end, "x"));
};
const brief = (rs: SettledRemark[]) => rs.map((r) => [r.track, r.start, r.end, r.text]);
// start・end をミリ秒に丸めた形。文の終わりまでの発言の end は区間の比例配分で、2 進数の誤差を持つ
const rounded = (rs: SettledRemark[]) => rs.map((r) => [r.track, Math.round(r.start * 1000) / 1000, Math.round(r.end * 1000) / 1000, r.text]);

describe("途中結果から発言を出す時刻", () => {
  it("T は 1 秒", () => {
    expect(SETTLE_QUIET_MS).toBe(1000);
  });

  it("更新が続いた発話は、最後の途中結果の end から T 経ったとき、最後の本文・区間で 1 件だけ出る", () => {
    const s = createRemarkSettler();
    expect(s.partial(partial("相手", 10, 11, "あ"))).toEqual([]);
    expect(s.partial(partial("相手", 10, 11.5, "あい"))).toEqual([]);
    expect(s.partial(partial("相手", 10, 12.25, "あいう"))).toEqual([]);

    expect(tick(s, quiet(12.25) - 1)).toEqual([]); // 最後の end から T に 1ms 足りない
    expect(brief(tick(s, quiet(12.25)))).toEqual([["相手", 10, 12.25, "あいう"]]);
    expect(tick(s, quiet(12.25) * 5)).toEqual([]); // 出した発話は二度と出ない
  });

  it("時計は届いた結果の end の最大値。古い end の結果で戻らない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あ"));

    s.final(final("自分", 0, 5, "古い end の結果"));
    s.partial(partial("自分", 0, 5, "古い end の途中結果"));

    expect(tick(s, 12000 + T - 1)).toEqual([]);
    expect(brief(tick(s, 12000 + T))).toEqual([["相手", 10, 12, "あ"]]);
  });

  it("時計より古い end の結果は、時計の値で数える。期限はその結果の end ではなく時計から T", () => {
    const s = createRemarkSettler();
    tick(s, 20000);

    s.partial(partial("相手", 10, 15, "あ"));

    expect(tick(s, 20000 + T - 1)).toEqual([]);
    expect(brief(tick(s, 20000 + T))).toEqual([["相手", 10, 15, "あ"]]);
  });

  it("1 秒の規則は結果の end で測る: 先の発話の最後の end からちょうど T 後の end を持つ別の発話の結果が届いたら、先の発話はその結果を当てはめる前に出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"));

    const fired = s.partial(partial("相手", 12, 13, "い"));

    expect(brief(fired)).toEqual([["相手", 10, 11, "あ"]]); // 13000 - 11000 > T で期限
    expect(brief(tick(s, quiet(13)))).toEqual([["相手", 12, 13, "い"]]);
  });

  it("1 秒の規則は結果の end で測る: T に 1ms 足りない end の結果は、同じ発話の更新になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"));

    expect(s.partial(partial("相手", 10, sec(11999), "あい"))).toEqual([]);
    expect(tick(s, 11999 + T - 1)).toEqual([]);
    expect(brief(tick(s, 11999 + T))).toEqual([["相手", 10, sec(11999), "あい"]]);
  });

  it("時計を進める境界: 最後の end から T に 1ms 足りなければ出ず、T 経つと出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"));

    expect(tick(s, 11000 + T - 1)).toEqual([]);
    expect(brief(tick(s, 11000 + T))).toEqual([["相手", 10, 11, "あ"]]);
  });

  it("同じ発話の更新は、end が T を超えて離れていても、時計を進める結果の有無によらず同じ発言の列になる（先に期限の来た分が出て、更新はその後ろだけ）", () => {
    const run = (withTick: boolean) => {
      const s = createRemarkSettler();
      const out = [...s.partial(partial("相手", 10, 11, "あ"))];
      if (withTick) out.push(...s.partial(partial("自分", 0, 12, "x")));
      out.push(...s.partial(partial("相手", 10, 15, "あいうえお")), ...s.drain());
      return brief(out);
    };

    expect(run(false)).toEqual([["相手", 10, 11, "あ"], ["相手", 11, 15, "いうえお"]]);
    expect(run(true)).toEqual(run(false));
  });

  it("T 経った時点でその本文が出て、その後の途中結果は延びた分だけの発言になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"));
    expect(brief(tick(s, quiet(11)))).toEqual([["相手", 10, 11, "あ"]]);
    s.partial(partial("相手", 10, 15, "あいうえお"));

    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 11, 15, "いうえお"]]);
  });

  it("同じ本文でも start が違う途中結果は、別の発言になる", () => {
    const s = createRemarkSettler();
    const out = [...s.partial(partial("相手", 10, 11, "はい")), ...s.partial(partial("相手", 20, 21, "はい")), ...tick(s, quiet(21))];

    expect(brief(out)).toEqual([
      ["相手", 10, 11, "はい"],
      ["相手", 20, 21, "はい"],
    ]);
  });

  it("同じ start でもトラックが違えば別の発話。互いの更新にならない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "相手の本文"));
    s.partial(partial("自分", 10, 11, "自分の本文"));
    s.partial(partial("相手", 10, 11.5, "相手の本文の続き"));

    // 自分の途中結果は発言にならない（下の「自分トラック」）。相手の発話は最後の本文で 1 件だけ
    expect(brief(tick(s, quiet(11.5)))).toEqual([["相手", 10, 11.5, "相手の本文の続き"]]);
  });
});

// Issue #1083: 時計は届いた結果の end の最大値。結果が届く間隔を詰めても延ばしても、同じ結果の列から同じ発言の列ができる
describe("発言を締める時計は結果の end（Issue #1083）", () => {
  it("他のトラックの結果の end でも時計が進む: 自分の確定結果の end で、相手の途中結果が 1 秒の規則で出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"));

    const own = s.final(final("自分", 0, 12, "自分の確定。"));

    expect(brief(own)).toEqual([
      ["相手", 10, 11, "あ"],
      ["自分", 0, 12, "自分の確定。"],
    ]); // 期限の来た発話が先、自分の確定結果が後
  });

  it("他のトラックの結果の end でも時計が進む: 自分の途中結果の end で、相手の途中結果が出る（自分の途中結果自体は発言にならない）", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"));

    expect(brief(s.partial(partial("自分", 0, 12, "自分の途中")))).toEqual([["相手", 10, 11, "あ"]]);
    expect(s.drain()).toEqual([]);
  });

  it("確定結果の end でも時計が進む: 覆われない相手の途中結果が、別の相手の確定結果の end で出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"));

    expect(brief(s.final(final("相手", 30, 32, "べつ。")))).toEqual([
      ["相手", 10, 11, "あ"],
      ["相手", 30, 32, "べつ。"],
    ]);
  });

  it("1 秒の規則の境界は他のトラックの end でも同じ: T に 1ms 足りなければ出ず、T 経つと出る", () => {
    const early = createRemarkSettler();
    early.partial(partial("相手", 10, 11, "あ"));
    expect(brief(early.final(final("自分", 0, sec(11999), "自分")))).toEqual([["自分", 0, sec(11999), "自分"]]);

    const exact = createRemarkSettler();
    exact.partial(partial("相手", 10, 11, "あ"));
    expect(brief(exact.final(final("自分", 0, 12, "自分")))).toEqual([
      ["相手", 10, 11, "あ"],
      ["自分", 0, 12, "自分"],
    ]);
  });

  it("文の終わりの規則は結果の end で測る: 他の結果の end が S に 1ms 足りなければ出ず、S 経つと文の終わりまでが先に出る", () => {
    const early = createRemarkSettler();
    early.partial(partial("相手", 10, 15, "あいう。え"));
    expect(brief(early.final(final("自分", 0, sec(15049), "自分")))).toEqual([["自分", 0, sec(15049), "自分"]]);

    const exact = createRemarkSettler();
    exact.partial(partial("相手", 10, 15, "あいう。え"));
    expect(brief(exact.final(final("自分", 0, sec(15050), "自分")))).toEqual([
      ["相手", 10, 14, "あいう。"],
      ["自分", 0, sec(15050), "自分"],
    ]);
  });

  it("期限の来た発話を出してから入力を当てはめる: 文の終わりの後、S 以上あとの end で本文が書き換わった結果が届いたら、元の文が出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいう。え"));

    const fired = s.partial(partial("相手", 10, 15.25, "あいうえお"));

    expect(brief(fired)).toEqual([["相手", 10, 14, "あいう。"]]);
  });

  it("期限の来た発話を出してから入力を当てはめる: S に満たない end で文の終わりが取り消されたら、元の文は出ない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいう。え"));

    const fired = s.partial(partial("相手", 10, sec(15040), "あいうえお"));

    expect(fired).toEqual([]);
    expect(tick(s, 15040 + S)).toEqual([]);
    expect(brief(tick(s, 15040 + T))).toEqual([["相手", 10, sec(15040), "あいうえお"]]); // 取り消された文の終わりは残らない
  });

  it("確定結果の end が文の終わりの期限を越えていたら、文の終わりまでが先に出て、確定結果は残りだけを出す", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいう。え"));

    const out = s.final(final("相手", 9.5, 15.5, "あいう。えお。"));

    expect(brief(out)).toEqual([
      ["相手", 10, 14, "あいう。"],
      ["相手", 14, 15, "え"],
    ]);
  });

  // 届く間隔を詰めても延ばしても同じ発言の列になる。間隔を延ばした結果は、期限の順に一つずつ進めたのと同じになる
  describe("同じ結果の列から、届く間隔によらず同じ発言の列ができる", () => {
    type Step = { kind: "partial"; p: HelperPartial } | { kind: "final"; r: SettledRemark };
    const steps: Step[] = [
      // 文の終わり → 同じ発話の続き → 1 秒（間隔が長い結果が次に届く）
      { kind: "partial", p: partial("相手", 10, 11, "あい") },
      { kind: "partial", p: partial("相手", 10, 11.25, "あいう。え") },
      { kind: "partial", p: partial("相手", 10, 11.5, "あいう。えお") },
      // 別の発話の途中結果。長い空きのあとに届く
      { kind: "partial", p: partial("相手", 30, 30.5, "べつの発話") },
      { kind: "partial", p: partial("相手", 30, 30.75, "べつの発話です。") },
      // 他のトラックの確定結果が時計を進める
      { kind: "final", r: final("自分", 31, 33, "自分の確定。") },
      // 先の発話の期限が後の発話より遅くなる（後の発話が先に出る）
      { kind: "partial", p: partial("相手", 40, 41, "ひとつめ") },
      { kind: "partial", p: partial("相手", 41, 41.25, "ふたつめ") },
      { kind: "partial", p: partial("相手", 40, 41.5, "ひとつめの続き") },
      // 覆われない確定結果が、長い空きのあとに届く
      { kind: "final", r: final("相手", 60, 62, "確定だけ。") },
      // 途中結果を確定結果が覆う（確定結果の end が期限の前）
      { kind: "partial", p: partial("相手", 70, 71, "覆われる") },
      { kind: "final", r: final("相手", 69.5, 71.5, "覆われる。") },
      // 古い end の結果は時計を戻さない
      { kind: "final", r: final("自分", 0, 5, "古い end") },
      { kind: "partial", p: partial("相手", 80, 81, "最後") },
    ];
    const endOf = (step: Step) => (step.kind === "partial" ? step.p.end : step.r.end);
    const feed = (s: ReturnType<typeof createRemarkSettler>, step: Step) => (step.kind === "partial" ? s.partial(step.p) : s.final(step.r));

    // 結果だけを順に渡す（間隔を詰める）
    const compressed = () => {
      const s = createRemarkSettler();
      const out = steps.flatMap((step) => feed(s, step));
      return [...out, ...s.drain()];
    };
    // 次の結果の end まで、自分の途中結果で時計を細かく進める（間隔を音声の時刻どおりに延ばす）
    const stretched = () => {
      const s = createRemarkSettler();
      const out: SettledRemark[] = [];
      let at = 0;
      for (const step of steps) {
        for (; at < endOf(step) * 1000; at += 25) out.push(...tick(s, at));
        out.push(...feed(s, step));
      }
      return [...out, ...s.drain()];
    };

    it("結果だけを順に渡した発言の列と、時計を細かく進めた発言の列は一致する", () => {
      expect(brief(compressed())).toEqual(brief(stretched()));
    });

    it("一致した列は、文の終わりまでと残り・1 秒の空き・続き・確定結果・他のトラックの結果を含む（空の一致ではない）", () => {
      expect(compressed().map((r) => r.text)).toEqual([
        "あいう。",
        "えお",
        "べつの発話です。",
        "自分の確定。",
        "ふたつめ",
        "ひとつめの続き",
        "確定だけ。",
        "覆われる。",
        "古い end",
        "最後",
      ]);
    });

    it("長い空きのあとに届く結果の end が、複数の発話の期限を越えていても、期限の順に出る", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 40, 41, "ひとつめ"));
      s.partial(partial("相手", 41, 41.25, "ふたつめ"));
      s.partial(partial("相手", 40, 41.5, "ひとつめの続き")); // ひとつめの期限は 42500、ふたつめは 42250

      const out = s.final(final("自分", 0, 100, "自分"));

      expect(out.map((r) => r.text)).toEqual(["ふたつめ", "ひとつめの続き", "自分"]);
    });
  });
});

describe("確定結果が先に届いた発話", () => {
  it("T 経つ前に確定結果が届いたら、途中結果からは出さず、確定結果を 1 件だけ出す。その後タイマーが来ても増えない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あい"));

    const finals = s.final(final("相手", 10.5, 12.5, "あいう。")); // 12500 は途中結果の期限（13000）の前

    expect(brief(finals)).toEqual([["相手", 10.5, 12.5, "あいう。"]]);
    expect(tick(s, quiet(12.5) * 10)).toEqual([]);
    expect(s.drain()).toEqual([]);
  });

  it("確定結果が覆うのは、同じトラックで区間の中央が確定結果の区間に入る発話だけ", () => {
    const s = createRemarkSettler();
    // 手前で外れる発話は、確定結果より先に出しておく（出した発言より前の区間は発言にならないため。issue #186）
    s.partial(partial("相手", 9, 10, "手前で外れる")); // 中央 9.5 は [10.5, 13] の手前
    expect(brief(tick(s, quiet(10)))).toEqual([["相手", 9, 10, "手前で外れる"]]);
    s.partial(partial("相手", 11, 12.5, "覆われる")); // 中央 11.75 は内側
    s.partial(partial("相手", 13, 13.25, "後ろで外れる")); // 中央 13.125 は [10.5, 13] の後ろ

    const finals = s.final(final("相手", 10.5, 13, "確定")); // 13000 は覆われる発話の期限（13500）の前

    // 手前の発話は覆われていないので、確定結果が捨てられずそのまま出る
    expect(brief(finals)).toEqual([["相手", 10.5, 13, "確定"]]);
    // 覆われなかった後ろの発話だけが、T 経って出る
    expect(brief(tick(s, quiet(13.25)))).toEqual([["相手", 13, 13.25, "後ろで外れる"]]);
  });

  it("別のトラックの発話は覆わない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "相手の途中"));

    expect(brief(s.final(final("自分", 10, 12, "自分の確定")))).toEqual([["自分", 10, 12, "自分の確定"]]);
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "相手の途中"]]);
  });

  it("覆われた発話の start と同じ start の途中結果が確定結果の後に届いたら、延びた分だけが新しい発言になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 10.75, "はい"));
    expect(brief(s.final(final("相手", 10, 10.75, "はい。")))).toEqual([["相手", 10, 10.75, "はい。"]]);
    s.partial(partial("相手", 10, 11.5, "はいそれで"));

    expect(brief(tick(s, quiet(11.5)))).toEqual([["相手", 10.75, 11.5, "それで"]]);
  });
});

describe("出した後に届いた確定結果", () => {
  it("覆われた発話がすでに出ていたら、確定結果は捨てる。本文が違っても発言は増えず、あとで出ることもない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あしたの会議"));
    expect(tick(s, quiet(12))).toHaveLength(1);

    const finals = s.final(final("相手", 10.5, 12.5, "明日の会議は十時です。"));

    expect(finals).toEqual([]);
    expect(tick(s, quiet(12) * 10)).toEqual([]);
    expect(s.drain()).toEqual([]);
  });

  it("区間の一部だけが先に出ていた確定結果は、確定結果を捨て、出ていない発話を途中結果の本文で、確定結果の end の時点に出す", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "ひとつめ"));
    s.partial(partial("相手", 11, 11.75, "ふたつめ")); // ひとつめが出る時（12000）に、まだ T 経っていない（期限は 12750）
    expect(brief(tick(s, quiet(11)))).toEqual([["相手", 10, 11, "ひとつめ"]]);

    const finals = s.final(final("相手", 10, 12.5, "ひとつめ、ふたつめ。"));

    expect(brief(finals)).toEqual([["相手", 11, 11.75, "ふたつめ"]]); // 確定結果の本文は出ない
    expect(tick(s, quiet(12.5) * 10)).toEqual([]); // 出した発話は T 経っても再び出ない
  });

  it("確定結果に覆われた発話は 1 回の確定結果で使い切る。同じ区間の次の確定結果は、覆うものがないので 1 件として出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あ"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "あ"]]);
    expect(s.final(final("相手", 10, 12, "あ。"))).toEqual([]);

    // 覆うものがないので捨てられず、出した分（"あ"）を除いた残りが発言になる
    expect(brief(s.final(final("相手", 10, 14, "あ。もう一度")))).toEqual([["相手", 12, 14, "もう一度"]]);
  });
});

// 同じトラックの発言どうしは会議の中の時刻が重ならず、出した本文と重なる分は出さない（Issue #186、GLOSSARY.md の「発言」）。
// 「直前に出した発言」はトラックごとに 1 件なので、どのケースも 1 個の settler 上で「出す → 次が届く」を続けて観測する。
describe("出した発言と重なる発言", () => {
  it("直前に出した発言の end と同じ時刻から始まる発言は、本文が重なって見えても切らない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "あいう"]]);

    s.partial(partial("相手", 12, 15, "あいうえお")); // start 12 は直前の end より前ではない

    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "あいうえお"]]);
  });

  it("同じ始まりのまま延びた発言は、直前に出した本文の分を除いた残りが、直前の end から始まる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "あいう"]]);

    s.partial(partial("相手", 10, 15, "あいうえお"));

    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "えお"]]);
  });

  // SpeechAnalyzer は区間の始まりから全文を送り直す。関所が覚えるのは出した残りではなく届いた全文でなければ、
  // 3 回目の全文が残りと重ならず、出した本文がもう一度出る（Issue #458）
  it("同じ始まりで全文を送り直す途中結果が 3 回続いても、出した本文を二度と出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "あいう"]]);

    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "えお"]]);

    s.partial(partial("相手", 10, 18, "あいうえおかき"));
    expect(brief(tick(s, quiet(18)))).toEqual([["相手", 15, 18, "かき"]]);
  });

  it("前の部分が書き換わった全文は、延びた分だけが、書き換えずに出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "今日はシ子ど"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "今日はシ子ど"]]);

    s.partial(partial("相手", 10, 15, "今日はシ子度です"));

    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "です"]]);
  });

  it("書き換えの後にさらに同じ始まりで延びても、出した本文を二度と出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "今日はシ子ど"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "今日はシ子ど"]]);
    s.partial(partial("相手", 10, 15, "今日はシ子度です"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "です"]]);

    s.partial(partial("相手", 10, 18, "今日はシ子度ですね明日"));

    expect(brief(tick(s, quiet(18)))).toEqual([["相手", 15, 18, "ね明日"]]);
  });

  // 短い完全一致（末尾と頭が一致）があっても、その先に書き換えを含む長い重なりがあれば、既出の部分を出さない
  it.each([
    { name: "ABC", first: "ABC案はABC", second: "ABCS案はABC続き", expected: "続き", unchangedSecond: "ABC案はABC続き" },
    { name: "今日", first: "今日の予定は今日", second: "今日の予定は明日です", expected: "です", unchangedSecond: undefined },
    { name: "そうですね", first: "そうですね今日は晴れそう", second: "そうですね今日も晴れそうです", expected: "です", unchangedSecond: undefined },
  ])("短い完全一致と書き換えが同時に起きても、延びた分だけが出る: $name", ({ first, second, expected, unchangedSecond }) => {
    for (const next of unchangedSecond === undefined ? [second] : [second, unchangedSecond]) {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 12, first));
      expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, first]]);
      s.partial(partial("相手", 10, 15, next));
      expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, expected]]);
    }
  });

  it("書き換わっただけで延びていない全文は出さず、「直前に出した発言」も更新しない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "今日はシ子ど"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "今日はシ子ど"]]);

    s.partial(partial("相手", 10, 14, "今日はシ子度"));
    expect(tick(s, quiet(14))).toEqual([]);

    s.partial(partial("相手", 10, 16, "今日はシ子度です"));
    // 直前は end 12 のまま。抑制した発言の end 14 から始まらない
    expect(brief(tick(s, quiet(16)))).toEqual([["相手", 12, 16, "です"]]);
  });

  // 補助平面の文字（"𠮷" など）は 1 文字が UTF-16 の 2 コード単位になる。切り出し位置を文字数で数えると、
  // 出した本文をもう一度出したり、出していない文字を落としたりする
  it("補助平面の文字を含む本文でも、直前に出した本文の分を除いた残りが出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "𠮷"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "𠮷"]]);

    s.partial(partial("相手", 10, 15, "𠮷野"));

    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "野"]]);
  });

  it("補助平面の文字の後に 2 文字続くときも、出した本文の分だけを除く", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "𠮷"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "𠮷"]]);

    s.partial(partial("相手", 10, 15, "𠮷野家"));

    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "野家"]]);
  });

  it("出した本文が補助平面の文字を含む 2 文字でも、残りの先頭の文字を落とさない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "𠮷田"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "𠮷田"]]);

    s.partial(partial("相手", 10, 15, "𠮷田さん"));

    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "さん"]]);
  });

  describe.each(["due", "final の途中結果出力", "final の確定結果出力", "drain"])("切り出し後の本文検証: %s", (exit) => {
    it.each([
      { name: "不対サロゲートとの重なりで空になる本文は出さず、直前状態を保持する", first: "\uD842", second: "𠮷野", out: [], nextStart: 14, nextText: "野山" },
      { name: "正常なサロゲートペアとの重なりは残りの本文を出す", first: "𠮷", second: "𠮷野", out: [final("相手", 12, 15, "野")], nextStart: 15, nextText: "山" },
      { name: "重ならない本文が通過したときは直前状態を更新する", first: "\uD842", second: "花", out: [final("相手", 12, 15, "花")], nextStart: 15, nextText: "野山" },
    ])("$name", ({ first, second, out, nextStart, nextText }) => {
      const s = createRemarkSettler();
      if (exit === "final の確定結果出力") {
        expect(s.final(final("相手", 10, 12, first))).toEqual([final("相手", 10, 12, first)]);
      } else {
        s.partial(partial("相手", 10, 12, first));
        expect(tick(s, quiet(12))).toEqual([final("相手", 10, 12, first)]);
        s.partial(partial("相手", 10, 15, second));
      }

      switch (exit) {
        case "due":
          expect(tick(s, quiet(15))).toEqual(out);
          break;
        case "final の途中結果出力":
          expect(s.final(final("相手", 9.5, 15.5, `${second}。`))).toEqual(out); // 15500 は途中結果の期限（16000）の前
          break;
        case "final の確定結果出力":
          expect(s.final(final("相手", 10, 15, second))).toEqual(out);
          break;
        case "drain":
          expect(s.drain()).toEqual(out);
          break;
      }

      expect(tick(s, 17000)).toEqual([]);
      expect(s.drain()).toEqual([]);
      s.partial(partial("相手", 14, 18, "野山"));
      expect(tick(s, quiet(18))).toEqual([final("相手", nextStart, 18, nextText)]);
      expect(tick(s, quiet(18) * 10)).toEqual([]);
      expect(s.drain()).toEqual([]);
    });
  });

  it("1 回の結果で 2 件出るときも、先に出た発言が後の発言の「直前」になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    s.partial(partial("相手", 14, 15.5, "えおかき")); // 先の発話の期限（16000）の前

    expect(brief(tick(s, quiet(15.5)))).toEqual([
      ["相手", 10, 15, "あいうえお"],
      ["相手", 15, 15.5, "かき"],
    ]);
  });

  it("出した発言の本文に丸ごと含まれる発言は出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいうえお"]]); // 守っている状態（直前の発言が出ている）に到達したことを先に確かめる

    s.partial(partial("相手", 12, 14, "うえ")); // 時計は 16000。期限はそこから T

    expect(tick(s, 17000)).toEqual([]);
  });

  it("start をずらした結果 end が start より前になる発言は、本文が重なっていなくても出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいうえお"]]);

    s.partial(partial("相手", 12, 14, "かきく")); // 本文は重ならないが、区間が直前の発言の中に収まる

    expect(tick(s, 17000)).toEqual([]);
  });

  it("start をずらした結果 end が start と同じになる発言も出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいうえお"]]);

    s.partial(partial("相手", 12.5, 15, "かきく")); // ずらすと start も end も 15 になる

    expect(tick(s, 17000)).toEqual([]);
  });

  it("直前の本文の末尾と次の本文の頭が重なるときは、重なる最長の部分を除いて出す", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいうえお"]]);

    s.partial(partial("相手", 14, 18, "えおかき"));

    expect(brief(tick(s, quiet(18)))).toEqual([["相手", 15, 18, "かき"]]);
  });

  it("区間の端だけが食い込み本文が重ならないときは、本文をそのまま、start だけずらして出す", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいう"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいう"]]);

    s.partial(partial("相手", 14.7, 18, "かきく"));

    expect(brief(tick(s, quiet(18)))).toEqual([["相手", 15, 18, "かきく"]]);
  });

  it("本文を比べるときは句読点・空白を無視し、出す本文は元のまま切り出す", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう、"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "あいう、"]]);

    s.partial(partial("相手", 10, 15, "あいうえお。"));

    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "えお。"]]);
  });

  it("切った結果、句読点・空白だけになる発言は出さない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "あいう"]]);

    s.partial(partial("相手", 10, 13, "あいう。"));

    expect(tick(s, quiet(13))).toEqual([]);
  });

  it("final が覆った途中結果をまとめて出すときも、同じ切り方になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 12, "あいう"));
    expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "あいう"]]);
    s.partial(partial("相手", 10, 15, "あいうえお")); // まだ出ていない。確定結果がこれと出した発話の両方を覆う

    expect(brief(s.final(final("相手", 9.5, 15.5, "あいうえお。")))).toEqual([["相手", 12, 15, "えお"]]);
  });

  it("確定結果そのものを出すときも、同じ切り方になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいうえお"]]);

    expect(brief(s.final(final("相手", 14, 18, "えおかき")))).toEqual([["相手", 15, 18, "かき"]]);
  });

  it("drain で出す発言も、同じ切り方になる", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいうえお"]]);
    s.partial(partial("相手", 14, 18, "えおかき"));

    expect(brief(s.drain())).toEqual([["相手", 15, 18, "かき"]]);
  });

  it("出さなかった発言は「直前に出した発言」にならない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいうえお"]]);
    s.partial(partial("相手", 12, 14, "うえ"));
    expect(tick(s, 17000)).toEqual([]);

    s.partial(partial("相手", 14, 18, "えおかき"));

    // 出さなかった (12, 14, "うえ") が「直前」なら、start 14 は重ならず (14, 18, "えおかき") のまま出る
    expect(brief(tick(s, quiet(18)))).toEqual([["相手", 15, 18, "かき"]]);
  });

  it("出さなかった発言は、あとの due / drain でも出てこない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいうえお"]]);
    s.partial(partial("相手", 12, 14, "うえ"));

    expect(tick(s, 17000)).toEqual([]);
    expect(tick(s, 100000)).toEqual([]);
    expect(s.drain()).toEqual([]);
  });

  it("切った発言でも、重複の印はそのまま残る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 15, "あいうえお"));
    expect(brief(tick(s, quiet(15)))).toEqual([["相手", 10, 15, "あいうえお"]]);

    expect(s.final(final("相手", 14, 18, "えおかき", { duplicate: true }))).toEqual([
      { track: "相手", start: 15, end: 18, text: "かき", duplicate: true },
    ]);
  });

  it("自分のトラックは重なっても切らない。相手の同じ入力は切られる", () => {
    const s = createRemarkSettler();

    const mineFirst = s.final(final("自分", 10, 15, "あいうえお"));
    const mineSecond = s.final(final("自分", 12, 16, "うえおかき"));
    const theirsFirst = s.final(final("相手", 10, 15, "あいうえお"));
    const theirsSecond = s.final(final("相手", 12, 16, "うえおかき"));

    expect(brief(mineFirst)).toEqual([["自分", 10, 15, "あいうえお"]]);
    expect(brief(mineSecond)).toEqual([["自分", 12, 16, "うえおかき"]]); // 本文も時刻もそのまま
    expect(brief(theirsFirst)).toEqual([["相手", 10, 15, "あいうえお"]]);
    expect(brief(theirsSecond)).toEqual([["相手", 15, 16, "かき"]]); // 同じ入力でも相手は切られる
  });
});

describe("自分トラック", () => {
  it("自分の途中結果は、T を超えても発言にならない（ヘルパーの重複判定を通らないため）。相手の同じ入力は出る", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"));
    s.partial(partial("自分", 10, 11, "あ"));

    // 守っている状態に到達したことを先に確かめる: 時間が進めば相手は出る
    expect(brief(tick(s, quiet(11) * 10))).toEqual([["相手", 10, 11, "あ"]]);
    expect(tick(s, quiet(11) * 20)).toEqual([]);
    expect(s.drain()).toEqual([]);
  });

  it("自分の確定結果は、そのまま 1 件になる。重複の印も保たれる", () => {
    const s = createRemarkSettler();
    s.partial(partial("自分", 0, 2, "明日の会議"));

    const finals = s.final(final("自分", 0, 2, "明日の会議。", { duplicate: true }));

    expect(finals).toEqual([{ track: "自分", start: 0, end: 2, text: "明日の会議。", duplicate: true }]);
  });
});

describe("停止時（drain）", () => {
  it("まだ出ていない発話を、T を待たずにすべて出す。出したものは再び出ない", () => {
    const s = createRemarkSettler();
    // 覆われる発話を会議の中で最初に置く（出した発言より前の区間は発言にならないため。issue #186）
    s.partial(partial("相手", 10, 11, "覆われる"));
    s.partial(partial("相手", 11, 11.25, "あ"));
    s.partial(partial("相手", 11.25, 11.5, "い"));
    s.final(final("相手", 10, 11, "確定")); // 10 の発話は確定結果が出る

    expect(brief(s.drain())).toEqual([
      ["相手", 11, 11.25, "あ"],
      ["相手", 11.25, 11.5, "い"],
    ]);
    expect(s.drain()).toEqual([]);
    expect(tick(s, quiet(11.5) * 10)).toEqual([]);
  });

  it("すでに出た発話は、drain で再び出ない", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 10, 11, "あ"));
    tick(s, quiet(11));

    expect(s.drain()).toEqual([]);
  });
});

// Issue #639: 語ごとの読み（words）を発言まで運ぶ。位置と長さは UTF-16 コード単位。
// 出す発言の本文と words は同じ切り位置から作り、残った words の位置は切った後の本文に合う。
// words を持たない入力からは、words のキーを持つ発言を作らない
type TestWord = { surface: string; romaji: string; location: number; length: number };
const w = (surface: string, location: number): TestWord => ({ surface, romaji: `r:${surface}`, location, length: surface.length });
// 本文を表記の列に区切って words にする（位置は UTF-16 の連続した位置）
const wordsOf = (...surfaces: string[]): TestWord[] => {
  let at = 0;
  return surfaces.map((surface) => {
    const word = w(surface, at);
    at += surface.length;
    return word;
  });
};
const partialW = (track: HelperPartial["track"], start: number, end: number, text: string, words?: TestWord[]): HelperPartial => ({
  ...partial(track, start, end, text),
  ...(words === undefined ? {} : { words }),
});
const finalW = (track: SettledRemark["track"], start: number, end: number, text: string, words?: TestWord[]) =>
  final(track, start, end, text, words === undefined ? {} : ({ words } as Partial<SettledRemark>));
const wordsOfRemark = (r: SettledRemark | undefined) => (r as { words?: TestWord[] } | undefined)?.words;
// 残った words は、切った後の本文の上で、位置と長さが表記と一致する
const expectWordsFitText = (r: SettledRemark | undefined) => {
  expect(r).toBeDefined();
  const words = wordsOfRemark(r);
  expect(words).toBeDefined();
  for (const word of words!) expect(r!.text.slice(word.location, word.location + word.length)).toBe(word.surface);
};

describe("words の運搬（Issue #639）", () => {
  describe("途中結果から作る発言に words が付く", () => {
    it("due: 最後の途中結果の words が付く。更新のたびに words は置き換わり、古い words は残らない", () => {
      const s = createRemarkSettler();
      s.partial(partialW("相手", 10, 11, "あ", wordsOf("あ")));
      s.partial(partialW("相手", 10, 11.5, "あいう", wordsOf("あい", "う")));
      s.partial(partialW("相手", 10, 12.25, "あいうえお", wordsOf("あい", "うえ", "お")));

      const out = tick(s, quiet(12.25));
      expect(brief(out)).toEqual([["相手", 10, 12.25, "あいうえお"]]);
      expect(wordsOfRemark(out[0])).toEqual(wordsOf("あい", "うえ", "お"));
    });

    it("words の無い途中結果で更新したら、先の words は残らない（text と words は同じ更新）", () => {
      const s = createRemarkSettler();
      s.partial(partialW("相手", 10, 11, "あ", wordsOf("あ")));
      s.partial(partialW("相手", 10, 11.5, "あいう"));

      const out = tick(s, quiet(11.5));
      expect(brief(out)).toEqual([["相手", 10, 11.5, "あいう"]]);
      expect(out[0]).not.toHaveProperty("words");
    });

    it("words の無い途中結果だけから作る発言には words のキーが無い", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 11, "あ"));

      expect(tick(s, quiet(11))[0]).not.toHaveProperty("words");
    });

    it("end の間隔が T を超えて別の発話になったとき、それぞれの発話は自分の words を持つ", () => {
      const s = createRemarkSettler();
      const out = [
        ...s.partial(partialW("相手", 10, 11, "あ", wordsOf("あ"))),
        ...s.partial(partialW("相手", 20, 21, "かき", wordsOf("か", "き"))),
        ...tick(s, quiet(21)),
      ];

      expect(out.map((r) => [r.text, wordsOfRemark(r)])).toEqual([
        ["あ", wordsOf("あ")],
        ["かき", wordsOf("か", "き")],
      ]);
    });

    it("final（途中結果の期限を越えた end の確定結果の分岐）: 出す未出の発話に、その途中結果の words が付く", () => {
      const s = createRemarkSettler();
      s.partial(partialW("相手", 10, 12, "あいう", wordsOf("あい", "う")));
      // 確定結果の end が途中結果の期限（13000）に届いている: 確定結果は捨て、途中結果からの発言を出す
      const out = s.final(finalW("相手", 10, 13, "別の確定", wordsOf("別", "の", "確定")));

      expect(brief(out)).toEqual([["相手", 10, 12, "あいう"]]);
      expect(wordsOfRemark(out[0])).toEqual(wordsOf("あい", "う"));
    });

    it("drain: まだ出ていない発話に、最後の途中結果の words が付く", () => {
      const s = createRemarkSettler();
      s.partial(partialW("相手", 10, 11, "あ", wordsOf("あ")));
      s.partial(partialW("相手", 10, 11.5, "あいう", wordsOf("あい", "う")));

      const out = s.drain();
      expect(brief(out)).toEqual([["相手", 10, 11.5, "あいう"]]);
      expect(wordsOfRemark(out[0])).toEqual(wordsOf("あい", "う"));
    });
  });

  describe("確定結果の words", () => {
    it("途中結果が無いとき、確定結果の words はそのまま出る", () => {
      const s = createRemarkSettler();
      const words = wordsOf("こんにちは");
      const out = s.final(finalW("相手", 10, 12, "こんにちは", words));

      expect(brief(out)).toEqual([["相手", 10, 12, "こんにちは"]]);
      expect(wordsOfRemark(out[0])).toEqual(words);
    });

    it("words の無い確定結果には words のキーが付かない", () => {
      const s = createRemarkSettler();

      expect(s.final(finalW("相手", 10, 12, "こんにちは"))[0]).not.toHaveProperty("words");
    });

    it("自分の確定結果は関所を通らず、words もそのまま出る", () => {
      const s = createRemarkSettler();
      const words = wordsOf("はい");
      const first = s.final(finalW("自分", 0, 2, "はい", words));
      const second = s.final(finalW("自分", 1, 3, "はい", words));

      expect(wordsOfRemark(first[0])).toEqual(words);
      expect(wordsOfRemark(second[0])).toEqual(words);
    });
  });

  // 関所が頭を切るとき、本文と words は同じ位置で切る。完全に残る語だけを残して位置をずらし、途中で切れた語は落とす。
  // 組み立て方は上の「前の部分が書き換わった全文」のテストに倣う（同じ始まりから全文を送り直す途中結果）
  describe("関所が頭を切った発言の words", () => {
    // 先に first を出し（end 12）、続けて second を同じ始まりの全文として送って、2 件目の発言を返す
    const secondRemark = (first: string, second: string, secondWords: TestWord[] | undefined) => {
      const s = createRemarkSettler();
      s.partial(partialW("相手", 10, 12, first, wordsOf(first)));
      expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, first]]);
      s.partial(partialW("相手", 10, 15, second, secondWords));
      const out = tick(s, quiet(15));
      expect(out).toHaveLength(1);
      return out[0]!;
    };

    it("完全一致の重なりで切る: 切った後に残る語だけが、切った後の本文の位置で残る", () => {
      const r = secondRemark("あいう", "あいうえお", wordsOf("あい", "う", "え", "お"));

      expect(r.text).toBe("えお");
      expect(wordsOfRemark(r)).toEqual([w("え", 0), w("お", 1)]);
      expectWordsFitText(r);
    });

    it("書き換えを含む重なり（編集距離を許す）で切る: 最終的な切り位置で words も切る", () => {
      const r = secondRemark("今日はシ子ど", "今日はシ子度です", wordsOf("今日", "は", "シ子度", "です"));

      expect(r.text).toBe("です");
      expect(wordsOfRemark(r)).toEqual([w("です", 0)]);
      expectWordsFitText(r);
    });

    it("語の途中で切れたとき、その語は落とし、読みを残った本文に流用しない", () => {
      // 切る位置は 3。"うえ"（位置 2〜4）は途中で切れるので落ちる。"お"（位置 4）は残る
      const r = secondRemark("あいう", "あいうえお", wordsOf("あい", "うえ", "お"));

      expect(r.text).toBe("えお");
      expect(wordsOfRemark(r)).toEqual([w("お", 1)]);
      expectWordsFitText(r);
    });

    it("書き換えを含む重なりで、切る位置をまたぐ語は落ちる", () => {
      // 切る位置は 6。"シ子度で"（位置 3〜7）は途中で切れるので落ちる。"す"（位置 7）は残る
      const r = secondRemark("今日はシ子ど", "今日はシ子度です", wordsOf("今日は", "シ子度で", "す"));

      expect(r.text).toBe("です");
      expect(wordsOfRemark(r)).toEqual([w("す", 1)]);
      expectWordsFitText(r);
    });

    it("切る位置の手前の句読点は残りに入らない: 句読点の語は落ち、残る語は句読点の後の本文に合う", () => {
      const r = secondRemark("今日は晴れ", "今日は晴れ、明日は雨", wordsOf("今日は", "晴れ", "、", "明日", "は", "雨"));

      expect(r.text).toBe("明日は雨");
      expect(wordsOfRemark(r)).toEqual([w("明日", 0), w("は", 2), w("雨", 3)]);
      expectWordsFitText(r);
    });

    it("補助平面の文字（UTF-16 で 2 コード単位）の後で切っても、位置は UTF-16 で合う", () => {
      const r = secondRemark("𠮷", "𠮷野家", wordsOf("𠮷", "野", "家"));

      expect(r.text).toBe("野家");
      expect(wordsOfRemark(r)).toEqual([w("野", 0), w("家", 1)]);
      expectWordsFitText(r);
    });

    it("補助平面の文字が切った後の本文にあるとき、後ろの語の位置もずれずに合う", () => {
      const r = secondRemark("あい", "あい𠮷野家", wordsOf("あい", "𠮷", "野", "家"));

      expect(r.text).toBe("𠮷野家");
      expect(wordsOfRemark(r)).toEqual([w("𠮷", 0), w("野", 2), w("家", 3)]);
      expectWordsFitText(r);
    });

    it("全部の語が切る位置より前なら、words は空の配列で出る（words のキーは残る）", () => {
      const r = secondRemark("あいう", "あいうえお", wordsOf("あいう"));

      expect(r.text).toBe("えお");
      expect(wordsOfRemark(r)).toEqual([]);
    });

    it("words の無い発言は、切っても words のキーを持たない", () => {
      const r = secondRemark("あいう", "あいうえお", undefined);

      expect(r.text).toBe("えお");
      expect(r).not.toHaveProperty("words");
    });

    it("切らない発言（重ならない）は words を変えない", () => {
      const s = createRemarkSettler();
      const firstWords = wordsOf("あい", "う");
      const secondWords = wordsOf("かき", "く");
      expect(wordsOfRemark(s.final(finalW("相手", 10, 12, "あいう", firstWords))[0])).toEqual(firstWords);

      const out = s.final(finalW("相手", 12, 14, "かきく", secondWords)); // 時刻が重ならない

      expect(wordsOfRemark(out[0])).toEqual(secondWords);
    });

    it("時刻は重なるが本文が重ならない発言（切る長さ 0）は、本文も words も変わらない", () => {
      const s = createRemarkSettler();
      s.final(finalW("相手", 10, 12, "あいう", wordsOf("あいう")));
      const secondWords = wordsOf("かき", "く");

      const out = s.final(finalW("相手", 11, 14, "かきく", secondWords));

      expect(brief(out)).toEqual([["相手", 12, 14, "かきく"]]);
      expect(wordsOfRemark(out[0])).toEqual(secondWords);
    });

    it("確定結果の頭を切るときも、words は同じ位置で切る", () => {
      const s = createRemarkSettler();
      s.final(finalW("相手", 10, 12, "あいう", wordsOf("あいう")));

      const out = s.final(finalW("相手", 11, 15, "あいうえお", wordsOf("あい", "う", "え", "お")));

      expect(brief(out)).toEqual([["相手", 12, 15, "えお"]]);
      expect(wordsOfRemark(out[0])).toEqual([w("え", 0), w("お", 1)]);
    });

    it("3 回続けて全文を送り直しても、各回の words は切る前の全文の words から作る（前回切った words を引き継がない）", () => {
      const s = createRemarkSettler();
      s.partial(partialW("相手", 10, 12, "あいう", wordsOf("あい", "う")));
      expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, "あいう"]]);
      s.partial(partialW("相手", 10, 15, "あいうえお", wordsOf("あい", "う", "え", "お")));
      expect(wordsOfRemark(tick(s, quiet(15))[0])).toEqual([w("え", 0), w("お", 1)]);

      s.partial(partialW("相手", 10, 18, "あいうえおかき", wordsOf("あい", "う", "え", "お", "かき")));
      const out = tick(s, quiet(18));

      expect(brief(out)).toEqual([["相手", 15, 18, "かき"]]);
      expect(wordsOfRemark(out[0])).toEqual([w("かき", 0)]);
      expectWordsFitText(out[0]);
    });
  });
});

// Issue #996: 相手の途中結果で、文の終わり（。？！ ? !）までの本文が S ミリ秒変わらなければ、そこまでを発言にする。
// 文の終わりの無い途中結果は、従来どおり T 更新されなければ出す。出した後に同じ発話の続きが届いたら、出した分の後ろだけを出す。
// Issue #1083: S も、結果の end（音声の時刻）で測る。
// 以下は、本文の長さ = 区間の長さ（start 10）になる end（秒）を基準に作り、文の終わりまでの発言の end が文の終わりの位置になるようにする。
// ミリ秒単位の間隔は、end を sec(音声の時刻のミリ秒) で書く
describe("文の終わりが落ち着いたら出す（Issue #996）", () => {
  const texts = (rs: SettledRemark[]) => rs.map((r) => r.text);
  // 同じ発話（相手・start 10）の途中結果。SpeechAnalyzer は区間の始まりから全文を送り直す。end は音声の時刻（ミリ秒）で渡す
  const pt = (text: string, endMs: number) => partial("相手", 10, sec(endMs), text);

  it("S は 50 ミリ秒", () => {
    expect(S).toBe(50);
  });

  describe("文の終わりまでが S 変わらなければ、そこまでを出す", () => {
    it("S に 1ms 足りなければ出ない。S 経つと文の終わりまでが 1 件で出て、区間は発話の頭から文の終わりまで", () => {
      const s = createRemarkSettler();
      s.partial(pt("あいう。え", 15000));

      expect(tick(s, 15000 + S - 1)).toEqual([]);
      expect(brief(tick(s, 15000 + S))).toEqual([["相手", 10, 14, "あいう。"]]);
    });

    it("出した後の残り（文の終わりの無い部分）は、従来どおり T 経つと、出した発言の end から始まる発言として出る。二度は出ない", () => {
      const s = createRemarkSettler();
      s.partial(pt("あいう。え", 15000));
      expect(texts(tick(s, 15000 + S))).toEqual(["あいう。"]);

      expect(tick(s, 15000 + T - 1)).toEqual([]);
      expect(brief(tick(s, 15000 + T))).toEqual([["相手", 14, 15, "え"]]);
      expect(tick(s, 15000 + T * 10)).toEqual([]);
      });

    it("文の終わりより後ろの本文が変わっても、文の終わりまでが変わっていなければ S で出る。残りの期限は最後の結果の end から T", () => {
      const s = createRemarkSettler();
      s.partial(pt("あいう。え", 15000));
      s.partial(pt("あいう。えお", 15030));

      expect(tick(s, 15000 + S - 1)).toEqual([]);
      expect(texts(tick(s, 15000 + S))).toEqual(["あいう。"]);
      const rest = tick(s, 15030 + T);
      expect(texts(rest)).toEqual(["えお"]);
      expect(rest[0]!.end).toBe(sec(15030));
    });

    it("S 経つ前に文の終わりが取り消されたら出さない。取り消されなければ同じ時刻で出る", () => {
      const kept = createRemarkSettler();
      kept.partial(pt("あいう。", 14000));
      kept.partial(pt("あいう。", 14030));
      expect(texts(tick(kept, 14000 + S))).toEqual(["あいう。"]);

      const cancelled = createRemarkSettler();
      cancelled.partial(pt("あいう。", 14000));
      cancelled.partial(pt("あいうえ", 14030));
      expect(tick(cancelled, 14000 + S)).toEqual([]);
      expect(tick(cancelled, 14030 + S)).toEqual([]);
      expect(brief(tick(cancelled, 14030 + T))).toEqual([["相手", 10, sec(14030), "あいうえ"]]);
    });

    it("取り消された文の終わりが別の位置で現れ直したら、現れ直した時刻から S を数える", () => {
      const s = createRemarkSettler();
      s.partial(pt("あいう。", 14000));
      s.partial(pt("あいうえ", 14030));
      s.partial(pt("あいうえ。", 14040));

      expect(tick(s, 14040 + S - 1)).toEqual([]);
      expect(texts(tick(s, 14040 + S))).toEqual(["あいうえ。"]);
    });

    it("文の終わりを残したまま、その手前の本文が修正されたら、S は修正した時刻から数え直す", () => {
      const s = createRemarkSettler();
      s.partial(pt("あいう。え", 15000));
      s.partial(pt("あいお。え", 15030));

      expect(tick(s, 15000 + S)).toEqual([]);
      expect(tick(s, 15030 + S - 1)).toEqual([]);
      expect(texts(tick(s, 15030 + S))).toEqual(["あいお。"]);
    });

    it("続きが延びて本文の長さに対する区間の割合が小さくなっても、次の文の終わりまでは S で出る", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 15, "あいう。え"));
      expect(brief(tick(s, 15000 + S))).toEqual([["相手", 10, 14, "あいう。"]]);
      s.partial(partial("相手", 10, 15.25, "あいう。え。おかきく"));

      const out = tick(s, 15250 + S);
      expect(texts(out)).toEqual(["え。"]);
      expect(out[0]!.start).toBe(14);
      expect(out[0]!.end).toBeGreaterThan(14);
    });

    it("文の終わりの文字は 。？！ と半角の ? !。読点・半角ピリオドでは出ない", () => {
      for (const mark of ["。", "？", "！", "?", "!"]) {
        const s = createRemarkSettler();
        s.partial(pt(`あいう${mark}え`, 15000));
        expect(texts(tick(s, 15000 + S))).toEqual([`あいう${mark}`]);
      }
      for (const mark of ["、", ".", "，"]) {
        const s = createRemarkSettler();
        s.partial(pt(`あいう${mark}え`, 15000));
        expect(tick(s, 15000 + T - 1)).toEqual([]);
      }
    });

    it("文の終わりが複数あり、どちらも落ち着いていれば、最後の文の終わりまでを 1 件で出す", () => {
      const s = createRemarkSettler();
      s.partial(pt("あ。い。う", 15000));

      expect(brief(tick(s, 15000 + S))).toEqual([["相手", 10, 14, "あ。い。"]]);
    });

    it("後の文の終わりがまだ落ち着いていなければ、落ち着いた文の終わりまでを出し、後の文は後の S で出る。2 件の区間は隙間も重なりもない", () => {
      const s = createRemarkSettler();
      s.partial(pt("あ。い", 13000));
      s.partial(pt("あ。い。", 13040));

      expect(rounded(tick(s, 13000 + S))).toEqual([["相手", 10, 11.52, "あ。"]]);
      expect(tick(s, 13040 + S - 1)).toEqual([]);
      expect(rounded(tick(s, 13040 + S))).toEqual([["相手", 11.52, 13.04, "い。"]]);
      expect(tick(s, 13040 + T * 10)).toEqual([]); // 出し終えた本文は T 経っても出ない
    });

    it("文の終わりの期限と T を一度の結果でまたいでも、期限の順に、文の終わりまでと残りが 1 件ずつ出る。重ならず、二度は出ない", () => {
      const s = createRemarkSettler();
      s.partial(pt("あいう。え", 15000));

      expect(brief(tick(s, 15000 + T))).toEqual([
        ["相手", 10, 14, "あいう。"],
        ["相手", 14, 15, "え"],
      ]); // 一つずつ時計を進めた（S のとき・T のとき）のと同じ列
      expect(tick(s, 15000 + T * 10)).toEqual([]);
    });

    it("文の終わりで切った発言の end は、発話の区間を文字の位置で比例配分した時刻", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 15, "あいう。え")); // 長さ 5 の本文に区間 5 秒

      expect(brief(tick(s, 15000 + S))).toEqual([["相手", 10, 14, "あいう。"]]);
    });
  });

  describe("出した後に同じ発話の続きが届いても、出した分を二度と出さない", () => {
    it("文の終わりで出した後の続きの途中結果が次の文の終わりまで落ち着いたら、次の文だけが出て、区間は前の発言の end から始まる", () => {
      const s = createRemarkSettler();
      s.partial(pt("あ。い", 13000));
      expect(rounded(tick(s, 13000 + S))).toEqual([["相手", 10, 12, "あ。"]]);

      s.partial(pt("あ。い。う", 13500));

      expect(rounded(tick(s, 13500 + S))).toEqual([["相手", 12, 12.8, "い。"]]);
    });

    it("1 秒の規則で出した後に全文を送り直し、文の終わりが落ち着いたら、新しい部分だけが出る", () => {
      const s = createRemarkSettler();
      s.partial(pt("あい", 12000));
      expect(brief(tick(s, 12000 + T))).toEqual([["相手", 10, 12, "あい"]]);

      s.partial(pt("あいう。え", 15000));

      expect(brief(tick(s, 15000 + S))).toEqual([["相手", 12, 14, "う。"]]);
    });

    it("文の終わりで 2 回に分けて出した後に全文が届いたら、残りだけが出る（直前の発言 1 件の記憶では前の文が再び出る）", () => {
      const s = createRemarkSettler();
      s.partial(pt("あ。", 12000));
      expect(texts(tick(s, 12000 + S))).toEqual(["あ。"]);
      s.partial(pt("あ。い。", 14000));
      expect(texts(tick(s, 14000 + S))).toEqual(["い。"]);

      s.partial(pt("あ。い。う", 16000));

      expect([...tick(s, 16000 + S), ...tick(s, 16000 + T)].map((r) => r.text)).toEqual(["う"]);
      expect(tick(s, 16000 + T * 10)).toEqual([]);
    });

    it("別の発話の発言が間に出た後でも、同じ発話の続きは出した分の後ろだけが出る", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 14, "あい。う"));
      expect(texts(tick(s, 14000 + S))).toEqual(["あい。"]);
      s.partial(partial("相手", 13.5, sec(14100), "べつ。"));
      expect(texts(tick(s, 14100 + S))).toEqual(["べつ。"]);

      s.partial(partial("相手", 10, 14.25, "あい。うえお。")); // 区間は、間に出た発言（〜14.1）の end より後ろまで延びる

      const out = [...tick(s, 14250 + S), ...tick(s, 14250 + T)].map((r) => r.text);
      expect(out.join("")).not.toContain("あい。"); // 出した文を含まない
      expect(out.join("")).toContain("うえお。");
    });

    it("先頭が書き換わった全文を送り直しても、書き換えずに延びた分だけが出る", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 17, "今日はシ子ど。"));
      expect(texts(tick(s, 17000 + S))).toEqual(["今日はシ子ど。"]);

      s.partial(partial("相手", 10, 19, "今日はシ子度です。"));

      expect(brief(tick(s, 19000 + S))).toEqual([["相手", 17, 19, "です。"]]);
    });
  });

  describe("出す直前の関所が捨てた候補は、出した分の記録を進めない", () => {
    it("1 秒の経路: 捨てられた途中結果の後の発言は、確定結果の end の後ろから全文が出る", () => {
      const s = createRemarkSettler();
      expect(texts(s.final(final("相手", 10, 15, "あいうえお")))).toEqual(["あいうえお"]);
      s.partial(partial("相手", 12, 14, "かきく")); // end は時計（15000）より古い。期限は時計から T
      expect(tick(s, 15000 + T)).toEqual([]);
      s.partial(partial("相手", 12, 18, "かきくけこ"));

      expect(brief(tick(s, quiet(18)))).toEqual([["相手", 15, 18, "かきくけこ"]]);
    });

    it("文の終わりの経路: 捨てられた途中結果の後の発言は、確定結果の end の後ろから全文が出る", () => {
      const s = createRemarkSettler();
      expect(texts(s.final(final("相手", 10, 15, "あいうえお")))).toEqual(["あいうえお"]);
      s.partial(partial("相手", 12, 14, "かきく。"));
      expect(tick(s, 15000 + S)).toEqual([]);
      s.partial(partial("相手", 12, 18, "かきく。けこ。"));

      expect(brief(tick(s, 18000 + S))).toEqual([["相手", 15, 18, "かきく。けこ。"]]);
    });

    it("トラック全体の関所が捨てた候補は、出した分の記録を進めない（未出力の続きを後で欠かない）", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 13, "はい。"));
      expect(texts(tick(s, 13000 + S))).toEqual(["はい。"]);
      s.partial(partial("相手", 30, 32, "別件。"));
      expect(texts(tick(s, 32000 + S))).toEqual(["別件。"]);
      s.partial(partial("相手", 10, 31, "はい。続き。"));
      expect(tick(s, 32100)).toEqual([]); // end 31 <= 32 で関所が捨てる
      s.partial(partial("相手", 10, 40, "はい。続き。末尾。"));

      const out = [...tick(s, 40000 + S), ...tick(s, 40000 + T), ...s.drain()].map((r) => r.text).join("");
      expect(out).toContain("続き。");
      expect(out).toContain("末尾。");
      expect(out).not.toContain("はい");
    });

    it("開始のずれた確定結果は、トラックで最後に出した全文と突き合わせ、出した分を再び出さない", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 15, "あいう。え"));
      expect(texts(tick(s, 15000 + S))).toEqual(["あいう。"]);
      expect(texts(s.final(final("相手", 9.5, 15.5, "あいう。え")))).toEqual(["え"]);

      const next = s.final(final("相手", 9.5, 17, "あいう。えお。か"));

      expect(texts(next)).toEqual(["お。か"]);
    });

    it("同じ発話で出した本文の頭に挿入が入った更新: 文の終わりの経路でも出した文は再び出ない", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 13, "はい。"));
      expect(texts(tick(s, 13000 + S))).toEqual(["はい。"]);
      s.partial(partial("相手", 10, 18, "あ、はい。続き。"));

      const out = [...tick(s, 18000 + S), ...tick(s, 18000 + T), ...s.drain()];
      expect(out.map((r) => r.text).join("")).not.toContain("はい");
      expect(out.map((r) => r.text).join("")).toContain("続き。");
    });

    it("同じ発話で出した本文の頭に挿入が入り、出した文の句読点も変わった更新: 出した文は再び出ない", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 13, "はい。"));
      expect(texts(tick(s, 13000 + S))).toEqual(["はい。"]);
      s.partial(partial("相手", 10, 18, "あ、はい、続き。"));

      const out = [...tick(s, 18000 + S), ...tick(s, 18000 + T), ...s.drain()];
      expect(out.map((r) => r.text).join("")).not.toContain("はい");
      expect(out.map((r) => r.text).join("")).toContain("続き。");
    });

    it("頭の挿入を句読点を無視して切るとき、words も同じ位置で切り、残る語の位置が切った後の本文に合う", () => {
      const s = createRemarkSettler();
      s.partial(partialW("相手", 10, 13, "はい。", wordsOf("はい", "。")));
      expect(texts(tick(s, 13000 + S))).toEqual(["はい。"]);
      s.partial(partialW("相手", 10, 18, "あ、はい、続き。", wordsOf("あ", "、", "はい", "、", "続き", "。")));

      const out = [...tick(s, 18000 + S), ...tick(s, 18000 + T), ...s.drain()];
      expect(out.map((r) => r.text)).toEqual(["続き。"]);
      expectWordsFitText(out[0]);
      expect(wordsOfRemark(out[0])!.map((x) => x.surface)).toEqual(["続き", "。"]);
    });

    it("出した文が頭で句読点だけ書き換わり後ろで繰り返されても、その間の本文を捨てない", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 13, "はい。"));
      expect(texts(tick(s, 13000 + S))).toEqual(["はい。"]);
      s.partial(partial("相手", 10, 20, "はい、そうです。はい。"));

      const out = [...tick(s, 20000 + S), ...tick(s, 20000 + T), ...s.drain()];
      expect(out.map((r) => r.text)).toEqual(["そうです。はい。"]);
    });

    it("同じ発話で出した本文の頭に挿入が入った更新: 1 秒の経路でも出した分は再び出ない", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 12, "はい"));
      expect(texts(tick(s, quiet(12)))).toEqual(["はい"]);
      s.partial(partial("相手", 10, 15, "あ、はい続き"));

      expect(brief(tick(s, quiet(15)))).toEqual([["相手", 12, 15, "続き"]]);
    });
  });

  describe("確定結果との関係", () => {
    it("文の終わりで一部を出した発話を確定結果が覆うとき、確定結果は出さず、まだ出ていない残りだけを出す。その後は何も出ない", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 15, "あいう。え"));
      expect(texts(tick(s, 15000 + S))).toEqual(["あいう。"]);

      const finals = s.final(final("相手", 9.5, 15.5, "あいう。えお。")); // 15500 は残りの期限（16000）の前

      expect(brief(finals)).toEqual([["相手", 14, 15, "え"]]);
      expect(tick(s, 30000)).toEqual([]);
      expect(s.drain()).toEqual([]);
      });

    it("一部を出した発話を確定結果が使い終えた後、同じ開始の確定結果が続いても、出した分は再び出ない", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 15, "あいう。え"));
      expect(texts(tick(s, 15000 + S))).toEqual(["あいう。"]);
      expect(texts(s.final(final("相手", 9.5, 15.5, "あいう。え")))).toEqual(["え"]);

      const next = s.final(final("相手", 10, 17, "あいう。えお。か"));

      expect(texts(next)).toEqual(["お。か"]);
    });

    it("文の終わりで出し切った発話を確定結果が覆うとき、確定結果の全文は出ない", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 14, "あいう。"));
      expect(texts(tick(s, 14000 + S))).toEqual(["あいう。"]);

      expect(s.final(final("相手", 9.5, 14.5, "あいう。"))).toEqual([]);
      expect(tick(s, 30000)).toEqual([]);
      expect(s.drain()).toEqual([]);
    });

    it("まだ何も出ていない発話を、S 経つ前の end の確定結果が覆うときは、確定結果をそのまま出す", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 15, "あいう。え"));

      expect(brief(s.final(final("相手", 9.5, sec(15049), "あいう。えお。")))).toEqual([["相手", 9.5, sec(15049), "あいう。えお。"]]);
      expect(tick(s, 30000)).toEqual([]);
      });

    it("文の終わりで一部を出した発話は、停止時（drain）に残りだけが出る", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 15, "あいう。え"));
      expect(texts(tick(s, 15000 + S))).toEqual(["あいう。"]);

      expect(brief(s.drain())).toEqual([["相手", 14, 15, "え"]]);
      expect(s.drain()).toEqual([]);
    });
  });

  describe("自分の途中結果からは発言を作らない", () => {
    it("相手の「あ。」は S で出るが、自分の「い。」は出ず、期限にも drain にも現れない", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 12, "あ。"));
      s.partial(partial("自分", 10, 12, "い。"));

      expect(brief(tick(s, 12000 + S))).toEqual([["相手", 10, 12, "あ。"]]);
      expect(tick(s, 30000)).toEqual([]);
      expect(s.drain()).toEqual([]);

      const mine = createRemarkSettler();
      mine.partial(partial("自分", 20, 22, "い。"));
      expect(tick(mine, 22000 + S)).toEqual([]);
      expect(mine.drain()).toEqual([]);
    });
  });

  describe("words（Issue #639）の契約を、文の終わりで出す発言にも当てはめる", () => {
    it("出す本文に収まる語だけが付き、位置と長さが本文に合う。後で T の規則で出す残りの words も合う", () => {
      const s = createRemarkSettler();
      s.partial(partialW("相手", 10, 15, "あいう。え", wordsOf("あい", "う。", "え")));

      const first = tick(s, 15000 + S);
      expect(texts(first)).toEqual(["あいう。"]);
      expect(wordsOfRemark(first[0])).toEqual(wordsOf("あい", "う。"));
      expectWordsFitText(first[0]);

      const rest = tick(s, 15000 + T);
      expect(texts(rest)).toEqual(["え"]);
      expect(wordsOfRemark(rest[0])).toEqual([w("え", 0)]);
      expectWordsFitText(rest[0]);
    });

    it("切る位置をまたぐ語は落ちる", () => {
      const s = createRemarkSettler();
      s.partial(partialW("相手", 10, 15, "あいう。え", wordsOf("あ", "い", "う。え")));

      const out = tick(s, 15000 + S);
      expect(texts(out)).toEqual(["あいう。"]);
      expect(wordsOfRemark(out[0])).toEqual(wordsOf("あ", "い"));
      expectWordsFitText(out[0]);
    });

    it("words の無い途中結果から作る発言には words のキーが無い", () => {
      const s = createRemarkSettler();
      s.partial(pt("あいう。え", 15000));

      expect(tick(s, 15000 + S)[0]).not.toHaveProperty("words");
    });
  });
});

// Issue #1019: 語ごとの区間（wordTimes）を発言まで運ぶ。words と同じ位置（UTF-16）で本文と一緒に切る。
// wordTimes を持たない入力からは、wordTimes のキーを持つ発言を作らない
type TestWordTime = { location: number; length: number; start: number; end: number };
// 1 文字ずつ 1 秒の区間（位置 i の文字は start = base + i、end = base + i + 1）
const timesOf = (text: string, base = 10): TestWordTime[] =>
  [...text].map((c, i) => ({ location: i, length: c.length, start: base + i, end: base + i + 1 }));
const partialT = (track: HelperPartial["track"], start: number, end: number, text: string, wordTimes?: TestWordTime[]): HelperPartial => ({
  ...partial(track, start, end, text),
  ...(wordTimes === undefined ? {} : { wordTimes }),
});
const finalT = (track: SettledRemark["track"], start: number, end: number, text: string, wordTimes?: TestWordTime[]) =>
  final(track, start, end, text, wordTimes === undefined ? {} : ({ wordTimes } as Partial<SettledRemark>));
const timesOfRemark = (r: SettledRemark | undefined) => (r as { wordTimes?: TestWordTime[] } | undefined)?.wordTimes;

describe("wordTimes の運搬（Issue #1019）", () => {
  describe("途中結果から作る発言に wordTimes が付く", () => {
    it("due: 最後の途中結果の wordTimes が付く。更新のたびに置き換わり、古い区間は残らない", () => {
      const s = createRemarkSettler();
      s.partial(partialT("相手", 10, 11, "あ", timesOf("あ")));
      s.partial(partialT("相手", 10, 11.5, "あいう", timesOf("あいう")));
      s.partial(partialT("相手", 10, 12.25, "あいうえお", timesOf("あいうえお")));

      const out = tick(s, quiet(12.25));
      expect(brief(out)).toEqual([["相手", 10, 12.25, "あいうえお"]]);
      expect(timesOfRemark(out[0])).toEqual(timesOf("あいうえお"));
    });

    it("wordTimes の無い途中結果で更新したら、先の wordTimes は残らない（text と同じ更新）", () => {
      const s = createRemarkSettler();
      s.partial(partialT("相手", 10, 11, "あ", timesOf("あ")));
      s.partial(partialT("相手", 10, 11.5, "あいう"));

      const out = tick(s, quiet(11.5));
      expect(brief(out)).toEqual([["相手", 10, 11.5, "あいう"]]);
      expect(out[0]).not.toHaveProperty("wordTimes");
    });

    it("wordTimes の無い途中結果だけから作る発言には wordTimes のキーが無い", () => {
      const s = createRemarkSettler();
      s.partial(partial("相手", 10, 11, "あ"));

      expect(tick(s, quiet(11))[0]).not.toHaveProperty("wordTimes");
    });

    it("final（途中結果の期限を越えた end の確定結果の分岐）: 出す未出の発話に、その途中結果の wordTimes が付く", () => {
      const s = createRemarkSettler();
      s.partial(partialT("相手", 10, 12, "あいう", timesOf("あいう")));
      // 確定結果の end が途中結果の期限（13000）に届いている: 確定結果は捨て、途中結果からの発言を出す
      const out = s.final(finalT("相手", 10, 13, "別の確定", timesOf("別の確定", 20)));

      expect(brief(out)).toEqual([["相手", 10, 12, "あいう"]]);
      expect(timesOfRemark(out[0])).toEqual(timesOf("あいう"));
    });

    it("drain: まだ出ていない発話に、最後の途中結果の wordTimes が付く", () => {
      const s = createRemarkSettler();
      s.partial(partialT("相手", 10, 11, "あ", timesOf("あ")));
      s.partial(partialT("相手", 10, 11.5, "あいう", timesOf("あいう")));

      const out = s.drain();
      expect(brief(out)).toEqual([["相手", 10, 11.5, "あいう"]]);
      expect(timesOfRemark(out[0])).toEqual(timesOf("あいう"));
    });
  });

  describe("確定結果の wordTimes", () => {
    it("途中結果が無いとき、確定結果の wordTimes はそのまま出る", () => {
      const s = createRemarkSettler();
      const out = s.final(finalT("相手", 10, 12, "こんにちは", timesOf("こんにちは")));

      expect(timesOfRemark(out[0])).toEqual(timesOf("こんにちは"));
    });

    it("wordTimes の無い確定結果には wordTimes のキーが付かない", () => {
      const s = createRemarkSettler();

      expect(s.final(finalT("相手", 10, 12, "こんにちは"))[0]).not.toHaveProperty("wordTimes");
    });

    it("自分の確定結果は関所を通らず、wordTimes もそのまま出る", () => {
      const s = createRemarkSettler();
      const out = s.final(finalT("自分", 0, 2, "はい", timesOf("はい", 0)));

      expect(timesOfRemark(out[0])).toEqual(timesOf("はい", 0));
    });
  });

  // 文の終わりで先に出す経路と、同じ発話の更新で頭に挿入が入る経路でも、本文・words と同じ位置で切る
  describe("文の終わりで切った発言・頭の挿入を切った発言の wordTimes", () => {
    const texts = (rs: SettledRemark[]) => rs.map((r) => r.text);

    it("文の終わりまでを出すとき、その本文に収まる区間だけが元の秒で付き、後で出す残りは切った後の位置になる", () => {
      const s = createRemarkSettler();
      s.partial(partialT("相手", 10, 15, "あいう。え", timesOf("あいう。え")));

      const first = tick(s, 15000 + S);
      expect(texts(first)).toEqual(["あいう。"]);
      expect(timesOfRemark(first[0])).toEqual(timesOf("あいう。"));

      const rest = tick(s, 15000 + T);
      expect(texts(rest)).toEqual(["え"]);
      expect(timesOfRemark(rest[0])).toEqual([{ location: 0, length: 1, start: 14, end: 15 }]);
    });

    it("文の終わりを切る位置をまたぐ区間は落ちる", () => {
      const s = createRemarkSettler();
      const times: TestWordTime[] = [
        { location: 0, length: 2, start: 10, end: 11 },
        { location: 2, length: 3, start: 11, end: 13 },
      ];
      s.partial(partialT("相手", 10, 15, "あいう。え", times));

      const out = tick(s, 15000 + S);
      expect(texts(out)).toEqual(["あいう。"]);
      expect(timesOfRemark(out[0])).toEqual([times[0]]);
    });

    it("頭の挿入を切るとき、wordTimes も words と同じ位置で切り、残る区間の位置が切った後の本文に合い、秒は元のまま", () => {
      const s = createRemarkSettler();
      s.partial(partialT("相手", 10, 13, "はい。", timesOf("はい。")));
      expect(texts(tick(s, 13000 + S))).toEqual(["はい。"]);
      const text = "あ、はい、続き。";
      s.partial(partialT("相手", 10, 18, text, timesOf(text)));

      const out = [...tick(s, 18000 + S), ...tick(s, 18000 + T), ...s.drain()];
      expect(out.map((r) => r.text)).toEqual(["続き。"]);
      expect(timesOfRemark(out[0])).toEqual([
        { location: 0, length: 1, start: 15, end: 16 },
        { location: 1, length: 1, start: 16, end: 17 },
        { location: 2, length: 1, start: 17, end: 18 },
      ]);
    });
  });

  // 関所が頭を切るとき、本文・words・wordTimes は同じ位置で切る。完全に残る区間だけを残して位置をずらす（秒はそのまま）。
  describe("関所が頭を切った発言の wordTimes", () => {
    const secondRemark = (first: string, second: string, secondTimes: TestWordTime[] | undefined, secondWords?: TestWord[]) => {
      const s = createRemarkSettler();
      s.partial(partialT("相手", 10, 12, first, timesOf(first)));
      expect(brief(tick(s, quiet(12)))).toEqual([["相手", 10, 12, first]]);
      s.partial({ ...partialT("相手", 10, 15, second, secondTimes), ...(secondWords === undefined ? {} : { words: secondWords }) });
      const out = tick(s, quiet(15));
      expect(out).toHaveLength(1);
      return out[0]!;
    };

    it("完全一致の重なりで切る: 切った後に残る区間だけが、切った後の本文の位置・元の秒で残る", () => {
      const r = secondRemark("あいう", "あいうえお", timesOf("あいうえお"));

      expect(r.text).toBe("えお");
      expect(timesOfRemark(r)).toEqual([
        { location: 0, length: 1, start: 13, end: 14 },
        { location: 1, length: 1, start: 14, end: 15 },
      ]);
    });

    it("切る位置をまたぐ区間は落ちる（words と同じ規則）", () => {
      // 切る位置は 3。"うえ"（位置 2〜4）は途中で切れるので落ち、"お"（位置 4）は位置 1 になる
      const times: TestWordTime[] = [
        { location: 0, length: 2, start: 10, end: 11 },
        { location: 2, length: 2, start: 11, end: 12 },
        { location: 4, length: 1, start: 12, end: 13 },
      ];
      const r = secondRemark("あいう", "あいうえお", times);

      expect(r.text).toBe("えお");
      expect(timesOfRemark(r)).toEqual([{ location: 1, length: 1, start: 12, end: 13 }]);
    });

    it("words と wordTimes を一緒に持つとき、どちらも同じ切り位置で切る", () => {
      const words: TestWord[] = [w("あいう", 0), w("え", 3), w("お", 4)];
      const r = secondRemark("あいう", "あいうえお", timesOf("あいうえお"), words);

      expect(r.text).toBe("えお");
      expect(wordsOfRemark(r)).toEqual([w("え", 0), w("お", 1)]);
      expect(timesOfRemark(r)?.map((t) => t.location)).toEqual([0, 1]);
    });

    it("wordTimes の無い発言を切っても、wordTimes のキーは付かない", () => {
      const r = secondRemark("あいう", "あいうえお", undefined);

      expect(r.text).toBe("えお");
      expect(r).not.toHaveProperty("wordTimes");
    });
  });
});

// Issue #1222: 字幕へ渡す途中結果（unemittedTail）は、発言を出すときと同じ規則（出した分の記録・トラック全体の関所）で、もう発言になった分を除く。状態は変えない
describe("unemittedTail（字幕へ渡す、まだ発言になっていない分）", () => {
  it("同じ発話で出した分の後ろだけを返し、呼んでも発言の記録は進まない（同じ途中結果が後で発言になるときは、同じ後ろが出る）", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 0, 1.2, "来週のリリースは"));
    expect(tick(s, quiet(1.2)).map((r) => r.text)).toEqual(["来週のリリースは"]);
    const extended = partial("相手", 0, 2.5, "来週のリリースは金曜に");
    s.partial(extended);

    expect(s.unemittedTail(extended).text).toBe("金曜に");
    expect(s.unemittedTail(extended).text).toBe("金曜に");
    expect(tick(s, quiet(2.5)).map((r) => r.text)).toEqual(["金曜に"]);
  });

  it("同じ発話の記録の後に同じトラックの別の発話を出していれば、トラック全体の関所でも突き合わせる（関所が捨てる分は字幕にも出さない）", () => {
    const s = createRemarkSettler();
    s.partial(partial("相手", 0, 1.2, "来週のリリースは"));
    tick(s, quiet(1.2));
    s.partial(partial("相手", 2.5, 3, "金曜にします"));
    expect(tick(s, quiet(3)).map((r) => r.text)).toEqual(["金曜にします"]);
    const late = partial("相手", 0, 4.5, "来週のリリースは金曜にします");
    s.partial(late);

    expect(s.unemittedTail(late).text).toBe("");
    expect(tick(s, quiet(4.5))).toEqual([]);
  });

  it("自分の途中結果は発言にならないので、そのまま返す", () => {
    const s = createRemarkSettler();
    const mine = partial("自分", 0, 1, "はい");
    expect(s.unemittedTail(mine)).toBe(mine);
  });
});
