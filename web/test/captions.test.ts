import { describe, expect, it } from "vitest";
import { Clock, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { CAPTION_CONTINUE_GAP_S, createCaptionBoard, createRemarkSettler, SETTLE_QUIET_MS, type CaptionBubble, type CaptionsFrame, type HelperPartial, type Segment } from "../../server/src/core/index.ts";
import { createSpeakingRelay } from "../../server/src/speakingRelay.ts";
import {
  advanceCaptions,
  CAPTION_LABEL_WAIT_MS,
  CAPTION_PROVISIONAL_LIMIT_MS,
  CAPTION_SLIDE_MS,
  CAPTION_VISIBLE_BUBBLES,
  createCaptionState,
  displayBubbles,
  nextCaptionDeadline,
  receiveCaptions,
  settledCaptions,
  slideDeltas,
  type CaptionState,
  type DisplayBubble,
} from "../src/captions.ts";

describe("settledCaptions（見返しの字幕。ラベルの待ちも仮の名前も通さない）", () => {
  const bubble = (id: string, extra: Partial<CaptionBubble> = {}): CaptionBubble => ({ id, track: "相手", label: "なし", start: 0, end: 1, text: id, settledLength: id.length, ...extra });

  it("話者なし（ラベル「なし」）の吹き出しも、待たずにその場で出る。名前の欄は「相手」で、薄くしない", () => {
    const [shown] = displayBubbles(settledCaptions([bubble("x", { text: "古いログ" })]), 0);
    expect(shown).toMatchObject({ id: "x", side: "left", text: "古いログ", nameState: "settled" });
    expect(shown!.name).toEqual(Option.some("相手"));
  });

  it("次に状態が変わる時刻は無い（待ちの期限も 3 秒の規則も持たない）", () => {
    expect(nextCaptionDeadline(settledCaptions([bubble("x"), bubble("y", { label: "確定", speaker: "相手 A" })]))).toBeUndefined();
  });

  it("話者つきの吹き出しは、名前の表の名前で出る。start の順・相手は左・自分は右はライブと同じ", () => {
    const shown = displayBubbles(
      settledCaptions([
        bubble("c", { start: 5, speaker: "相手 A", label: "確定" }),
        bubble("a", { start: 1, speaker: "相手 B", label: "確定" }),
        bubble("b", { start: 3, track: "自分", speaker: "自分", label: "確定" }),
      ]),
      0,
      { "相手 B": "田中" },
    );
    expect(shown.map((b) => [b.id, b.side, Option.getOrElse(b.name, () => "")])).toEqual([
      ["a", "left", "田中"],
      ["b", "right", ""],
      ["c", "left", "相手 A"],
    ]);
    expect(shown.every((b) => b.nameState === "settled")).toBe(true);
  });
});

// Issue #1022: 会議中の字幕。サーバーの吹き出し（CaptionBubble）を、表示の吹き出しに直す純粋な状態。
// 時計は持たない。時刻（ミリ秒）は引数で渡す。状態は同じ値にフレームを順に当てて観測する。
describe("会議中の字幕（吹き出し）", () => {
  const bubble = (id: string, extra: Partial<CaptionBubble> = {}): CaptionBubble => ({ id, track: "相手", label: "なし", start: 0, end: 1, text: id, settledLength: (extra.text ?? id).length, ...extra });
  const named = (id: string, speaker: string, label: "仮" | "確定", extra: Partial<CaptionBubble> = {}) => bubble(id, { speaker, label, ...extra });
  const mine = (id: string, extra: Partial<CaptionBubble> = {}) => bubble(id, { track: "自分", speaker: "自分", label: "確定", ...extra });
  // 期限までに起きる割り当てを済ませてから、その時刻の表示を読む
  const view = (state: CaptionState, now: number) => displayBubbles(advanceCaptions(state, now), now);
  const nameOf = (b: DisplayBubble) => Option.getOrUndefined(b.name);
  const shown = (state: CaptionState, now: number) => view(state, now).map((b) => [b.id, b.side, nameOf(b)]);
  const WAIT = CAPTION_LABEL_WAIT_MS;

  it("何も受けていなければ何も出さない", () => {
    expect(view(createCaptionState(), 0)).toEqual([]);
  });

  describe("並びと左右", () => {
    it("start の順に並べる。相手は左、自分は右で、自分には名前が無い", () => {
      const state = receiveCaptions(createCaptionState(), [mine("m", { start: 9 }), named("a", "相手 A", "確定", { start: 8 })], 0);

      expect(shown(state, 0)).toEqual([["a", "left", "相手 A"], ["m", "right", undefined]]);
    });

    it("末尾の CAPTION_VISIBLE_BUBBLES 個だけを出す", () => {
      const all = Array.from({ length: CAPTION_VISIBLE_BUBBLES + 2 }, (_, i) => named(`b${i}`, "相手 A", "確定", { start: i }));
      const state = receiveCaptions(createCaptionState(), all, 0);

      expect(view(state, 0).map((b) => b.id)).toEqual(all.slice(-CAPTION_VISIBLE_BUBBLES).map((b) => b.id));
    });

    it("次のフレームに無い吹き出しは外れる。空のフレームで全部消える", () => {
      let state = receiveCaptions(createCaptionState(), [named("a", "相手 A", "確定"), mine("m", { start: 2 })], 0);
      state = receiveCaptions(state, [mine("m", { start: 2 })], 10);
      expect(view(state, 10).map((b) => b.id)).toEqual(["m"]);

      state = receiveCaptions(state, [], 20);
      expect(view(state, 20)).toEqual([]);
    });

    it("文字が伸びたら、同じ id の吹き出しの文字が更新される", () => {
      let state = receiveCaptions(createCaptionState(), [named("a", "相手 A", "仮", { text: "こん" })], 0);
      state = receiveCaptions(state, [named("a", "相手 A", "仮", { text: "こんにちは" })], 50);

      expect(view(state, 50).map((b) => b.text)).toEqual(["こんにちは"]);
    });
  });

  describe("名前の欄", () => {
    it("同じ人の吹き出しが続くときは、2 つ目以降の名前を省く。間に別の人が入れば、また出す", () => {
      const run = receiveCaptions(createCaptionState(), [named("a1", "相手 A", "確定", { start: 1 }), named("a2", "相手 A", "確定", { start: 2 }), mine("m", { start: 3 })], 0);
      expect(view(run, 0).map(nameOf)).toEqual(["相手 A", undefined, undefined]);

      const interleaved = receiveCaptions(createCaptionState(), [named("a1", "相手 A", "確定", { start: 1 }), mine("m", { start: 2 }), named("a2", "相手 A", "確定", { start: 3 })], 0);
      expect(view(interleaved, 0).map(nameOf)).toEqual(["相手 A", undefined, "相手 A"]);
    });

    it("同じ名前は同じ色、別の名前は別の色になる", () => {
      const state = receiveCaptions(createCaptionState(), [
        named("a1", "相手 A", "確定", { start: 1 }),
        named("b", "相手 B", "確定", { start: 2 }),
        named("a2", "相手 A", "確定", { start: 3 }),
      ], 0);
      const [a1, b, a2] = view(state, 0);

      expect(a1!.colorIndex).toBe(a2!.colorIndex);
      expect(a1!.colorIndex).not.toBe(b!.colorIndex);
    });

    it("仮は薄く、確定は通常の濃さ", () => {
      const state = receiveCaptions(createCaptionState(), [named("a", "相手 A", "仮", { start: 1 }), named("b", "相手 B", "確定", { start: 2 })], 0);

      expect(view(state, 0).map((b) => b.nameState)).toEqual(["provisional", "settled"]);
    });

    it("仮のまま CAPTION_PROVISIONAL_LIMIT_MS たつと、名前は「相手」だけになり、通常の濃さで出る。それまでは仮のラベルのまま", () => {
      const state = receiveCaptions(createCaptionState(), [named("a", "相手 B", "仮")], 1000);

      const before = view(state, 1000 + CAPTION_PROVISIONAL_LIMIT_MS - 1)[0]!;
      expect([nameOf(before), before.nameState]).toEqual(["相手 B", "provisional"]);
      const after = view(state, 1000 + CAPTION_PROVISIONAL_LIMIT_MS)[0]!;
      expect([nameOf(after), after.nameState]).toEqual(["相手", "settled"]);
    });

    it("3 秒の数え始めは最初に受けた時刻。同じ id を受け直しても数え直さない", () => {
      let state = receiveCaptions(createCaptionState(), [named("a", "相手 B", "仮")], 0);
      state = receiveCaptions(state, [named("a", "相手 B", "仮", { text: "続き" })], CAPTION_PROVISIONAL_LIMIT_MS - 1000);

      expect(nameOf(view(state, CAPTION_PROVISIONAL_LIMIT_MS)[0]!)).toBe("相手");
    });

    it("3 秒たった後に確定のラベルが届けば、そのラベルの名前になる（同じ吹き出し、同じ文字）", () => {
      let state = receiveCaptions(createCaptionState(), [named("a", "相手 B", "仮", { text: "こんにちは" })], 0);
      expect(nameOf(view(state, CAPTION_PROVISIONAL_LIMIT_MS)[0]!)).toBe("相手");

      state = receiveCaptions(state, [named("a", "相手 B", "確定", { text: "こんにちは" })], CAPTION_PROVISIONAL_LIMIT_MS + 500);

      const [only] = view(state, CAPTION_PROVISIONAL_LIMIT_MS + 500);
      expect([only!.id, nameOf(only!), only!.nameState, only!.text]).toEqual(["a", "相手 B", "settled", "こんにちは"]);
    });
  });

  describe("ラベルを待つ", () => {
    it("ラベルが「なし」の文字は、CAPTION_LABEL_WAIT_MS たつまで出さない", () => {
      const state = receiveCaptions(createCaptionState(), [bubble("a")], 1000);

      expect(view(state, 1000)).toEqual([]);
      expect(view(state, 1000 + WAIT - 1)).toEqual([]);
      expect(view(state, 1000 + WAIT).map((b) => b.id)).toEqual(["a"]);
    });

    it("待っている間に仮のラベルが届けば、そこで出す（待ちきらない）", () => {
      let state = receiveCaptions(createCaptionState(), [bubble("a", { text: "こんにちは" })], 0);
      state = receiveCaptions(state, [named("a", "相手 A", "仮", { text: "こんにちは" })], 100);

      expect(view(state, 100).map((b) => [b.id, nameOf(b), b.text])).toEqual([["a", "相手 A", "こんにちは"]]);
    });

    it("待ちの上限の時刻は、最初に受けた時刻から数える。次の期限は nextCaptionDeadline で読める", () => {
      const state = receiveCaptions(createCaptionState(), [bubble("a")], 1000);

      expect(nextCaptionDeadline(state)).toBe(1000 + WAIT);
    });

    it("仮のラベルを持つ吹き出しの期限は、3 秒の規則の時刻。待つものも仮のものも無ければ期限は無い", () => {
      expect(nextCaptionDeadline(createCaptionState())).toBeUndefined();
      const provisional = receiveCaptions(createCaptionState(), [named("a", "相手 A", "仮")], 500);
      expect(nextCaptionDeadline(provisional)).toBe(500 + CAPTION_PROVISIONAL_LIMIT_MS);
      const settled = receiveCaptions(createCaptionState(), [named("a", "相手 A", "確定"), mine("m")], 500);
      expect(nextCaptionDeadline(settled)).toBeUndefined();
    });

    it("上限までラベルが来なかった文字は、直前の語との間が CAPTION_CONTINUE_GAP_S 未満なら、同じトラックの直前の吹き出しに続ける", () => {
      const first = named("a", "相手 A", "確定", { start: 1, end: 3, text: "こんにちは" });
      const orphan = bubble("b", { start: 3 + CAPTION_CONTINUE_GAP_S - 0.1, end: 5, text: "ありがとう" });
      const state = receiveCaptions(createCaptionState(), [first, orphan], 0);

      const out = view(state, WAIT);

      expect(out.map((b) => [b.id, nameOf(b), b.text])).toEqual([["a", "相手 A", "こんにちはありがとう"]]);
    });

    it("間が CAPTION_CONTINUE_GAP_S 以上空いていれば、名前「相手」の新しい吹き出しにする", () => {
      const first = named("a", "相手 A", "確定", { start: 1, end: 3, text: "こんにちは" });
      const orphan = bubble("b", { start: 3 + CAPTION_CONTINUE_GAP_S, end: 5, text: "ありがとう" });
      const state = receiveCaptions(createCaptionState(), [first, orphan], 0);

      const out = view(state, WAIT);

      expect(out.map((b) => [b.id, b.side, nameOf(b), b.text])).toEqual([["a", "left", "相手 A", "こんにちは"], ["b", "left", "相手", "ありがとう"]]);
    });

    it("出すと決めた割り当ては、後からラベルが届いても動かない。続けた文字は続けたまま、新しい吹き出しにした文字は名前だけが替わる", () => {
      const first = named("a", "相手 A", "確定", { start: 1, end: 3, text: "こんにちは" });
      const continued = bubble("b", { start: 3.1, end: 4, text: "あ" });
      const separate = bubble("c", { start: 8, end: 9, text: "い" });
      let state = receiveCaptions(createCaptionState(), [first, continued, separate], 0);
      expect(view(state, WAIT).map((b) => [b.id, nameOf(b), b.text])).toEqual([["a", "相手 A", "こんにちはあ"], ["c", "相手", "い"]]);

      state = receiveCaptions(state, [first, { ...continued, speaker: "相手 B", label: "確定" }, { ...separate, speaker: "相手 B", label: "確定" }], WAIT + 100);

      expect(view(state, WAIT + 100).map((b) => [b.id, nameOf(b), b.text])).toEqual([["a", "相手 A", "こんにちはあ"], ["c", "相手 B", "い"]]);
    });

    describe("続けた吹き出しの確定の文字数（settledLength）", () => {
      const settledOf = (state: CaptionState, now: number) => view(state, now).map((b) => [b.id, b.text, b.settledLength]);

      it("前が全部確定なら、確定の文字数は「前の本文の長さ + 後ろの確定の分」", () => {
        const first = named("a", "相手 A", "確定", { start: 1, end: 3, text: "こんにちは" });
        const orphan = bubble("b", { start: 3.1, end: 5, text: "ありがとう元気", settledLength: 5 });
        const state = receiveCaptions(createCaptionState(), [first, orphan], 0);

        expect(settledOf(state, WAIT)).toEqual([["a", "こんにちはありがとう元気", 10]]);
      });

      it("前の吹き出しに途中の分が残っていれば、後ろは確定の分があっても全部途中（確定の文字数は前のまま）", () => {
        const first = named("a", "相手 A", "確定", { start: 1, end: 3, text: "こんにちは元気", settledLength: 5 });
        const orphan = bubble("b", { start: 3.1, end: 5, text: "ありがとう", settledLength: 5 });
        const state = receiveCaptions(createCaptionState(), [first, orphan], 0);

        expect(settledOf(state, WAIT)).toEqual([["a", "こんにちは元気ありがとう", 5]]);
      });

      it("前が全部確定で、後ろが全部途中なら、確定の文字数は前の本文の長さ", () => {
        const first = named("a", "相手 A", "確定", { start: 1, end: 3, text: "こんにちは" });
        const orphan = bubble("b", { start: 3.1, end: 5, text: "ありがとう", settledLength: 0 });
        const state = receiveCaptions(createCaptionState(), [first, orphan], 0);

        expect(settledOf(state, WAIT)).toEqual([["a", "こんにちはありがとう", 5]]);
      });

      it("3 つ続くとき、途中の分が出た後ろは全部途中のまま（途中の後ろに確定を作らない）", () => {
        const first = named("a", "相手 A", "確定", { start: 1, end: 3, text: "あい" });
        const second = bubble("b", { start: 3.1, end: 4, text: "うえ", settledLength: 1 });
        const third = bubble("c", { start: 4.1, end: 5, text: "おか", settledLength: 2 });
        const state = receiveCaptions(createCaptionState(), [first, second, third], 0);

        expect(settledOf(state, WAIT)).toEqual([["a", "あいうえおか", 3]]);
      });

      it("続けない吹き出し（先頭の吹き出し）は、受けた確定の文字数のまま", () => {
        const state = receiveCaptions(createCaptionState(), [named("a", "相手 A", "仮", { text: "こんにちは元気", settledLength: 5 })], 0);

        expect(settledOf(state, 100)).toEqual([["a", "こんにちは元気", 5]]);
      });

      it("途中の分が発言になって確定の文字数が増えたフレームを受けると、同じ id の表示の確定の文字数が増える", () => {
        const provisional = named("a", "相手 A", "仮", { text: "こんにちは", settledLength: 0 });
        let state = receiveCaptions(createCaptionState(), [provisional], 0);
        expect(settledOf(state, 100)).toEqual([["a", "こんにちは", 0]]);

        state = receiveCaptions(state, [{ ...provisional, label: "確定", settledLength: 5 }], 200);

        expect(settledOf(state, 200)).toEqual([["a", "こんにちは", 5]]);
      });
    });

    it("直前の吹き出しが無い（先頭の）ラベルなしの文字は、待ちの上限の後に名前「相手」の吹き出しで出る", () => {
      const state = receiveCaptions(createCaptionState(), [bubble("a", { text: "こんにちは" })], 0);

      expect(view(state, WAIT).map((b) => [b.id, nameOf(b), b.text])).toEqual([["a", "相手", "こんにちは"]]);
    });
  });

  describe("ラベルなしの語の間（盤から表示まで）", () => {
    type Word = readonly [text: string, start: number, end: number];
    const frame = (words: readonly Word[]) => {
      let location = 0;
      const wordTimes = words.map(([text, start, end]) => {
        const w = { location, length: text.length, start, end };
        location += text.length;
        return w;
      });
      return createCaptionBoard().build({
        partials: [{ track: "相手", duplicate: false, text: words.map(([t]) => t).join(""), start: words[0]![1], end: words.at(-1)![2], wordTimes }],
        unreflected: [],
        held: [],
        intervals: [],
        previewLabel: () => "相手 A",
      });
    };

    it("0.3 秒以上離れた語は、待ちの上限の後に別の吹き出しになる。名前は「相手」", () => {
      const bubbles = frame([["あ", 10, 11], ["い", 12, 13]]);
      expect(bubbles).toHaveLength(2);
      const state = receiveCaptions(createCaptionState(), bubbles, 0);

      expect(view(state, WAIT - 1)).toEqual([]);
      const out = view(state, WAIT);

      expect(out.map((b) => b.text)).toEqual(["あ", "い"]);
      expect(nameOf(out[0]!)).toBe("相手");
    });

    it("0.3 秒未満で続く語は 1 つの吹き出しのまま", () => {
      const bubbles = frame([["あ", 10, 11], ["い", 11.1, 12]]);
      const state = receiveCaptions(createCaptionState(), bubbles, 0);

      expect(view(state, WAIT).map((b) => b.text)).toEqual(["あい"]);
    });
  });

  // Issue #1222: 「相手 A」の発言の後に、同じ区切りが延びた途中結果が届く。サーバーは出した分を除いた後ろだけを盤へ渡すので、後ろは別の吹き出し（ラベルなし）で届く。
  // 画面では、待ちの上限の後に「相手 A」の吹き出しの続きとして出て、別の「相手」の吹き出しは立たない
  describe("発言の後に延びた途中結果（settler から盤・表示まで）", () => {
    it("「相手 A」の発言「来週のリリースは」の後に「来週のリリースは金曜に」が届くと、待ちの上限の後に「相手 A」の吹き出し 1 つに「来週のリリースは金曜に」と出る", () => {
      const settler = createRemarkSettler();
      const board = createCaptionBoard();
      const wordTimes = [{ location: 0, length: 3, start: 0, end: 0.5 }, { location: 3, length: 5, start: 0.5, end: 1.2 }];
      const first: HelperPartial = { track: "相手", duplicate: false, start: 0, end: 1.2, text: "来週のリリースは", wordTimes };
      settler.partial(first);
      const [remark] = settler.partial({ track: "自分", duplicate: false, start: 0, end: 1.2 + SETTLE_QUIET_MS / 1000, text: "時計" });
      const unreflected = [{ id: "r1", remark: { ...remark!, speaker: "相手 A" } }];
      const input = { unreflected, held: [], intervals: [], previewLabel: () => undefined };
      let state = receiveCaptions(createCaptionState(), board.build({ ...input, partials: [] }), 0);

      const extended: HelperPartial = { ...first, end: 2, text: "来週のリリースは金曜に", wordTimes: [...wordTimes, { location: 8, length: 3, start: 1.3, end: 2 }] };
      settler.partial(extended);
      state = receiveCaptions(state, board.build({ ...input, partials: [settler.unemittedTail(extended)] }), 100);

      expect(view(state, 100 + WAIT).map((b) => [nameOf(b), b.text])).toEqual([["相手 A", "来週のリリースは金曜に"]]);
    });
  });

  describe("区間が届く前に 1 つで送られた吹き出しが、話者で分かれる（splitFrom。同じ盤を 2 回 build する）", () => {
    const words = [["あ", 10, 10.2], ["い", 10.25, 10.45]] as const;
    const board = (slots: readonly { slot: number; start: number; end: number }[]) => {
      const created = createCaptionBoard();
      const build = (intervals: readonly { slot: number; start: number; end: number }[]) =>
        created.build({
          partials: [{ track: "相手", duplicate: false, text: "あい", start: 10, end: 10.45, wordTimes: [{ location: 0, length: 1, start: 10, end: 10.2 }, { location: 1, length: 1, start: 10.25, end: 10.45 }] }],
          unreflected: [],
          held: [],
          intervals,
          previewLabel: (slot) => (slot === 0 ? "相手 A" : "相手 B"),
        });
      return { f1: build([]), f2: build(slots) };
    };
    const both = [{ slot: 0, start: words[0][1], end: words[0][2] }, { slot: 1, start: words[1][1], end: words[1][2] }];
    const look = (state: CaptionState, at: number) => view(state, at).map((b) => [nameOf(b), b.text, b.nameState]);

    it("[SCN-C3-P1] 待ちの間にラベルが届けば、2 人の語は別の吹き出しになる", () => {
      const { f1, f2 } = board(both);
      expect(f2.map((b) => b.splitFrom)).toEqual([undefined, f1[0]!.id]);
      let state = receiveCaptions(createCaptionState(), f1, 0);
      state = receiveCaptions(state, f2, 100);

      expect(look(state, 100)).toEqual([["相手 A", "あ", "provisional"], ["相手 B", "い", "provisional"]]);
      expect(look(state, 700)).toEqual([["相手 A", "あ", "provisional"], ["相手 B", "い", "provisional"]]);
    });

    it("[SCN-C3-P2] 待ちの後にラベルが届いても、表示した文字は移らない", () => {
      const { f1, f2 } = board(both);
      let state = receiveCaptions(createCaptionState(), f1, 0);
      const shown = view(state, WAIT);
      state = receiveCaptions(state, f2, WAIT + 100);

      expect(shown.map((b) => [nameOf(b), b.text])).toEqual([["相手", "あい"]]);
      expect(look(state, WAIT + 100)).toEqual([["相手 A", "あい", "provisional"]]);
      expect(view(state, WAIT + 100).map((b) => b.id)).toEqual(shown.map((b) => b.id));
    });

    it("[SCN-C3-N3] 分けた吹き出しがラベルなしのままなら、最初に受けた時刻から待ちの上限で前の吹き出しに続く", () => {
      const { f1, f2 } = board([both[0]!]);
      let state = receiveCaptions(createCaptionState(), f1, 0);
      state = receiveCaptions(state, f2, 100);

      expect(look(state, WAIT - 1)).toEqual([["相手 A", "あ", "provisional"]]);
      expect(look(state, WAIT)).toEqual([["相手 A", "あい", "provisional"]]);
      expect(nextCaptionDeadline(state)).toBe(WAIT);
    });

    it("[SCN-C3-N4] もとの吹き出しを知らない状態では、splitFrom を無視する", () => {
      const { f2 } = board(both);
      const state = receiveCaptions(createCaptionState(), f2, 0);

      expect(look(state, 0)).toEqual([["相手 A", "あ", "provisional"], ["相手 B", "い", "provisional"]]);
    });
  });

  describe("ラベル付きで出た吹き出しが「なし」に戻る", () => {
    it("待ちの上限より後に「仮 → なし」を受けても、同じ吹き出しが文字そのままで出続け、名前は「相手」になる", () => {
      let state = receiveCaptions(createCaptionState(), [named("x", "相手 A", "仮", { text: "こんにちは" })], 0);
      state = receiveCaptions(state, [bubble("x", { text: "こんにちは" })], 1000);

      expect(view(state, 1000).map((b) => [b.id, nameOf(b), b.text])).toEqual([["x", "相手", "こんにちは"]]);
    });

    it("待ちの上限より前に「仮 → なし」を受けても、直前の吹き出しへ続けられず、独立した吹き出しのまま出続ける", () => {
      const first = named("a", "相手 A", "確定", { start: 1, end: 3, text: "こんにちは" });
      const x = { start: 3.1, end: 4, text: "ありがとう" };
      let state = receiveCaptions(createCaptionState(), [first, named("x", "相手 B", "仮", x)], 0);
      state = receiveCaptions(state, [first, bubble("x", x)], 300);

      expect(view(state, 700).map((b) => [b.id, nameOf(b), b.text])).toEqual([["a", "相手 A", "こんにちは"], ["x", "相手", "ありがとう"]]);
    });

    it("最初から「なし」で受けた吹き出しは、待ちの上限まで出ない", () => {
      const state = receiveCaptions(createCaptionState(), [bubble("x")], 0);

      expect(view(state, WAIT - 1)).toEqual([]);
      expect(view(state, WAIT)).toHaveLength(1);
    });
  });

  describe("ラベルが仮から替わる（同じ状態の上で）", () => {
    it("仮 A → 仮 B に替わっても、同じ吹き出しのまま名前だけが替わる。文字は動かない", () => {
      let state = receiveCaptions(createCaptionState(), [named("a", "相手 A", "仮", { text: "こんにちは" })], 0);
      const before = view(state, 10)[0]!;
      state = receiveCaptions(state, [named("a", "相手 B", "仮", { text: "こんにちは" })], 200);

      const after = view(state, 200);

      expect(after.map((b) => [b.id, nameOf(b), b.text])).toEqual([["a", "相手 B", "こんにちは"]]);
      expect(after[0]!.colorIndex).not.toBe(before.colorIndex);
    });
  });
});

describe("slideDeltas（動きを除いた位置の差）", () => {
  it("前の位置と今の位置の差だけを、前から今へ戻す向きの値で返す。動かない吹き出しは含めない", () => {
    const { moved, entered } = slideDeltas(new Map([["a", 100], ["b", 150], ["c", 200]]), new Map([["a", 50], ["b", 100], ["c", 200]]));

    expect([...moved]).toEqual([["a", 50], ["b", 50]]);
    expect(entered).toEqual([]);
  });

  it("新しく現れた吹き出しは entered に入り、動きの差には入らない。消えた吹き出しは無視する", () => {
    const { moved, entered } = slideDeltas(new Map([["a", 100], ["gone", 150]]), new Map([["a", 50], ["c", 150]]));

    expect([...moved]).toEqual([["a", 50]]);
    expect(entered).toEqual(["c"]);
  });

  it("差は渡された位置だけで決まる（動いている途中の見かけの位置は入らない）。同じ位置を渡し続ければ、差は空のまま", () => {
    const tops = new Map([["a", 50], ["b", 100]]);
    const first = slideDeltas(tops, tops);

    expect([...first.moved]).toEqual([]);
    expect(first.entered).toEqual([]);
  });

  it("CAPTION_SLIDE_MS は正の数", () => {
    expect(CAPTION_SLIDE_MS).toBeGreaterThan(0);
  });
});

// Issue #1022: 実際の送信側（createSpeakingRelay）が送ったフレームを、送った時刻に受けて表示する。
// 送らなかった比較（speaker-settled）が盤の状態を進めて、表示前の文字が別の吹き出しへ移る不具合の回帰。時計は TestClock
describe("送信側の間引きを通した字幕（実際の relay → receiveCaptions → displayBubbles）", () => {
  const WAIT = CAPTION_LABEL_WAIT_MS;
  const parts = [["あ", 10, 10.2], ["い", 10.25, 10.45], ["う", 10.5, 10.7]] as const;
  const slots = [{ slot: 0, start: 10, end: 10.2 }, { slot: 1, start: 10.25, end: 10.45 }, { slot: 2, start: 10.5, end: 10.7 }];
  const labels = ["相手 A", "相手 B", "相手 C"];
  const nameOf = (b: DisplayBubble) => Option.getOrUndefined(b.name);
  const look = (state: CaptionState, now: number) => displayBubbles(advanceCaptions(state, now), now).map((b) => [nameOf(b), b.text, b.nameState]);

  const partialOf = (count: number): HelperPartial => {
    const used = parts.slice(0, count);
    return {
      track: "相手",
      duplicate: false,
      text: used.map(([t]) => t).join(""),
      start: 10,
      end: used.at(-1)![2],
      wordTimes: used.map(([t, start, end], i) => ({ location: i, length: t.length, start, end })),
    };
  };

  // relay を TestClock で動かし、送ったフレームを送った時刻とともに記録する。body は t（相対ミリ秒）まで進める操作つき
  const scenario = (body: (h: Harness) => Effect.Effect<void>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sent: { at: number; frame: CaptionsFrame }[] = [];
          let intervals: readonly Segment[] = [];
          const relay = yield* createSpeakingRelay({
            context: Effect.sync(() => ({ unreflected: [], held: [], intervals, previewLabel: (slot: number) => labels[slot] ?? "相手 Z" })),
            send: (frame) => Clock.currentTimeMillis.pipe(Effect.map((at) => void sent.push({ at, frame }))),
          });
          const goto = (t: number) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => TestClock.adjust(t - now)));
          const settled = (t: number, next: readonly Segment[]) =>
            Effect.gen(function* () {
              yield* goto(t);
              intervals = next;
              yield* relay.speaker({ type: "speaker-settled", track: "相手", to: 11 });
            });
          const partial = (t: number, count: number) => Effect.andThen(goto(t), relay.partial(partialOf(count)));
          const stateAt = (until: number) => sent.filter((s) => s.at <= until).reduce((state, s) => receiveCaptions(state, s.frame.bubbles, s.at), createCaptionState());
          yield* body({ sent, goto, settled, partial, stateAt, setIntervals: (next) => void (intervals = next) });
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  type Harness = {
    sent: { at: number; frame: CaptionsFrame }[];
    goto: (t: number) => Effect.Effect<void>;
    settled: (t: number, next: readonly Segment[]) => Effect.Effect<void>;
    partial: (t: number, count: number) => Effect.Effect<void>;
    stateAt: (until: number) => CaptionState;
    setIntervals: (next: readonly Segment[]) => void;
  };

  it("[SCN-C4-2-P1] 間引きの間に区間が 2 回変わっても、表示前の 2 人の語は別の吹き出しになる", () =>
    scenario((h) =>
      Effect.gen(function* () {
        yield* h.partial(0, 2);
        const f1 = h.sent[0]!.frame.bubbles;
        expect(f1.map((b) => [b.label, b.text])).toEqual([["なし", "あい"]]);
        yield* h.settled(100, [{ slot: 0, start: 10, end: 10.45 }]);
        yield* h.settled(200, [slots[0]!, slots[1]!]);
        yield* h.goto(300);

        expect(h.sent.map((s) => s.at)).toEqual([0, 300]);
        expect(h.sent[1]!.frame.bubbles.map((b) => [b.id === f1[0]!.id, b.speaker, b.text, b.splitFrom])).toEqual([
          [true, "相手 A", "あ", undefined],
          [false, "相手 B", "い", f1[0]!.id],
        ]);
        const state = h.stateAt(300);
        expect(look(state, 300)).toEqual([["相手 A", "あ", "provisional"], ["相手 B", "い", "provisional"]]);
        expect(look(state, 700)).toEqual([["相手 A", "あ", "provisional"], ["相手 B", "い", "provisional"]]);
      }),
    ));

  it("[SCN-C4-2-N1] ラベル付きのフレームを実際に送った後は、区間が割れても分けない", () =>
    scenario((h) =>
      Effect.gen(function* () {
        h.setIntervals([{ slot: 0, start: 10, end: 10.45 }]);
        yield* h.partial(0, 2);
        const f1 = h.sent[0]!.frame.bubbles;
        expect(f1.map((b) => [b.label, b.speaker, b.text])).toEqual([["仮", "相手 A", "あい"]]);
        yield* h.settled(300, [slots[0]!, slots[1]!]);
        expect(h.sent).toHaveLength(1); // 字幕が変わらないので送らない
        yield* h.partial(600, 2);

        expect(h.sent.map((s) => s.at)).toEqual([0, 600]);
        expect(h.sent[1]!.frame.bubbles.map((b) => [b.id, b.text, b.splitFrom])).toEqual([[f1[0]!.id, "あい", undefined]]);
      }),
    ));

  it("[SCN-C4-2-P2] 送っていない比較を 2 回挟んでも、表示した文字は移らない", () =>
    scenario((h) =>
      Effect.gen(function* () {
        yield* h.partial(0, 3);
        yield* h.partial(600, 3);
        const x = h.sent[0]!.frame.bubbles[0]!.id;
        expect(look(h.stateAt(600), 600)).toEqual([["相手", "あいう", "settled"]]);
        yield* h.settled(650, [slots[0]!]);
        yield* h.settled(700, slots);
        yield* h.goto(900);

        expect(h.sent.map((s) => s.at)).toEqual([0, 600, 900]);
        expect(h.sent[2]!.frame.bubbles.map((b) => b.splitFrom ?? x)).toEqual([x, x, x]);
        for (const at of [900, 1000]) expect(look(h.stateAt(at), at)).toEqual([["相手 A", "あいう", "provisional"]]);
        expect(displayBubbles(advanceCaptions(h.stateAt(900), 900), 900).map((b) => b.id)).toEqual([x]);
      }),
    ));

  it("[SCN-C4-2-P3] 1 段ずつ分けたフレームを毎回送っても、表示した文字は移らない", () =>
    scenario((h) =>
      Effect.gen(function* () {
        yield* h.partial(0, 3);
        const x = h.sent[0]!.frame.bubbles[0]!.id;
        expect(look(h.stateAt(600), 600)).toEqual([["相手", "あいう", "settled"]]);
        yield* h.settled(650, [slots[0]!]);
        yield* h.settled(700, slots);
        yield* h.goto(950);

        expect(h.sent.map((s) => s.at)).toEqual([0, 650, 950]);
        const [first, second, third] = h.sent[2]!.frame.bubbles;
        expect([first!.id, second!.splitFrom, third!.splitFrom === second!.id, first!.text, second!.text, third!.text]).toEqual([x, x, true, "あ", "い", "う"]);
        for (const at of [950, 1000]) expect(look(h.stateAt(at), at)).toEqual([["相手 A", "あいう", "provisional"]]);
      }),
    ));
});

// Issue #1026: 話者の名前。名前はラベルに付く表示名で、表示（名前の欄の文字）だけを変える。
// 名前の表（ラベル → 名前）は displayBubbles の第 3 引数。受けた状態（receiveCaptions）には名前を入れず、表示のたびに表から導く。
// 色・同じ人が続くときの省略・押せる欄かどうか（label）は、名前ではなくラベルで決める
describe("会議中の字幕: 話者の名前（Issue #1026）", () => {
  const bubble = (id: string, extra: Partial<CaptionBubble> = {}): CaptionBubble => ({ id, track: "相手", label: "確定", speaker: "相手 A", start: 0, end: 1, text: id, settledLength: (extra.text ?? id).length, ...extra });
  const from = (speaker: string, id: string, start: number, extra: Partial<CaptionBubble> = {}) => bubble(id, { speaker, start, end: start + 1, ...extra });
  const mine = (id: string, start: number) => bubble(id, { track: "自分", speaker: "自分", start, end: start + 1 });
  const nameOf = (b: DisplayBubble) => Option.getOrUndefined(b.name);
  const labelOf = (b: DisplayBubble) => Option.getOrUndefined(b.label);

  it("同じ状態のまま名前の表だけを替えると、受けた時点からあった吹き出しの名前の欄も名前になる（それまでの分も含む）。名前の無いラベルはラベルのまま", () => {
    const state = receiveCaptions(createCaptionState(), [from("相手 A", "a", 1), from("相手 B", "b", 2)], 0);

    expect(displayBubbles(state, 0, {}).map(nameOf)).toEqual(["相手 A", "相手 B"]);
    expect(displayBubbles(state, 0, { "相手 B": "田中" }).map(nameOf)).toEqual(["相手 A", "田中"]);
    expect(displayBubbles(state, 0, { "相手 A": "佐藤", "相手 B": "田中" }).map(nameOf)).toEqual(["佐藤", "田中"]);
  });

  it("同じ名前が 2 つのラベルに付いても、まとめない: 別のラベルの吹き出しは両方とも名前を出し（省かない）、色はラベルごとに別のまま", () => {
    const state = receiveCaptions(createCaptionState(), [from("相手 A", "a", 1), from("相手 B", "b", 2)], 0);
    const names = { "相手 A": "田中", "相手 B": "田中" };

    const named = displayBubbles(state, 0, names);
    const plain = displayBubbles(state, 0, {});

    expect(named.map(nameOf)).toEqual(["田中", "田中"]);
    expect(named.map(labelOf)).toEqual(["相手 A", "相手 B"]);
    expect(named[0]!.colorIndex).not.toBe(named[1]!.colorIndex);
    expect(named.map((b) => b.colorIndex)).toEqual(plain.map((b) => b.colorIndex)); // 名前が付いても色は変わらない
  });

  // 見せる吹き出しは末尾の CAPTION_VISIBLE_BUBBLES（3）個。省略は見せる吹き出しの並びの中で決まるので、3 個ずつ見る
  it("同じラベルが続くときの名前の省略は、名前が付いても変わらない（2 つ目以降は省く）。間に別のラベルが入れば、また出す", () => {
    const names = { "相手 A": "田中" };
    const continued = receiveCaptions(createCaptionState(), [from("相手 A", "a1", 1), from("相手 A", "a2", 2), from("相手 B", "b", 3)], 0);
    const interleaved = receiveCaptions(createCaptionState(), [from("相手 A", "a1", 1), from("相手 B", "b", 2), from("相手 A", "a3", 3)], 0);

    expect(displayBubbles(continued, 0, names).map(nameOf)).toEqual(["田中", undefined, "相手 B"]);
    expect(displayBubbles(interleaved, 0, names).map(nameOf)).toEqual(["田中", "相手 B", "田中"]);
  });

  it("名前を付けられる欄（押せる欄）は、名前を出している確定の相手のラベルの欄だけ。値はサーバーに送るラベル（名前ではない）", () => {
    const state = receiveCaptions(createCaptionState(), [from("相手 A", "a1", 1), from("相手 A", "a2", 2), mine("m", 3)], 0);
    const next = receiveCaptions(createCaptionState(), [mine("m", 3), from("相手 B", "b", 4)], 0);

    expect(displayBubbles(state, 0, {}).map((b) => [b.id, labelOf(b)])).toEqual([["a1", "相手 A"], ["a2", undefined], ["m", undefined]]); // 同じ人が続く欄・自分の欄は押せない
    expect(displayBubbles(next, 0, { "相手 B": "田中" }).map((b) => [b.id, labelOf(b)])).toEqual([["m", undefined], ["b", "相手 B"]]); // 名前が付いても、値はラベル
  });

  it("仮のラベルの欄・3 秒たって「相手」だけになった欄・話者なしの「相手」の欄は押せない（付ける先のラベルが無い・まだ振っていないかもしれない）", () => {
    const provisional = receiveCaptions(createCaptionState(), [from("相手 B", "p", 1, { label: "仮" })], 0);
    expect(displayBubbles(provisional, 0, {}).map(labelOf)).toEqual([undefined]);
    expect(displayBubbles(provisional, CAPTION_PROVISIONAL_LIMIT_MS, {}).map((b) => [nameOf(b), labelOf(b)])).toEqual([["相手", undefined]]);

    const unlabeled = receiveCaptions(createCaptionState(), [bubble("n", { label: "なし", speaker: undefined, start: 1 })], 0);
    expect(displayBubbles(advanceCaptions(unlabeled, CAPTION_LABEL_WAIT_MS), CAPTION_LABEL_WAIT_MS, { "相手": "誰か" }).map((b) => [nameOf(b), labelOf(b)])).toEqual([["相手", undefined]]);
  });

  it("自分には名前が付かない（表に自分があっても、自分の欄は空のまま・押せない）", () => {
    const state = receiveCaptions(createCaptionState(), [mine("m", 1)], 0);

    const [only] = displayBubbles(state, 0, { "自分": "誰か" });

    expect([nameOf(only!), labelOf(only!), only!.side]).toEqual([undefined, undefined, "right"]);
  });
});
