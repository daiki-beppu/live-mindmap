import { describe, expect, it } from "vitest";
import { createSpeakerAttribution, SPEAKER_WAIT_MS, splitBySpeaker, type SettledRemark, type SpeakerLogEvent, type WordTime } from "../src/core/index.ts";

// Issue #1021: 相手の発言の話者を決める規則（ADR 0013、GLOSSARY「発言」「話者」）。
// 規則は時刻を引数に取る純粋な関数（splitBySpeaker）と、時刻を引数に取りタイマーを持たない状態つきの段（createSpeakerAttribution）。
// 実行環境の時計・TestClock は使わない。時刻は引数で渡す。

type Segment = { start: number; end: number; slot: number };
const seg = (slot: number, start: number, end: number): Segment => ({ slot, start, end });

// 語（本文の断片と、その区間）から、本文と wordTimes を組み立てる
type Part = readonly [text: string, start: number, end: number];
const remarkOf = (parts: readonly Part[], range?: { start: number; end: number }): SettledRemark => {
  let location = 0;
  const wordTimes: WordTime[] = parts.map(([text, start, end]) => {
    const word = { location, length: text.length, start, end };
    location += text.length;
    return word;
  });
  return {
    track: "相手",
    start: range?.start ?? parts[0]![1],
    end: range?.end ?? parts.at(-1)![2],
    text: parts.map(([text]) => text).join(""),
    wordTimes,
  };
};

const summary = (cut: ReturnType<typeof splitBySpeaker>) => cut.map(({ remark, slot }) => [slot, remark.text, remark.start, remark.end]);

describe("splitBySpeaker: 1 発言 1 話者", () => {
  it("話者が替わった所で切る。本文は語の区間の境目で分かれ、時刻は発言の start から始まり end で終わって、重ならない", () => {
    const remark = remarkOf([["こんにちは、", 10, 12], ["ありがとう", 12, 14]]);

    const cut = splitBySpeaker(remark, [seg(3, 10, 12), seg(1, 12, 14)]);

    expect(summary(cut)).toEqual([[3, "こんにちは、", 10, 12], [1, "ありがとう", 12, 14]]);
    for (const [i, part] of cut.entries()) {
      expect(part.remark.end).toBeGreaterThan(part.remark.start);
      if (i > 0) expect(part.remark.start).toBeGreaterThanOrEqual(cut[i - 1]!.remark.end);
    }
  });

  it("切った後の語の区間は、切った後の本文の位置に合わせて数え直される", () => {
    const remark = remarkOf([["こんにちは、", 10, 12], ["ありがとう", 12, 14]]);

    const cut = splitBySpeaker(remark, [seg(3, 10, 12), seg(1, 12, 14)]);

    expect(cut[0]!.remark.wordTimes).toEqual([{ location: 0, length: 6, start: 10, end: 12 }]);
    expect(cut[1]!.remark.wordTimes).toEqual([{ location: 0, length: 5, start: 12, end: 14 }]);
  });

  it("words も切った後の本文の位置に合わせて、各本文に属する語だけが残る（位置は数え直される）", () => {
    const remark: SettledRemark = {
      ...remarkOf([["こんにちは、", 10, 12], ["ありがとう", 12, 14]]),
      words: [
        { surface: "こんにちは", romaji: "konnichiha", location: 0, length: 5 },
        { surface: "ありがとう", romaji: "arigatou", location: 6, length: 5 },
      ],
    };

    const cut = splitBySpeaker(remark, [seg(3, 10, 12), seg(1, 12, 14)]);

    expect(cut[0]!.remark.words).toEqual([{ surface: "こんにちは", romaji: "konnichiha", location: 0, length: 5 }]);
    expect(cut[1]!.remark.words).toEqual([{ surface: "ありがとう", romaji: "arigatou", location: 0, length: 5 }]);
  });

  it("発言の start が最初の語より前、end が最後の語より後でも、先頭は発言の start、末尾は発言の end になる", () => {
    const remark = remarkOf([["あ", 10.5, 12], ["い", 12, 14]], { start: 10, end: 14.5 });

    const cut = splitBySpeaker(remark, [seg(0, 10, 12), seg(1, 12, 14.5)]);

    expect(cut.map((c) => [c.slot, c.remark.start, c.remark.end])).toEqual([[0, 10, 12], [1, 12, 14.5]]);
  });

  it("3 人が順に話せば 3 つに切る。同じ話者が離れて 2 度話せば（間に別の話者がいれば）別の発言になる", () => {
    const remark = remarkOf([["あああ", 0, 2], ["いいい", 2, 4], ["ううう", 4, 6]]);

    expect(summary(splitBySpeaker(remark, [seg(0, 0, 2), seg(1, 2, 4), seg(2, 4, 6)])).map((r) => r.slice(0, 2)))
      .toEqual([[0, "あああ"], [1, "いいい"], [2, "ううう"]]);
    expect(summary(splitBySpeaker(remark, [seg(0, 0, 2), seg(1, 2, 4), seg(0, 4, 6)])).map((r) => r.slice(0, 2)))
      .toEqual([[0, "あああ"], [1, "いいい"], [0, "ううう"]]);
  });

  it("同じ話者が続けば切らない（話者の区間が途中で分かれていても 1 発言）", () => {
    const remark = remarkOf([["あああ", 0, 2], ["いいい", 2, 4]]);

    const cut = splitBySpeaker(remark, [seg(4, 0, 1), seg(4, 1, 4)]);

    expect(summary(cut)).toEqual([[4, "あああいいい", 0, 4]]);
  });
});

describe("splitBySpeaker: 語に 2 人分の確定区間が重なるとき", () => {
  it("最も長く重なる話者にする（語の区間 [0,4] に slot 0 が 1 秒、slot 1 が 3 秒）", () => {
    const remark = remarkOf([["ながい語", 0, 4]]);

    expect(summary(splitBySpeaker(remark, [seg(0, 0, 1), seg(1, 1, 4)]))).toEqual([[1, "ながい語", 0, 4]]);
    // 順序や番号の大小によらず、重なりの長さで決める
    expect(summary(splitBySpeaker(remark, [seg(1, 3, 4), seg(0, 0, 3)]))).toEqual([[0, "ながい語", 0, 4]]);
  });

  it("同じ話者の区間が複数に分かれて重なるときは、重なりを合計して比べる（slot 2 は合計 3.5 秒、slot 5 は 2.5 秒。個々の区間では slot 5 の 2.5 秒が最長）", () => {
    const remark = remarkOf([["ながい語", 0, 6]]);

    const cut = splitBySpeaker(remark, [seg(2, 0, 1.5), seg(5, 1.5, 4), seg(2, 4, 5.5), seg(2, 5.5, 6)]);

    expect(cut.map((c) => c.slot)).toEqual([2]);
  });

  it("語の区間の外にある確定区間は重なりに数えない", () => {
    const remark = remarkOf([["あ", 10, 12]]);

    expect(splitBySpeaker(remark, [seg(0, 0, 10), seg(1, 12, 30), seg(2, 11.5, 12)]).map((c) => c.slot)).toEqual([2]);
  });

  it("語の単位で決めるので、同じ発言の中の語ごとに最も長く重なる話者へ切る", () => {
    const remark = remarkOf([["はい、", 0, 1.5], ["ありがとう", 1.5, 6]]);

    const cut = splitBySpeaker(remark, [seg(0, 0, 1), seg(1, 1, 6)]);

    expect(summary(cut)).toEqual([[0, "はい、", 0, 1.5], [1, "ありがとう", 1.5, 6]]);
  });
});

describe("splitBySpeaker: 0.5 秒未満の話者の区間は前後に寄せる", () => {
  const around = (backchannelEnd: number) =>
    remarkOf([["ええと、そうですね、", 0, 2], ["はい、", 2, backchannelEnd], ["それで進めます", backchannelEnd, backchannelEnd + 2]]);

  it("0.5 秒未満の相づちは細切れにせず、前後の話者の 1 発言にまとめる", () => {
    const remark = around(2.25);

    const cut = splitBySpeaker(remark, [seg(0, 0, 2), seg(1, 2, 2.25), seg(0, 2.25, 4.25)]);

    expect(summary(cut)).toEqual([[0, "ええと、そうですね、はい、それで進めます", 0, 4.25]]);
  });

  it("寄せ先は長い方の隣。前が短く後ろが長ければ後ろへ寄せる", () => {
    const remark = remarkOf([["ええ、", 0, 0.75], ["はい、", 0.75, 1], ["それで進めます", 1, 4]]);

    const cut = splitBySpeaker(remark, [seg(0, 0, 0.75), seg(1, 0.75, 1), seg(2, 1, 4)]);

    expect(summary(cut)).toEqual([[0, "ええ、", 0, 0.75], [2, "はい、それで進めます", 0.75, 4]]);
  });

  it("ちょうど 0.5 秒の区間は短くない。そのまま別の発言として残る", () => {
    const remark = around(2.5);

    const cut = splitBySpeaker(remark, [seg(0, 0, 2), seg(1, 2, 2.5), seg(0, 2.5, 4.5)]);

    expect(summary(cut).map((r) => r.slice(0, 2))).toEqual([[0, "ええと、そうですね、"], [1, "はい、"], [0, "それで進めます"]]);
  });

  it("短い相づちだけの発言でも話者を失わない（寄せる相手がいなければそのまま）", () => {
    const remark = remarkOf([["はい", 5, 5.25]]);

    expect(splitBySpeaker(remark, [seg(3, 5, 5.25)]).map((c) => c.slot)).toEqual([3]);
  });
});

describe("splitBySpeaker: 0.5 秒未満の判定は話者の区間の長さで行う（語の境界とずれていても）", () => {
  it("語の境界とずれた 0.4 秒の相づちは寄せられ、発言は 1 件のまま", () => {
    const remark = remarkOf([["そうですね、", 0, 1], ["はい", 1, 1.6], ["進めます", 1.6, 3]]);

    const cut = splitBySpeaker(remark, [seg(0, 0, 1), seg(1, 1, 1.4), seg(0, 1.4, 3)]);

    expect(summary(cut)).toEqual([[0, "そうですね、はい進めます", 0, 3]]);
  });

  it("長い語に短い区間だけが重なっていても、その区間は寄せられる", () => {
    const remark = remarkOf([["ああ", 0, 1], ["ええと", 1, 2], ["いい", 2, 3]]);

    const cut = splitBySpeaker(remark, [seg(0, 0, 1), seg(1, 1.3, 1.7), seg(0, 2, 3)]);

    expect(summary(cut)).toEqual([[0, "ああええといい", 0, 3]]);
  });

  it("短い区間を寄せても、同じ話者の区間の間の空きを重なりに数えない", () => {
    const remark = remarkOf([["あ", 1.6, 2.4], ["い", 4, 4.1]]);

    const cut = splitBySpeaker(remark, [seg(1, 0, 4), seg(0, 0.5, 1.5), seg(0, 2.5, 3.5), seg(2, 4, 4.2)]);

    expect(cut[0]!.slot).toBe(1);
  });

  it("発言の中に寄せる隣が無い短い区間は残る", () => {
    const remark = remarkOf([["はい", 5, 5.25]]);

    expect(splitBySpeaker(remark, [seg(0, 0, 5), seg(3, 5, 5.25), seg(0, 5.25, 9)]).map((c) => c.slot)).toEqual([3]);
  });

  it("ちょうど 0.5 秒の区間は、語の境界とずれていても寄せない", () => {
    const remark = remarkOf([["そうですね、", 0, 1.2], ["はい", 1.2, 1.6], ["進めます", 1.6, 3]]);

    const cut = splitBySpeaker(remark, [seg(0, 0, 1), seg(1, 1, 1.5), seg(0, 1.5, 3)]);

    expect(summary(cut).map((r) => r.slice(0, 2))).toEqual([[0, "そうですね、"], [1, "はい"], [0, "進めます"]]);
  });

  it("長い区間は、発言の中での重なりが短くても寄せずに替わり目で切る", () => {
    const remark = remarkOf([["進めます", 0, 2.8], ["で", 2.8, 3]]);

    const cut = splitBySpeaker(remark, [seg(0, 0, 2.8), seg(1, 2.8, 6)]);

    expect(summary(cut)).toEqual([[0, "進めます", 0, 2.8], [1, "で", 2.8, 3]]);
  });
});

describe("splitBySpeaker: 誰とも判定されない語は前後に寄せる", () => {
  it("同じ話者に挟まれた語は、その話者の発言に入る（切らない）", () => {
    const remark = remarkOf([["あああ", 0, 2], ["……", 2, 3], ["いいい", 3, 5]]);

    const cut = splitBySpeaker(remark, [seg(0, 0, 2), seg(0, 3, 5)]);

    expect(summary(cut)).toEqual([[0, "あああ……いいい", 0, 5]]);
  });

  it("先頭の語に話者がいなければ、直後の話者になる", () => {
    const remark = remarkOf([["……", 0, 1], ["いいい", 1, 3]]);

    expect(summary(splitBySpeaker(remark, [seg(6, 1, 3)]))).toEqual([[6, "……いいい", 0, 3]]);
  });

  it("末尾の語に話者がいなければ、直前の話者になる", () => {
    const remark = remarkOf([["あああ", 0, 2], ["……", 2, 3]]);

    expect(summary(splitBySpeaker(remark, [seg(6, 0, 2)]))).toEqual([[6, "あああ……", 0, 3]]);
  });

  it("話者の異なる 2 人の間にいる語は、直前の話者の発言に入り、話者なしの発言は作らない", () => {
    const remark = remarkOf([["あああ", 0, 2], ["……", 2, 3], ["いいい", 3, 5]]);

    const cut = splitBySpeaker(remark, [seg(0, 0, 2), seg(1, 3, 5)]);

    expect(summary(cut)).toEqual([[0, "あああ……", 0, 3], [1, "いいい", 3, 5]]);
  });
});

describe("splitBySpeaker: 発言全体で誰もいなければ話者なし", () => {
  it("確定区間が 1 つも無ければ、切らずに話者なしの 1 発言（本文・時刻・語の区間はそのまま）", () => {
    const remark = remarkOf([["あああ", 0, 2], ["いいい", 2, 4]]);

    const cut = splitBySpeaker(remark, []);

    expect(cut).toEqual([{ remark, slot: undefined }]);
  });

  it("確定区間があっても、どの語の区間とも重ならなければ話者なし", () => {
    const remark = remarkOf([["あああ", 10, 12]]);

    expect(splitBySpeaker(remark, [seg(0, 0, 10), seg(1, 12, 20)]).map((c) => c.slot)).toEqual([undefined]);
  });
});

describe("splitBySpeaker: 語の区間（wordTimes）が無い発言", () => {
  it("発言全体 [start, end] を 1 つの単位として最も長く重なる話者にし、切らない", () => {
    const remark: SettledRemark = { track: "相手", start: 0, end: 4, text: "語の区間がない発言" };

    const cut = splitBySpeaker(remark, [seg(0, 0, 1), seg(1, 1, 4)]);

    expect(cut).toEqual([{ remark, slot: 1 }]);
  });

  it("wordTimes が空でも同じ（切らない）。誰も重ならなければ話者なし", () => {
    const remark: SettledRemark = { track: "相手", start: 0, end: 4, text: "空", wordTimes: [] };

    expect(splitBySpeaker(remark, [seg(0, 0, 1), seg(1, 1, 4)]).map((c) => c.slot)).toEqual([1]);
    expect(splitBySpeaker(remark, [seg(0, 5, 6)])).toEqual([{ remark, slot: undefined }]);
  });
});

// ─── 状態を持つ段 ───

const speakerEvent = (slot: number, start: number, end: number, final = true, track: "相手" | "自分" = "相手"): SpeakerLogEvent => ({ type: "speaker", track, start, end, slot, final });
const settledEvent = (to: number, track: "相手" | "自分" = "相手"): SpeakerLogEvent => ({ type: "speaker-settled", track, to });
const speakerOff: SpeakerLogEvent = { type: "speaker-off", start: 0, reason: "モデルなし" };
const heard = (text: string, start: number, end: number): SettledRemark => remarkOf([[text, start, end]]);
const pairs = (out: readonly SettledRemark[]) => out.map((r) => [r.speaker, r.text]);

describe("createSpeakerAttribution: 確定を待ってから出す", () => {
  it("相手の発言は、その終わりまでの確定済みの位置（speaker-settled）が届くまで出ない。届いた時点で出る", () => {
    const attribution = createSpeakerAttribution();

    expect(attribution.remarks([heard("あ", 10, 12)], 12_000)).toEqual([]);
    expect(attribution.speaker(speakerEvent(2, 10, 11.5))).toEqual([]);
    expect(attribution.speaker(settledEvent(11.5))).toEqual([]); // end の手前までしか揃っていない
    expect(attribution.speaker(speakerEvent(2, 11.5, 12))).toEqual([]); // 区間が end に届いても、位置が届くまでは出さない
    expect(pairs(attribution.speaker(settledEvent(12)))).toEqual([["相手 A", "あ"]]);
  });

  // SCN-CT-WAIT-FINAL-P1: 同じ更新の中で枠の番号順に届いても、両方の話者で切る
  it("同じ更新で枠の番号順に届く（枠 0 の [12,14] が枠 1 の [10,12] より先）。位置が届くまで出ず、届くと両方の話者で切る", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([remarkOf([["そうですね", 10, 12], ["私は反対です", 12, 14]])], 14_000);

    expect(attribution.speaker(speakerEvent(0, 12, 14))).toEqual([]);
    expect(attribution.speaker(speakerEvent(1, 10, 12))).toEqual([]);
    expect(pairs(attribution.speaker(settledEvent(14)))).toEqual([["相手 A", "そうですね"], ["相手 B", "私は反対です"]]);
  });

  // SCN-CT-WAIT-FINAL-N1: 区間の end が発言の end に届いても、位置が届くまでは出さない
  it("確定区間の end が発言の end に届いても、位置が届かなければ出さない（3 秒後は話者なし）", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あ", 10, 14)], 14_000);

    expect(attribution.speaker(speakerEvent(0, 12, 14))).toEqual([]);
    expect(pairs(attribution.remarks([], 14_000 + SPEAKER_WAIT_MS))).toEqual([[undefined, "あ"]]);
  });

  // SCN-CT-WAIT-FINAL-P2: 黙っている間に位置が進めば、時間切れを待たずに話者付きで出る
  it("相手が黙って区間の end が発言の end に届かなくても、位置が進めば時間切れを待たずに話者付きで出る", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あ", 10, 14)], 14_000);
    attribution.speaker(speakerEvent(1, 10, 13.8));

    expect(pairs(attribution.speaker(settledEvent(15)))).toEqual([["相手 A", "あ"]]);
  });

  // SCN-CT-WAIT-FINAL-N2: 閉じていない区間がある間は、位置が進まない
  it("位置が発言の end に届かない間は、別の話者の短い区間が end を越えても出さない。位置が届くと 1 人の発言として出る", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あ", 10, 14)], 14_000);
    attribution.speaker(speakerEvent(0, 13.5, 14.2));

    expect(attribution.speaker(settledEvent(10))).toEqual([]);
    attribution.speaker(speakerEvent(1, 10, 16));
    expect(pairs(attribution.speaker(settledEvent(17)))).toEqual([["相手 A", "あ"]]); // 枠 0 の短い区間（0.5 秒）より、枠 1 の全体が長く重なる
  });

  it("位置は戻らない。前より小さい位置が届いても、揃った扱いは取り消されない", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(2, 0, 20));
    attribution.speaker(settledEvent(20));
    attribution.speaker(settledEvent(5));

    expect(pairs(attribution.remarks([heard("あ", 10, 12)], 12_000))).toEqual([["相手 A", "あ"]]);
  });

  it("自分のトラックの位置は使わない", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あ", 10, 12)], 12_000);

    expect(attribution.speaker(settledEvent(20, "自分"))).toEqual([]);
  });

  it("仮の区間（final: false）は、揃ったことにも話者にも使わない", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あ", 10, 12)], 12_000);

    expect(attribution.speaker(speakerEvent(2, 10, 12, false))).toEqual([]);
    // 仮の区間だけでは 3 秒待っても話者なし
    expect(pairs(attribution.remarks([], 12_000 + SPEAKER_WAIT_MS))).toEqual([[undefined, "あ"]]);
  });

  it("仮の区間（final: false）は、位置が発言の end まで進んでも話者にしない（確定区間が無ければ話者なし）", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あ", 10, 12)], 12_000);
    attribution.speaker(speakerEvent(2, 10, 12, false));

    expect(pairs(attribution.speaker(settledEvent(12)))).toEqual([[undefined, "あ"]]);
  });

  it("相手の発言を待っている間に届いた自分のトラックの区間は、相手の発言には使わない", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あ", 10, 12)], 12_000);

    expect(attribution.speaker(speakerEvent(2, 10, 12, true, "自分"))).toEqual([]);
  });

  it("確定区間が既に揃っていれば、待たずに出る", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(2, 0, 20));
    attribution.speaker(settledEvent(20));

    expect(pairs(attribution.remarks([heard("あ", 10, 12)], 12_000))).toEqual([["相手 A", "あ"]]);
  });

  it("揃わないまま 3 秒（保留に入れた時点の音声の時計から）経つと、話者なしで出る。3 秒の直前では出ない", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あ", 10, 12)], 12_000);

    expect(attribution.remarks([], 12_000 + SPEAKER_WAIT_MS - 1)).toEqual([]);
    expect(pairs(attribution.remarks([], 12_000 + SPEAKER_WAIT_MS))).toEqual([[undefined, "あ"]]);
    expect(SPEAKER_WAIT_MS).toBe(3000);
  });

  it("3 秒の待ちは、発言の end ではなく保留に入れた時点から数える（遅れて届いた発言がすぐ時間切れにならない）", () => {
    const attribution = createSpeakerAttribution();

    expect(attribution.remarks([heard("あ", 10, 12)], 20_000)).toEqual([]); // 発言の end の 12 秒から 8 秒遅れて届く
    expect(attribution.remarks([], 22_999)).toEqual([]);
    expect(pairs(attribution.remarks([], 23_000))).toEqual([[undefined, "あ"]]);
  });

  it("複数の保留は、区間が揃った分から届いた順に出る（ひとつめが揃った時点では、end の遅いふたつめは出ない）", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("ひとつめ", 10, 12), heard("ふたつめ", 12.5, 14)], 14_000);

    attribution.speaker(speakerEvent(1, 10, 12));
    attribution.speaker(speakerEvent(1, 12, 14));
    expect(pairs(attribution.speaker(settledEvent(12)))).toEqual([["相手 A", "ひとつめ"]]);
    expect(pairs(attribution.speaker(settledEvent(14)))).toEqual([["相手 A", "ふたつめ"]]);
  });

  it("出した発言は書き換えない。出した後に別の話者の確定区間が届いても、先に出した値のまま", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(2, 10, 12));
    attribution.speaker(settledEvent(12));
    const [first] = attribution.remarks([heard("あ", 10, 12)], 12_000);
    const snapshot = structuredClone(first);

    attribution.speaker(speakerEvent(7, 10, 12));
    attribution.speaker(settledEvent(30));
    attribution.remarks([], 20_000);

    expect(first).toEqual(snapshot);
    expect(first!.speaker).toBe("相手 A");
  });

  it("drain: 揃っている保留には規則を当て、揃っていない保留は話者なしで出す。状態は捨てず、以後も同じラベルを使う", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(2, 0, 13));
    attribution.speaker(settledEvent(13));
    attribution.remarks([heard("そろっている", 10, 12), heard("そろっていない", 14, 16)], 16_000);
    // 「そろっている」は区間が揃っているので上の呼び出しで既に出ている。残るのは「そろっていない」
    expect(pairs(attribution.drain())).toEqual([[undefined, "そろっていない"]]);
    expect(attribution.drain()).toEqual([]);

    attribution.speaker(speakerEvent(2, 20, 30));
    attribution.speaker(settledEvent(30));
    expect(pairs(attribution.remarks([heard("つぎ", 21, 22)], 22_000))).toEqual([["相手 A", "つぎ"]]);
  });

  it("drain: 区間が揃っている保留は、規則どおりに切ってラベルを付けて出す（揃っていなければ話者なし）", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([remarkOf([["あ", 10, 12], ["い", 12, 14]])], 14_000);
    attribution.speaker(speakerEvent(5, 10, 12));
    attribution.speaker(speakerEvent(5, 12, 13.5));
    attribution.speaker(settledEvent(13.5)); // end の 14 に届かない

    expect(pairs(attribution.drain())).toEqual([[undefined, "あい"]]);
  });
});

describe("createSpeakerAttribution: speaker-off", () => {
  it("speaker-off の後の相手の発言は、待たずに話者なしで出る", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerOff);

    expect(pairs(attribution.remarks([heard("あ", 10, 12)], 12_000))).toEqual([[undefined, "あ"]]);
  });

  it("speaker-off の時点で保留中の発言は、すぐ話者なしで出る", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あ", 10, 12)], 12_000);

    expect(pairs(attribution.speaker(speakerOff))).toEqual([[undefined, "あ"]]);
  });

  it("speaker-off の後に確定区間が届いても使わない（それ以降は話者なし）", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerOff);
    attribution.speaker(speakerEvent(2, 0, 30));
    attribution.speaker(settledEvent(30));

    expect(pairs(attribution.remarks([heard("あ", 10, 12)], 12_000))).toEqual([[undefined, "あ"]]);
  });

  it("speaker-off の後も自分は「自分」のまま", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerOff);

    expect(pairs(attribution.remarks([{ track: "自分", start: 1, end: 2, text: "うん" }], 2000))).toEqual([["自分", "うん"]]);
  });
});

describe("createSpeakerAttribution: ラベル（相手 A / B / C…）", () => {
  const speakInOrder = (attribution: ReturnType<typeof createSpeakerAttribution>, slot: number, at: number) => {
    attribution.speaker(speakerEvent(slot, at, at + 1));
    attribution.speaker(settledEvent(at + 1));
    return attribution.remarks([heard(`slot${slot}`, at, at + 1)], (at + 1) * 1000).map((r) => r.speaker);
  };

  it("セッションで初めて話した順に 相手 A / B / C を振る。枠の番号の大小とは関係しない", () => {
    const attribution = createSpeakerAttribution();

    expect(speakInOrder(attribution, 2, 0)).toEqual(["相手 A"]);
    expect(speakInOrder(attribution, 0, 10)).toEqual(["相手 B"]);
  });

  it("一度振ったラベルは同じ枠が話すたびに同じ。別の人には使い回さない（新しい枠は次のラベル）", () => {
    const attribution = createSpeakerAttribution();
    speakInOrder(attribution, 2, 0);
    speakInOrder(attribution, 0, 10);

    expect(speakInOrder(attribution, 2, 20)).toEqual(["相手 A"]);
    expect(speakInOrder(attribution, 1, 30)).toEqual(["相手 C"]);
    expect(speakInOrder(attribution, 0, 40)).toEqual(["相手 B"]);
  });

  it("最初に話す枠の番号が大きくても 相手 A になる（枠の番号からラベルを作らない）", () => {
    const attribution = createSpeakerAttribution();

    expect(speakInOrder(attribution, 7, 0)).toEqual(["相手 A"]);
  });

  it("確定区間が届いただけの枠にはラベルを振らない（先取りしない）。発言に出たときに初めて振る", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(5, 0, 5)); // どの発言にも重ならなかった枠
    attribution.speaker(speakerEvent(3, 10, 12));
    attribution.speaker(settledEvent(12));

    expect(pairs(attribution.remarks([heard("あ", 10, 12)], 12_000))).toEqual([["相手 A", "あ"]]);
    attribution.speaker(speakerEvent(5, 20, 22));
    attribution.speaker(settledEvent(22));
    expect(pairs(attribution.remarks([heard("い", 20, 22)], 22_000))).toEqual([["相手 B", "い"]]);
  });

  it("1 つの発言が 2 人分に切れたときは、発言の中の順（先に話した方が先）でラベルを振る", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(4, 10, 12));
    attribution.speaker(speakerEvent(1, 12, 14));
    attribution.speaker(settledEvent(14));

    const out = attribution.remarks([remarkOf([["あ", 10, 12], ["い", 12, 14]])], 14_000);

    expect(pairs(out)).toEqual([["相手 A", "あ"], ["相手 B", "い"]]);
  });

  it("26 人を超えても使い回さず、ラベルは重ならない", () => {
    const attribution = createSpeakerAttribution();
    const labels = Array.from({ length: 30 }, (_, slot) => speakInOrder(attribution, slot, slot * 10)[0]!);

    expect(new Set(labels).size).toBe(30);
    expect(labels[0]).toBe("相手 A");
    expect(labels[25]).toBe("相手 Z");
  });

  it("自分は常に「自分」で、ラベルを消費しない", () => {
    const attribution = createSpeakerAttribution();

    expect(pairs(attribution.remarks([{ track: "自分", start: 1, end: 2, text: "うん" }], 2000))).toEqual([["自分", "うん"]]);
    expect(speakInOrder(attribution, 3, 10)).toEqual(["相手 A"]);
    expect(pairs(attribution.remarks([{ track: "自分", start: 20, end: 21, text: "はい" }], 21_000))).toEqual([["自分", "はい"]]);
  });

  it("自分の発言は待たずに出る。保留中の相手の発言より先に出てよい（トラックが別）", () => {
    const attribution = createSpeakerAttribution();
    attribution.remarks([heard("あいて", 10, 12)], 12_000);

    expect(pairs(attribution.remarks([{ track: "自分", start: 10, end: 11, text: "じぶん" }], 12_000))).toEqual([["自分", "じぶん"]]);
  });

  it("出した発言に載る話者は、話者なし・「自分」・振ったラベルのどれかだけ", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(9, 0, 5));
    const out = [
      ...attribution.remarks([heard("あ", 1, 2), { track: "自分", start: 6, end: 7, text: "じ" }], 7000),
      ...attribution.remarks([heard("い", 40, 41)], 41_000),
      ...attribution.drain(),
    ];

    const valid = new Set<string | undefined>([undefined, "自分", "相手 A"]);
    for (const r of out) expect(valid.has(r.speaker)).toBe(true);
  });
});

// Issue #1022: 字幕の仮のラベル。仮の区間（final:false）は字幕にだけ使い、発言の判定とラベルの割り当てには使わない。
describe("createSpeakerAttribution: 字幕のための覗き（previewLabel / previewSegments）", () => {
  it("仮の区間だけの枠は、仮の区間で初めて現れた順のラベルで覗ける", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(3, 8, 8.5, false));
    attribution.speaker(speakerEvent(1, 8.5, 9, false));
    attribution.speaker(settledEvent(9));

    expect(attribution.previewLabel(3)).toBe("相手 A");
    expect(attribution.previewLabel(1)).toBe("相手 B");
  });

  it("覗いても発言のラベルの割り当ては変わらない（先取りしない）。後から出た発言が初めて話した順で振られる", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(3, 8, 8.5, false));
    attribution.speaker(settledEvent(9));
    expect(attribution.previewLabel(3)).toBe("相手 A");

    attribution.speaker(speakerEvent(2, 20, 22));
    attribution.speaker(settledEvent(22));

    expect(pairs(attribution.remarks([heard("あ", 20, 22)], 22_000))).toEqual([["相手 A", "あ"]]); // 枠 2 が先に話したので A
  });

  it("発言で振ったラベルがある枠は、そのラベルを覗ける。まだ振っていない枠は、振ったラベルの次から覗ける", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(2, 20, 22));
    attribution.speaker(settledEvent(22));
    attribution.remarks([heard("あ", 20, 22)], 22_000); // 枠 2 が 相手 A を得る
    attribution.speaker(speakerEvent(7, 30, 31, false));
    attribution.speaker(settledEvent(31));

    expect(attribution.previewLabel(2)).toBe("相手 A");
    expect(attribution.previewLabel(7)).toBe("相手 B");
  });

  it("仮の区間は発言の判定に使わない。仮の区間だけでは、揃った発言も話者なしで出る", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(5, 10, 12, false));
    attribution.speaker(settledEvent(12));

    expect(pairs(attribution.remarks([heard("あ", 10, 12)], 12_000))).toEqual([[undefined, "あ"]]);
  });

  it("previewSegments は確定区間と現在の仮の区間を返す。仮の区間は speaker-settled のたびに、その更新ぶんに入れ替わる", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(0, 0, 4)); // 確定
    attribution.speaker(speakerEvent(1, 8, 8.5, false));
    attribution.speaker(settledEvent(8.5));
    expect(attribution.previewSegments()).toEqual(expect.arrayContaining([seg(0, 0, 4), seg(1, 8, 8.5)]));
    expect(attribution.previewSegments()).toHaveLength(2);

    attribution.speaker(speakerEvent(2, 8, 9, false));
    attribution.speaker(settledEvent(9));

    expect(attribution.previewSegments()).toHaveLength(2);
    expect(attribution.previewSegments()).toEqual(expect.arrayContaining([seg(0, 0, 4), seg(2, 8, 9)]));
  });

  it("speaker-off の後は仮の区間を空にする", () => {
    const attribution = createSpeakerAttribution();
    attribution.speaker(speakerEvent(1, 8, 8.5, false));
    attribution.speaker(settledEvent(8.5));

    attribution.speaker(speakerOff);

    expect(attribution.previewSegments().filter((s) => s.slot === 1)).toEqual([]);
  });
});
