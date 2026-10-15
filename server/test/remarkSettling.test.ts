import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { SETTLE_QUIET_MS, SPEAKER_WAIT_MS, type HelperPartial, type SettledRemark, type SpeakerLogEvent, type WordTime } from "../src/core/index.ts";
import { createRemarkSettling } from "../src/remarkSettling.ts";

// 途中結果が T 秒変わらなければ発言として出す規則に、停止の門をつなぐ層（中核は実行環境のタイマーを使わない。ADR 0003）。
// Issue #1083: 発言を締める時計は、届いた結果の end の最大値（音声の時刻）だけ。壁時計（TestClock）では進まない。
// 結果が届かない間は発言を出さない。出すのは、結果の到着・確定結果・drain のとき。

const T = SETTLE_QUIET_MS;
const partial = (track: HelperPartial["track"], start: number, end: number, text: string): HelperPartial => ({ track, start, end, text, duplicate: false });
const final = (track: SettledRemark["track"], start: number, end: number, text: string): SettledRemark => ({ track, start, end, text });
const texts = (emitted: SettledRemark[]) => emitted.map((r) => r.text);

// Issue #1021: 相手の発言は話者の確定区間が揃うまで（最大 SPEAKER_WAIT_MS）出ない。
// 下の既存の観測は発言を締める規則（settle.ts）が対象なので、始めに speaker-off を渡して、相手の発言を待たずに話者なしで出す。
// 話者を決める規則と待ちは、speakerOff: false で組み立てた別の describe が対象にする
const speakers = (emitted: SettledRemark[]) => emitted.map((r) => [r.speaker, r.text]);
const settledTo = (to: number): SpeakerLogEvent => ({ type: "speaker-settled", track: "相手", to });
const SPEAKER_OFF: SpeakerLogEvent = { type: "speaker-off", start: 0, reason: "モデルなし" };

const setup = Effect.fn("setup")(function* ({ speakerOff = true }: { speakerOff?: boolean } = {}) {
  const emitted: SettledRemark[] = [];
  const settling = yield* createRemarkSettling({ emit: (r) => Effect.sync(() => emitted.push(r)) });
  if (speakerOff) yield* settling.speaker(SPEAKER_OFF);
  return { settling, emitted };
});

describe("途中結果から発言を出す", () => {
  it.effect("最後の途中結果の end から T 経つまでは出ず、T 経ったとき、最後の本文・区間で 1 件だけ出る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "あ"));
      yield* settling.partial(partial("相手", 10, 11.5, "あい")); // 更新で、出す時刻が後ろにずれる
      yield* settling.partial(partial("自分", 0, 11.5 + (T - 1) / 1000, "x"));
      expect(emitted).toEqual([]);

      yield* settling.partial(partial("自分", 0, 11.5 + T / 1000, "x"));
      expect(emitted).toEqual([{ track: "相手", start: 10, end: 11.5, text: "あい" }]);

      yield* settling.partial(partial("自分", 0, 11.5 + (T * 10) / 1000, "x"));
      expect(emitted).toHaveLength(1);
    }));

  it.effect("start が違う発話は、それぞれ最後の結果の end から T 経ったときに出る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "ひとつめ"));
      yield* settling.partial(partial("相手", 11, 11.25, "ふたつめ"));

      yield* settling.partial(partial("自分", 0, 12, "x"));
      expect(texts(emitted)).toEqual(["ひとつめ"]);
      yield* settling.partial(partial("自分", 0, 12.25, "x"));
      expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);
    }));

  it.effect("T 経つ前に確定結果が届いたら、確定結果を届いた時点で 1 件だけ出し、その後 T が過ぎても増えない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 12, "あい"));
      yield* settling.final(final("相手", 10.5, 12.5, "あいう。")); // end 12.5 は途中結果の期限（13 秒）の前

      expect(emitted).toEqual([{ track: "相手", start: 10.5, end: 12.5, text: "あいう。" }]);
      yield* settling.partial(partial("自分", 0, 30, "x"));
      expect(emitted).toHaveLength(1);
    }));

  it.effect("出した後に届いた確定結果は捨てる。発言は増えない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 12, "あしたの"));
      yield* settling.partial(partial("自分", 0, 13, "x"));
      expect(texts(emitted)).toEqual(["あしたの"]); // 先に出ている
      yield* settling.final(final("相手", 10.5, 12.5, "明日の会議。"));

      yield* settling.partial(partial("自分", 0, 20, "x"));
      expect(texts(emitted)).toEqual(["あしたの"]);
    }));

  it.effect("区間の一部だけが先に出ていた確定結果は、出ていない発話を確定結果が届いた時点で出し、後から二度出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "ひとつめ"));
      yield* settling.partial(partial("相手", 11, 11.75, "ふたつめ"));
      yield* settling.partial(partial("自分", 0, 12, "x")); // ひとつめだけ出る
      expect(texts(emitted)).toEqual(["ひとつめ"]);

      yield* settling.final(final("相手", 10, 12.5, "ひとつめ、ふたつめ。")); // end 12.5 はふたつめの期限（12.75 秒）の前
      expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);

      yield* settling.partial(partial("自分", 0, 30, "x"));
      expect(texts(emitted)).toEqual(["ひとつめ", "ふたつめ"]);
    }));

  it.effect("自分の確定結果は、そのまま 1 件出る（重複の印も保たれる）。自分の途中結果は、時計が進んでも出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "相手の途中"));
      yield* settling.partial(partial("自分", 10, 11, "自分の途中"));
      yield* settling.final({ track: "自分", start: 0, end: 2, text: "自分の確定。", duplicate: true });
      expect(emitted).toEqual([{ track: "自分", start: 0, end: 2, text: "自分の確定。", duplicate: true, speaker: "自分" }]);

      // 守っている状態に到達したことを先に確かめる: 同じ時間で、相手の途中結果は出る
      yield* settling.partial(partial("自分", 10, 20, "自分の途中"));
      expect(texts(emitted)).toEqual(["自分の確定。", "相手の途中"]);
    }));
});

// Issue #1083: 発言を締める時計は結果の end。壁時計（TestClock）は発言に影響しない
describe("音声の時刻で締める（Issue #1083）", () => {
  it.effect("結果の end が期限を越えると、壁時計を進めなくても出る（先に期限の来た発話、後に届いた結果の順）", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "あ"));
      yield* settling.final({ track: "自分", start: 0, end: 12, text: "自分の確定。" }); // 壁時計は 0 のまま

      expect(texts(emitted)).toEqual(["あ", "自分の確定。"]);
    }));

  it.effect("途中結果の end が期限を越えるときも、壁時計を進めずに先の発話が出る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "あ"));
      yield* settling.partial(partial("相手", 12, 13, "い")); // 別の発話で T を超えた差: 先の本文が先に出てから、当てはまる

      expect(emitted).toEqual([{ track: "相手", start: 10, end: 11, text: "あ" }]);
    }));

  it.effect("結果が届かない間は、壁時計がどれだけ進んでも発言を出さない。結果が届くか drain で出る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 20, "あ"));
      yield* TestClock.adjust(T * 10);
      expect(emitted).toEqual([]);

      yield* settling.partial(partial("自分", 0, 20 + T / 1000, "x"));
      expect(emitted).toEqual([{ track: "相手", start: 10, end: 20, text: "あ" }]);
    }));

  it.effect("時計を進めない結果（end が古い自分の確定結果）が届いても、期限は後ろへずれない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();

      yield* settling.partial(partial("相手", 10, 11, "あ"));
      yield* settling.final({ track: "自分", start: 0, end: 2, text: "古い" }); // 時計は進まない
      expect(texts(emitted)).toEqual(["古い"]);

      yield* settling.partial(partial("自分", 0, 11 + (T - 1) / 1000, "x"));
      expect(texts(emitted)).toEqual(["古い"]);
      yield* settling.partial(partial("自分", 0, 11 + T / 1000, "x"));
      expect(texts(emitted)).toEqual(["古い", "あ"]);
    }));

  it.effect("途中結果の後に確定結果が届く列は、壁時計の間隔が 0 でも T より長くても、同じ発言の列になる", () =>
    Effect.gen(function* () {
      const run = (gap: number) =>
        Effect.gen(function* () {
          const { settling, emitted } = yield* setup();
          yield* settling.partial(partial("相手", 0, 2, "あい"));
          yield* TestClock.adjust(gap);
          yield* settling.final(final("相手", 0, 2.5, "あいう"));
          yield* settling.drain;
          return emitted.map((r) => [r.track, r.start, r.end, r.text]);
        });

      const immediate = yield* run(0);
      const spaced = yield* run(T + 100);

      expect(immediate).toEqual([["相手", 0, 2.5, "あいう"]]);
      expect(spaced).toEqual(immediate);
    }));

  it.effect("同じ発話の更新で end が T 以上進む列は、間に時計を進める結果があってもなくても、壁時計の間隔によらず同じ発言の列になる", () =>
    Effect.gen(function* () {
      const run = (gap: number, withTick: boolean) =>
        Effect.gen(function* () {
          const { settling, emitted } = yield* setup();
          yield* settling.partial(partial("相手", 10, 11, "あ"));
          yield* TestClock.adjust(gap);
          if (withTick) yield* settling.partial(partial("自分", 0, 12, "x"));
          yield* settling.partial(partial("相手", 10, 15, "あいうえお"));
          yield* settling.drain;
          return emitted.map((r) => [r.track, r.start, r.end, r.text]);
        });

      const expected = [["相手", 10, 11, "あ"], ["相手", 11, 15, "いうえお"]];
      expect(yield* run(0, false)).toEqual(expected);
      expect(yield* run(T + 100, false)).toEqual(expected);
      expect(yield* run(0, true)).toEqual(expected);
    }));

  // 結果の列は、届く間隔によらず同じ発言の列になる（TestClock を進めない間隔 0 と、音声の時刻と同じだけ進める間隔）
  describe("同じ結果の列を、間隔 0 で流しても音声の時刻と同じ間隔で流しても、同じ発言の列ができる", () => {
    type Step = { kind: "partial"; p: HelperPartial } | { kind: "final"; r: SettledRemark };
    const steps: Step[] = [
      { kind: "partial", p: partial("相手", 10, 11, "あい") },
      { kind: "partial", p: partial("相手", 10, 11.25, "あいう。え") },
      { kind: "partial", p: partial("相手", 10, 11.5, "あいう。えお") },
      { kind: "partial", p: partial("相手", 30, 30.5, "べつの発話") },
      { kind: "partial", p: partial("相手", 30, 30.75, "べつの発話です。") },
      { kind: "final", r: final("自分", 31, 33, "自分の確定。") },
      { kind: "partial", p: partial("相手", 40, 41, "ひとつめ") },
      { kind: "partial", p: partial("相手", 41, 41.25, "ふたつめ") },
      { kind: "partial", p: partial("相手", 40, 41.5, "ひとつめの続き") },
      { kind: "final", r: final("相手", 60, 62, "確定だけ。") },
      { kind: "partial", p: partial("相手", 70, 71, "覆われる") },
      { kind: "final", r: final("相手", 69.5, 71.5, "覆われる。") },
      { kind: "final", r: final("自分", 0, 5, "古い end") },
      { kind: "partial", p: partial("相手", 90, 91, "あ") },
      { kind: "partial", p: partial("相手", 90, 95, "あいうえお") }, // 同じ発話の更新で end が T 以上進む
      { kind: "partial", p: partial("相手", 100, 102, "あい") },
      { kind: "final", r: final("相手", 100, 102.5, "あいう") }, // 途中結果の後の確定結果
      { kind: "partial", p: partial("相手", 110, 111, "最後") },
    ];
    const endOf = (step: Step) => (step.kind === "partial" ? step.p.end : step.r.end);

    const run = (stretch: boolean) =>
      Effect.gen(function* () {
        const { settling, emitted } = yield* setup();
        let audio = 0; // 最後に流した結果までの end の最大値（ミリ秒）
        for (const step of steps) {
          if (stretch && audio > 0) yield* TestClock.adjust(Math.max(0, endOf(step) * 1000 - audio));
          audio = Math.max(audio, endOf(step) * 1000);
          yield* step.kind === "partial" ? settling.partial(step.p) : settling.final(step.r);
        }
        yield* settling.drain;
        return emitted.map((r) => [r.track, r.start, r.end, r.text]);
      });

    it.effect("TestClock を進めない列と、音声の時刻と同じ間隔で進める列は一致する", () =>
      Effect.gen(function* () {
        const compressed = yield* run(false);
        const stretched = yield* run(true);

        expect(stretched).toEqual(compressed);
        expect(compressed.map((r) => r[3])).toEqual([
          "あいう。",
          "えお",
          "べつの発話です。",
          "自分の確定。",
          "ふたつめ",
          "ひとつめの続き",
          "確定だけ。",
          "覆われる。",
          "古い end",
          "あ",
          "いうえお",
          "あいう",
          "最後",
        ]);
      }));
  });
});

describe("停止", () => {
  it.effect("drain で、まだ出ていない発話を T を待たずにすべて出す。その後 T が過ぎても二度出ない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();
      yield* settling.partial(partial("相手", 10, 11, "あ"));
      yield* settling.partial(partial("相手", 11, 11.25, "い"));

      yield* settling.drain;

      expect(texts(emitted)).toEqual(["あ", "い"]);
      yield* settling.drain;
      expect(texts(emitted)).toEqual(["あ", "い"]);
    }));

  it.effect("stop の後は、途中結果・確定結果・drain を受け付けず、何も出さない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup();
      yield* settling.partial(partial("相手", 10, 11, "あ"));

      yield* settling.stop;

      yield* settling.partial(partial("相手", 20, 21, "い"));
      yield* settling.final(final("相手", 30, 31, "う。"));
      yield* settling.drain;
      yield* TestClock.adjust(T * 5);
      expect(emitted).toEqual([]);
    }));
});

// Issue #1021: 発言を締める 4 つの出口（due の 1 秒 / due の文の終わり / final の既出分岐 / final の passCarried 分岐 / drain）の
// どれから出た発言にも、同じ規則で話者が付く。同じ確定区間（slot 3 → slot 1 → slot 4）を先に届けておき、各出口の出力を比べる。
describe("どの出口から出た発言にも同じ規則で話者が付く（Issue #1021）", () => {
  const segment = (slot: number, start: number, end: number): SpeakerLogEvent => ({ type: "speaker", track: "相手", start, end, slot, final: true });
  const span = (location: number, length: number, start: number, end: number): WordTime => ({ location, length, start, end });
  const heardPartial = (start: number, end: number, text: string, wordTimes: WordTime[]): HelperPartial => ({ ...partial("相手", start, end, text), wordTimes });

  // 確定区間と確定済みの位置は、発言より先に届いている（揃っているので、締まった発言はすぐ出る）
  const withSegments = Effect.fn("withSegments")(function* () {
    const made = yield* setup({ speakerOff: false });
    for (const s of [segment(3, 10, 11), segment(1, 11, 14), segment(4, 14, 16), settledTo(16)]) yield* made.settling.speaker(s);
    return made;
  });

  it.effect("due（1 秒更新されなかった途中結果）: 話者が替わる所で切り、先に話した順にラベルが付く", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* withSegments();

      yield* settling.partial(heardPartial(10, 14, "はい、ありがとう", [span(0, 3, 10, 11), span(3, 5, 11, 14)]));
      yield* settling.partial(partial("自分", 0, 14 + T / 1000, "x"));

      expect(speakers(emitted)).toEqual([["相手 A", "はい、"], ["相手 B", "ありがとう"]]);
      expect(emitted.map((r) => [r.start, r.end])).toEqual([[10, 11], [11, 14]]);
    }));

  it.effect("due（文の終わりで締める発言）: 同じ規則で切り、同じラベルになる", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* withSegments();

      yield* settling.partial(heardPartial(10, 14, "はい、ありがとう。", [span(0, 3, 10, 11), span(3, 6, 11, 14)]));
      yield* settling.partial(partial("自分", 0, 14.05, "x")); // 文の終わりから SETTLE_SENTENCE_MS（50ms）経った。1 秒は経っていない

      expect(speakers(emitted)).toEqual([["相手 A", "はい、"], ["相手 B", "ありがとう。"]]);
    }));

  it.effect("final の既出分岐（区間の一部が先に出ている確定結果）: 残りの発話を同じ規則で切る。ラベルは先に出した分と続けて振られる", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* withSegments();

      yield* settling.partial(heardPartial(10, 11, "はい、", [span(0, 3, 10, 11)]));
      yield* settling.partial(heardPartial(11, 16, "ありがとう、お願いします", [span(0, 6, 11, 14), span(6, 6, 14, 16)]));
      yield* settling.partial(partial("自分", 0, 12, "x")); // 先頭の発話だけ 1 秒経って出る
      expect(speakers(emitted)).toEqual([["相手 A", "はい、"]]);

      yield* settling.final({ ...final("相手", 10, 16.5, "はい、ありがとう、お願いします") });

      expect(speakers(emitted)).toEqual([["相手 A", "はい、"], ["相手 B", "ありがとう、"], ["相手 C", "お願いします"]]);
    }));

  it.effect("final の passCarried 分岐（途中結果が無い確定結果）: 同じ規則で切る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* withSegments();

      yield* settling.final({ ...final("相手", 10, 14, "はい、ありがとう"), wordTimes: [span(0, 3, 10, 11), span(3, 5, 11, 14)] });

      expect(speakers(emitted)).toEqual([["相手 A", "はい、"], ["相手 B", "ありがとう"]]);
    }));

  it.effect("drain: 区間が揃っていれば同じ規則で切る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* withSegments();

      yield* settling.partial(heardPartial(10, 14, "はい、ありがとう", [span(0, 3, 10, 11), span(3, 5, 11, 14)]));
      expect(emitted).toEqual([]);
      yield* settling.drain;

      expect(speakers(emitted)).toEqual([["相手 A", "はい、"], ["相手 B", "ありがとう"]]);
    }));

  it.effect("drain: 区間が揃っていない発言は、3 秒を待たずに話者なしで出る。出た後に区間が届いても変わらない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup({ speakerOff: false });

      yield* settling.partial(heardPartial(10, 14, "はい、ありがとう", [span(0, 3, 10, 11), span(3, 5, 11, 14)]));
      yield* settling.drain;
      expect(speakers(emitted)).toEqual([[undefined, "はい、ありがとう"]]);

      yield* settling.speaker(segment(3, 10, 14));
      yield* settling.speaker(settledTo(14));
      yield* settling.drain;
      expect(speakers(emitted)).toEqual([[undefined, "はい、ありがとう"]]);
    }));

  it.effect("すべての出口をまたいで、ラベルの対応は 1 つ（出口が違っても同じ枠は同じラベル。新しい枠は続きのラベル）", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup({ speakerOff: false });
      for (const s of [segment(3, 0, 2), segment(1, 2, 4), segment(3, 4, 6), segment(9, 6, 8), settledTo(8)]) yield* settling.speaker(s);

      yield* settling.partial(heardPartial(0, 2, "ひとつめ", [span(0, 4, 0, 2)])); // 1 秒の出口
      yield* settling.partial(partial("自分", 0, 3, "x"));
      yield* settling.final({ ...final("相手", 2, 4, "ふたつめ"), wordTimes: [span(0, 4, 2, 4)] }); // 確定結果の出口
      yield* settling.partial(heardPartial(4, 6, "みっつめ", [span(0, 4, 4, 6)]));
      yield* settling.partial(heardPartial(6, 8, "よっつめ", [span(0, 4, 6, 8)]));
      yield* settling.drain; // drain の出口

      expect(speakers(emitted)).toEqual([["相手 A", "ひとつめ"], ["相手 B", "ふたつめ"], ["相手 A", "みっつめ"], ["相手 C", "よっつめ"]]);
    }));
});

describe("確定を待って出す・使えないとき（Issue #1021）", () => {
  it.effect("確定区間が揃うまで出ない。音声の時計（結果の end）が SPEAKER_WAIT_MS 進んでも揃わなければ話者なしで出る。壁時計では進まない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup({ speakerOff: false });

      yield* settling.final(final("相手", 10, 12, "あい。"));
      yield* TestClock.adjust(SPEAKER_WAIT_MS * 10);
      expect(emitted).toEqual([]);

      yield* settling.partial(partial("自分", 0, 12 + (SPEAKER_WAIT_MS - 1) / 1000, "x"));
      expect(emitted).toEqual([]);
      yield* settling.partial(partial("自分", 0, 12 + SPEAKER_WAIT_MS / 1000, "x"));
      expect(emitted).toEqual([{ track: "相手", start: 10, end: 12, text: "あい。" }]);
    }));

  it.effect("区間の end が発言の end に届いても、確定済みの位置が届くまでは出ない。位置が届くと話者付きで出る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup({ speakerOff: false });
      yield* settling.final(final("相手", 10, 14, "あい。"));

      yield* settling.speaker({ type: "speaker", track: "相手", start: 12, end: 14, slot: 0, final: true });
      expect(emitted).toEqual([]);
      yield* settling.speaker(settledTo(14));
      expect(speakers(emitted)).toEqual([["相手 A", "あい。"]]);
    }));

  it.effect("speaker-off を受けたら、保留中の発言は話者なしですぐ出て、以後の相手の発言は待たずに出る", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup({ speakerOff: false });
      yield* settling.final(final("相手", 10, 12, "あい。"));
      expect(emitted).toEqual([]);

      yield* settling.speaker({ type: "speaker-off", start: 12, reason: "途中で停止" });
      expect(texts(emitted)).toEqual(["あい。"]);

      yield* settling.final(final("相手", 20, 22, "うえ。"));
      expect(texts(emitted)).toEqual(["あい。", "うえ。"]);
      expect(emitted.every((r) => r.speaker === undefined)).toBe(true);
    }));

  it.effect("stop の後に届いた話者の区間・speaker-off は何も出さない", () =>
    Effect.gen(function* () {
      const { settling, emitted } = yield* setup({ speakerOff: false });
      yield* settling.final(final("相手", 10, 12, "あい。"));

      yield* settling.stop;
      yield* settling.speaker({ type: "speaker", track: "相手", start: 10, end: 12, slot: 0, final: true });
      yield* settling.speaker(settledTo(12));
      yield* settling.speaker({ type: "speaker-off", start: 12, reason: "途中で停止" });

      expect(emitted).toEqual([]);
    }));
});
