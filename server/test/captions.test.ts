import { describe, expect, it } from "vitest";
import { continuesAfter, createCaptionBoard, createRemarkSettler, SETTLE_QUIET_MS, type CaptionBubble, type HelperPartial, type Replacement, type SettledRemark, type Track, type WordTime } from "../src/core/index.ts";

// Issue #1022: 字幕のフレーム（CaptionsFrame）の吹き出しを作る盤。
// 盤は純粋（時計もタイマーも持たない。ADR 0003）。盤への入力は「いまの状態」の全体で、盤は送った吹き出しの境目と id を覚える。
// 語の話者は、区間（確定区間か仮の区間）と最も長く重なる枠の、覗いたラベル（previewLabel）から決める。

type Part = readonly [text: string, start: number, end: number];
const build = (parts: readonly Part[]) => {
  let location = 0;
  const wordTimes: WordTime[] = parts.map(([text, start, end]) => {
    const word = { location, length: text.length, start, end };
    location += text.length;
    return word;
  });
  return { text: parts.map(([text]) => text).join(""), start: parts[0]![1], end: parts.at(-1)![2], wordTimes };
};

const partialOf = (parts: readonly Part[], track: Track = "相手", duplicate = false): HelperPartial => ({ track, duplicate, ...build(parts) });
const remarkOf = (parts: readonly Part[], extra: { speaker?: string; track?: Track } = {}): SettledRemark => ({ track: extra.track ?? "相手", ...build(parts), ...(extra.speaker === undefined ? {} : { speaker: extra.speaker }) });

type Interval = { slot: number; start: number; end: number };
const LABELS: Record<number, string> = { 0: "相手 A", 1: "相手 B", 2: "相手 C", 3: "相手 A", 4: "相手 B" };
const previewLabel = (slot: number): string | undefined => LABELS[slot] ?? "相手 Z";

type Context = {
  partials?: readonly HelperPartial[];
  unreflected?: readonly { id: string; remark: SettledRemark; replacements?: readonly Replacement[] }[];
  held?: readonly SettledRemark[];
  intervals?: readonly Interval[];
};
const frameOf = (board: ReturnType<typeof createCaptionBoard>, context: Context): CaptionBubble[] =>
  board.build({ partials: [], unreflected: [], held: [], intervals: [], previewLabel, ...context });

const summary = (bubbles: readonly CaptionBubble[]) => bubbles.map((b) => [b.track, b.speaker, b.label, b.text]);

describe("途中結果から吹き出しを作る", () => {
  it("仮の区間と重なる途中結果は、仮のラベルつきの吹き出しになる。start / end は語の区間から、文字は途中結果のまま", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, { partials: [partialOf([["こんにちは", 10, 12]])], intervals: [{ slot: 0, start: 10, end: 12 }] });

    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ track: "相手", speaker: "相手 A", label: "仮", start: 10, end: 12, text: "こんにちは" });
  });

  it("区間と重なる語が無ければ、話者なし・ラベルは「なし」になる", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, { partials: [partialOf([["こんにちは", 10, 12]])] });

    expect(summary(bubbles)).toEqual([["相手", undefined, "なし", "こんにちは"]]);
  });

  it("覗いたラベルが無い枠（混入で戻した枠）と重なる語は、話者なし・ラベルは「なし」になる", () => {
    const board = createCaptionBoard();
    const reverted = (slot: number): string | undefined => (slot === 1 ? undefined : previewLabel(slot));

    const bubbles = board.build({
      partials: [partialOf([["こんにちは、", 10, 12], ["ありがとう", 12, 14]])],
      unreflected: [],
      held: [],
      intervals: [{ slot: 0, start: 10, end: 12 }, { slot: 1, start: 12, end: 14 }],
      previewLabel: reverted,
    });

    expect(summary(bubbles)).toEqual([["相手", "相手 A", "仮", "こんにちは、"], ["相手", undefined, "なし", "ありがとう"]]);
  });

  it("保留中の発言の区間から予想する仮のラベルも、覗いたラベルが無い枠では話者なし・「なし」になる", () => {
    const board = createCaptionBoard();

    const bubbles = board.build({
      partials: [],
      unreflected: [],
      held: [remarkOf([["あ", 10, 12]])],
      intervals: [{ slot: 1, start: 10, end: 12 }],
      previewLabel: () => undefined,
    });

    expect(summary(bubbles)).toEqual([["相手", undefined, "なし", "あ"]]);
  });

  it("話者が替わる語で吹き出しが分かれ、1 つの吹き出しに 2 人の話が混ざらない", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, {
      partials: [partialOf([["こんにちは、", 10, 12], ["ありがとう", 12, 14]])],
      intervals: [{ slot: 0, start: 10, end: 12 }, { slot: 1, start: 12, end: 14 }],
    });

    expect(summary(bubbles)).toEqual([["相手", "相手 A", "仮", "こんにちは、"], ["相手", "相手 B", "仮", "ありがとう"]]);
    expect(bubbles[1]!.start).toBe(12);
  });

  it("誰もいない語を前後の話者に寄せない（寄せると、ラベルの無い文字が直前の吹き出しに入り、後で移ることになる）", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, {
      partials: [partialOf([["あ", 10, 12], ["い", 12, 14], ["う", 14, 16]])],
      intervals: [{ slot: 0, start: 10, end: 12 }, { slot: 1, start: 14, end: 16 }],
    });

    expect(summary(bubbles)).toEqual([["相手", "相手 A", "仮", "あ"], ["相手", undefined, "なし", "い"], ["相手", "相手 B", "仮", "う"]]);
  });

  it("同じ枠の語が続けば 1 つの吹き出しのまま", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, {
      partials: [partialOf([["あ", 10, 12], ["い", 12, 14]])],
      intervals: [{ slot: 0, start: 10, end: 14 }],
    });

    expect(summary(bubbles)).toEqual([["相手", "相手 A", "仮", "あい"]]);
  });

  it("重複の印つきの途中結果は出さない", () => {
    const board = createCaptionBoard();

    expect(frameOf(board, { partials: [partialOf([["あ", 10, 12]], "相手", true)], intervals: [{ slot: 0, start: 10, end: 12 }] })).toEqual([]);
  });

  it("自分の途中結果は、話者「自分」・ラベル「確定」の吹き出しになる", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, { partials: [partialOf([["担当を分けましょう", 9, 11]], "自分")] });

    expect(summary(bubbles)).toEqual([["自分", "自分", "確定", "担当を分けましょう"]]);
  });

  it("トラックをまたいで、話し始めの順に 1 列に並べる", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, {
      partials: [partialOf([["自分の話", 9, 11]], "自分"), partialOf([["相手の話", 8, 8.5]])],
      intervals: [{ slot: 0, start: 8, end: 8.5 }],
    });

    expect(bubbles.map((b) => [b.track, b.text])).toEqual([["相手", "相手の話"], ["自分", "自分の話"]]);
  });
});

describe("発言（未反映・保留）から吹き出しを作る", () => {
  it("出た発言は、話者があれば「確定」、無ければ「なし」。自分は「確定」", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, {
      unreflected: [
        { id: "r1", remark: remarkOf([["あ", 1, 2]], { speaker: "相手 A" }) },
        { id: "r2", remark: remarkOf([["い", 3, 4]]) },
        { id: "r3", remark: remarkOf([["う", 5, 6]], { track: "自分", speaker: "自分" }) },
      ],
    });

    expect(summary(bubbles)).toEqual([["相手", "相手 A", "確定", "あ"], ["相手", undefined, "なし", "い"], ["自分", "自分", "確定", "う"]]);
  });

  it("保留中の発言（話者が決まる前）は、区間があれば仮のラベルで出る", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, { held: [remarkOf([["あ", 10, 12]])], intervals: [{ slot: 1, start: 10, end: 12 }] });

    expect(summary(bubbles)).toEqual([["相手", "相手 B", "仮", "あ"]]);
  });

  it("反映されて未反映の発言から消えれば、吹き出しも消える", () => {
    const board = createCaptionBoard();
    const unreflected = [{ id: "r1", remark: remarkOf([["あ", 1, 2]], { speaker: "相手 A" }) }];
    expect(frameOf(board, { unreflected })).toHaveLength(1);

    expect(frameOf(board, { unreflected: [] })).toEqual([]);
  });
});

describe("吹き出しの id（同じ盤の上で追う）", () => {
  it("id は吹き出しごとに別で、発言の id（r…）の名前空間を使わない", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, {
      partials: [partialOf([["あ", 10, 12], ["い", 12, 14]])],
      intervals: [{ slot: 0, start: 10, end: 12 }, { slot: 1, start: 12, end: 14 }],
      unreflected: [{ id: "r12", remark: remarkOf([["う", 1, 2]]) }],
    });

    const ids = bubbles.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toMatch(/^r\d+$/);
  });

  it("文字が伸びても、同じ吹き出しの id は変わらない", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf([["こん", 10, 11]])], intervals: [{ slot: 0, start: 10, end: 11 }] });

    const next = frameOf(board, { partials: [partialOf([["こん", 10, 11], ["にちは", 11, 12]])], intervals: [{ slot: 0, start: 10, end: 12 }] });

    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe(first[0]!.id);
    expect(next[0]!.text).toBe("こんにちは");
  });

  it("途中結果が発言として出ても（仮 → 確定）、同じ吹き出しのまま id と文字が変わらない", () => {
    const board = createCaptionBoard();
    const parts: Part[] = [["こんにちは", 10, 12]];
    const provisional = frameOf(board, { partials: [partialOf(parts)], intervals: [{ slot: 0, start: 10, end: 12 }] });

    const settled = frameOf(board, { unreflected: [{ id: "r5", remark: remarkOf(parts, { speaker: "相手 A" }) }], intervals: [{ slot: 0, start: 10, end: 12 }] });

    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: provisional[0]!.id, text: "こんにちは", speaker: "相手 A", label: "確定" });
  });
});

describe("ラベルが仮から替わっても、出た文字を別の吹き出しへ移さない", () => {
  it("仮 A → 仮 B に替わると、同じ id・同じ文字のまま、話者だけ B になる", () => {
    const board = createCaptionBoard();
    const parts: Part[] = [["こんにちは", 10, 12]];
    const first = frameOf(board, { partials: [partialOf(parts)], intervals: [{ slot: 0, start: 10, end: 12 }] });
    expect(first[0]).toMatchObject({ speaker: "相手 A", label: "仮" });

    const next = frameOf(board, { partials: [partialOf(parts)], intervals: [{ slot: 1, start: 10, end: 12 }] });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: first[0]!.id, text: "こんにちは", speaker: "相手 B", label: "仮" });
  });

  it("出た吹き出しは、区間が 2 人に割れても分け直さない（文字は同じ吹き出しに残る）", () => {
    const board = createCaptionBoard();
    const parts: Part[] = [["あ", 10, 12], ["い", 12, 14]];
    const first = frameOf(board, { partials: [partialOf(parts)], intervals: [{ slot: 0, start: 10, end: 14 }] });

    const next = frameOf(board, { partials: [partialOf(parts)], intervals: [{ slot: 0, start: 10, end: 12 }, { slot: 1, start: 12, end: 14 }] });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: first[0]!.id, text: "あい" });
  });

  it("後ろに別の話者の語が足されると、末尾に新しい吹き出しができ、前の吹き出しの文字は動かない", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf([["あ", 10, 12]])], intervals: [{ slot: 0, start: 10, end: 12 }] });

    const next = frameOf(board, {
      partials: [partialOf([["あ", 10, 12], ["い", 12, 14]])],
      intervals: [{ slot: 0, start: 10, end: 12 }, { slot: 1, start: 12, end: 14 }],
    });

    expect(next.map((b) => [b.text, b.speaker])).toEqual([["あ", "相手 A"], ["い", "相手 B"]]);
    expect(next[0]!.id).toBe(first[0]!.id);
    expect(next[1]!.id).not.toBe(first[0]!.id);
  });

  it("後の吹き出しの話者が前の吹き出しと同じになっても、つながない", () => {
    const board = createCaptionBoard();
    const parts: Part[] = [["あ", 10, 12], ["い", 12, 14]];
    const split = frameOf(board, { partials: [partialOf(parts)], intervals: [{ slot: 0, start: 10, end: 12 }, { slot: 1, start: 12, end: 14 }] });
    expect(split).toHaveLength(2);

    const next = frameOf(board, { partials: [partialOf(parts)], intervals: [{ slot: 0, start: 10, end: 12 }, { slot: 3, start: 12, end: 14 }] }); // slot 3 も「相手 A」

    expect(next.map((b) => [b.id, b.text, b.speaker])).toEqual([[split[0]!.id, "あ", "相手 A"], [split[1]!.id, "い", "相手 A"]]);
  });
});

describe("近い開始時刻の別話者の語", () => {
  it("0.4 秒しか離れていない別話者の語も、作り直しても分かれたまま・id も文字も動かない", () => {
    const board = createCaptionBoard();
    const parts: Part[] = [["あ", 10, 10.2], ["い", 10.4, 10.6]];
    const intervals = [{ slot: 0, start: 10, end: 10.2 }, { slot: 1, start: 10.4, end: 10.6 }];
    const first = frameOf(board, { partials: [partialOf(parts)], intervals });
    expect(first).toHaveLength(2);

    const again = frameOf(board, { partials: [partialOf(parts)], intervals });

    expect(again.map((b) => [b.id, b.text, b.speaker])).toEqual(first.map((b) => [b.id, b.text, b.speaker]));
  });
});

describe("発言への移行", () => {
  const parts: Part[] = [["こんにちは、", 10, 12], ["ありがとう", 12, 14]];
  const intervals = [{ slot: 0, start: 10, end: 12 }, { slot: 1, start: 12, end: 14 }];

  it("保留中の発言と元の途中結果が同時にあっても、同じ文字を二重に出さない", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, { partials: [partialOf(parts)], held: [remarkOf(parts)], intervals });

    expect(summary(bubbles)).toEqual([["相手", "相手 A", "仮", "こんにちは、"], ["相手", "相手 B", "仮", "ありがとう"]]);
  });

  it("保留中の発言の後ろに続く途中結果の語は残る", () => {
    const board = createCaptionBoard();
    const next: Part[] = [["つぎ", 20, 21]];

    const bubbles = frameOf(board, { partials: [partialOf([...parts, ...next])], held: [remarkOf(parts)], intervals });

    expect(bubbles.map((b) => b.text)).toEqual(["こんにちは、", "ありがとう", "つぎ"]);
  });

  it("仮 A・仮 B に分かれて出た途中結果が保留中の発言・出た発言になっても、文字は同じ吹き出しに残り、id は動かない", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf(parts)], intervals });
    expect(first).toHaveLength(2);

    const held = frameOf(board, { held: [remarkOf(parts)], intervals });
    const settled = frameOf(board, { unreflected: [{ id: "r1", remark: remarkOf(parts, { speaker: "相手 A" }) }] });

    expect(held.map((b) => [b.id, b.text])).toEqual(first.map((b) => [b.id, b.text]));
    expect(settled.map((b) => [b.id, b.text])).toEqual(first.map((b) => [b.id, b.text]));
  });
});

describe("話者の手がかりが無い語の間（continuesAfter）", () => {
  it("区間が無い途中結果の語が CAPTION_CONTINUE_GAP_S 以上空いていれば、id を替えて新しい吹き出しにする。出した吹き出しの id と文字は動かない", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf([["あ", 10, 11]])] });
    expect(first.map((b) => b.text)).toEqual(["あ"]);
    const firstId = first[0]!.id;

    const bubbles = frameOf(board, { partials: [partialOf([["あ", 10, 11], ["い", 12, 13]])] });

    expect(bubbles.map((b) => [b.label, b.text])).toEqual([["なし", "あ"], ["なし", "い"]]);
    expect(bubbles[0]!.id).toBe(firstId);
    expect(bubbles[1]!.id).not.toBe(firstId);
  });

  it("間が CAPTION_CONTINUE_GAP_S 未満なら 1 つの吹き出しのまま", () => {
    const board = createCaptionBoard();
    const firstId = frameOf(board, { partials: [partialOf([["あ", 10, 11]])] })[0]!.id;

    const bubbles = frameOf(board, { partials: [partialOf([["あ", 10, 11], ["い", 11.1, 12]])] });

    expect(bubbles.map((b) => [b.id, b.text])).toEqual([[firstId, "あい"]]);
  });

  it("間がちょうど CAPTION_CONTINUE_GAP_S なら分ける", () => {
    expect(continuesAfter(11, 11.3)).toBe(false);
    expect(continuesAfter(11, 11.29)).toBe(true);
  });
});

describe("区間なしで開いた境目を、区間が届いたときに話者で分ける（splitFrom）", () => {
  const words: readonly Part[] = [["あ", 10, 10.2], ["い", 10.25, 10.45]];
  const split = [{ slot: 0, start: 10, end: 10.2 }, { slot: 1, start: 10.25, end: 10.45 }];

  it("[SCN-C3-P1] 区間なしで送った 1 つの吹き出しは、次のフレームで話者が分かれると、最初の語が id を保ち、2 つ目以降は splitFrom つきの新しい吹き出しになる", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf(words)] });
    expect(first.map((b) => [b.label, b.text])).toEqual([["なし", "あい"]]);

    const bubbles = frameOf(board, { partials: [partialOf(words)], intervals: split });

    expect(bubbles.map((b) => [b.id === first[0]!.id, b.speaker, b.label, b.text, b.splitFrom])).toEqual([
      [true, "相手 A", "仮", "あ", undefined],
      [false, "相手 B", "仮", "い", first[0]!.id],
    ]);
  });

  it("[SCN-C3-N1] ラベル付きで送った吹き出しは、区間が割れても分けない", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf(words)], intervals: [{ slot: 0, start: 10, end: 10.45 }] });

    const bubbles = frameOf(board, { partials: [partialOf(words)], intervals: split });

    expect(bubbles.map((b) => [b.id, b.text, b.splitFrom])).toEqual([[first[0]!.id, "あい", undefined]]);
  });

  it("[SCN-C3-N2] 開いた境目でも、話者が同じなら分けない", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf(words)] });

    const bubbles = frameOf(board, { partials: [partialOf(words)], intervals: [{ slot: 0, start: 10, end: 10.45 }] });

    expect(bubbles.map((b) => [b.id, b.speaker, b.label, b.text, b.splitFrom])).toEqual([[first[0]!.id, "相手 A", "仮", "あい", undefined]]);
  });

  it("分けた後のフレームでも、新しい吹き出しの splitFrom と id は動かない", () => {
    const board = createCaptionBoard();
    frameOf(board, { partials: [partialOf(words)] });
    const first = frameOf(board, { partials: [partialOf(words)], intervals: split });

    const again = frameOf(board, { partials: [partialOf(words)], intervals: split });

    expect(again).toEqual(first);
  });
});

describe("preview（送るかを決める比較用。盤の状態を進めない）", () => {
  const words: readonly Part[] = [["あ", 10, 10.2], ["い", 10.25, 10.45]];
  const split = [{ slot: 0, start: 10, end: 10.2 }, { slot: 1, start: 10.25, end: 10.45 }];
  const whole = [{ slot: 0, start: 10, end: 10.45 }];
  const contextOf = (intervals: readonly Interval[]) => ({ partials: [partialOf(words)], unreflected: [], held: [], intervals, previewLabel });

  it("[SCN-C4-1-P1] preview は境目を閉じない。後の build で、開いた境目を話者で分けられる", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf(words)] });
    const previewed = board.preview(contextOf(whole));

    const bubbles = frameOf(board, { partials: [partialOf(words)], intervals: split });

    expect(previewed.map((b) => [b.id, b.speaker, b.label, b.text])).toEqual([[first[0]!.id, "相手 A", "仮", "あい"]]);
    expect(bubbles.map((b) => [b.id === first[0]!.id, b.speaker, b.text, b.splitFrom])).toEqual([
      [true, "相手 A", "あ", undefined],
      [false, "相手 B", "い", first[0]!.id],
    ]);
  });

  it("[SCN-C4-1-N1] 状態を確定する build の後なら、区間が割れても分けない", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf(words)] });
    frameOf(board, { partials: [partialOf(words)], intervals: whole });

    const bubbles = frameOf(board, { partials: [partialOf(words)], intervals: split });

    expect(bubbles.map((b) => [b.id, b.text, b.splitFrom])).toEqual([[first[0]!.id, "あい", undefined]]);
  });

  it("preview は id の連番も進めない（同じ入力の preview は何度でも同じ結果で、後の build の新しい id も変わらない）", () => {
    const board = createCaptionBoard();
    frameOf(board, { partials: [partialOf(words)] });
    const once = board.preview(contextOf(split));
    const twice = board.preview(contextOf(split));
    const built = frameOf(board, { partials: [partialOf(words)], intervals: split });

    expect(twice).toEqual(once);
    expect(built).toEqual(once);
  });
});

describe("補正つきの未反映の発言（replacements）の字幕用の本文と位置", () => {
  const replacement = (location: number, length: number, surface: string): Replacement => ({ location, length, span: "", surface, score: 1 });

  it("表示済みの 2 つの吹き出しの境目をまたぐ置き換えは、境目で補正後の文字を分ける。送った吹き出しの id は残る", () => {
    const board = createCaptionBoard();
    const intervals = [{ slot: 0, start: 10, end: 11 }, { slot: 1, start: 11, end: 12 }];
    const shown = frameOf(board, { partials: [partialOf([["野", 10, 11], ["野村", 11, 12]])], intervals });
    expect(shown.map((b) => b.text)).toEqual(["野", "野村"]);

    const bubbles = frameOf(board, {
      unreflected: [{ id: "r1", remark: remarkOf([["野", 10, 11], ["野村", 11, 12]], { speaker: "相手 A" }), replacements: [replacement(0, 3, "野々村")] }],
      intervals,
    });

    expect(bubbles.map((b) => [b.id, b.text])).toEqual([[shown[0]!.id, "野"], [shown[1]!.id, "々村"]]);
  });

  it("同じ吹き出しに属する run だけなら、補正後の本文を出す（補正前の文字を残さない）", () => {
    const board = createCaptionBoard();
    const shown = frameOf(board, { partials: [partialOf([["意", 10, 11], ["和志", 11, 12]])], intervals: [{ slot: 0, start: 10, end: 12 }] });
    expect(shown.map((b) => b.text)).toEqual(["意和志"]);

    const bubbles = frameOf(board, {
      unreflected: [{ id: "r1", remark: remarkOf([["意", 10, 11], ["和志", 11, 12]], { speaker: "相手 A" }), replacements: [replacement(0, 3, "鰯")] }],
      intervals: [{ slot: 0, start: 10, end: 12 }],
    });

    expect(bubbles.map((b) => [b.id, b.text])).toEqual([[shown[0]!.id, "鰯"]]);
  });

  it("表示済みの境目が無ければ、補正後の本文を出す", () => {
    const board = createCaptionBoard();

    const bubbles = frameOf(board, { unreflected: [{ id: "r1", remark: remarkOf([["意", 10, 11], ["和志", 11, 12]], { speaker: "相手 A" }), replacements: [replacement(0, 3, "鰯")] }] });

    expect(bubbles.map((b) => b.text)).toEqual(["鰯"]);
  });

  it("別々の吹き出しの置き換えの文字だけの区間が表記の文字数を超える置き換えは、字幕には適用しない", () => {
    const board = createCaptionBoard();
    const intervals = [{ slot: 0, start: 10, end: 11 }, { slot: 1, start: 11, end: 12 }];
    const shown = frameOf(board, { partials: [partialOf([["意", 10, 11], ["和志", 11, 12]])], intervals });

    const bubbles = frameOf(board, {
      unreflected: [{ id: "r1", remark: remarkOf([["意", 10, 11], ["和志", 11, 12]], { speaker: "相手 A" }), replacements: [replacement(0, 3, "鰯")] }],
      intervals,
    });

    expect(bubbles.map((b) => [b.id, b.text])).toEqual([[shown[0]!.id, "意"], [shown[1]!.id, "和志"]]);
  });

  it("一度作った字幕用の本文と位置は、同じ入力の次のフレームでも変わらない", () => {
    const board = createCaptionBoard();
    const input = {
      unreflected: [{ id: "r1", remark: remarkOf([["よ", 10, 10.1], ["しの", 10.6, 10.7], ["や", 11, 11.2]]), replacements: [replacement(0, 3, "𠮷野家")] }],
    };

    const first = frameOf(board, input);
    const second = frameOf(board, input);

    expect(first.map((b) => b.text)).toEqual(["𠮷野家", "や"]);
    expect(second.map((b) => [b.id, b.text])).toEqual(first.map((b) => [b.id, b.text]));
  });
});

// Issue #1222: 発言にした後に、STT が同じ区切りを延ばした途中結果。字幕へ渡す途中結果は、settler が出した分を除いた後ろだけにする（settler.unemittedTail）。
// 盤は変えない。発言と、その後ろの途中結果は、別の吹き出しになってよい（並べると 1 回ずつ）
describe("発言になった分を除いた途中結果（settler.unemittedTail）を盤へ渡す", () => {
  // 相手の途中結果を settler へ入れ、自分の途中結果で音声の時計を 1 秒進めて、発言にする
  const settle = (settler: ReturnType<typeof createRemarkSettler>, p: HelperPartial): SettledRemark[] => [
    ...settler.partial(p),
    ...settler.partial({ track: "自分", start: 0, end: p.end + SETTLE_QUIET_MS / 1000, text: "時計", duplicate: false }),
  ];
  // 相手の吹き出しの本文（話し始めの順）
  const texts = (bubbles: readonly CaptionBubble[]) => bubbles.filter((b) => b.track === "相手").map((b) => b.text);

  it("発言「来週のリリースは」の後に、同じ区切りが「来週のリリースは金曜に」へ延びても、字幕は「来週のリリースは」「金曜に」で、同じ文字が二重に出ない", () => {
    const settler = createRemarkSettler();
    const board = createCaptionBoard();
    const [remark] = settle(settler, partialOf([["来週の", 0, 0.5], ["リリースは", 0.5, 1.2]]));
    expect(remark?.text).toBe("来週のリリースは");
    frameOf(board, { unreflected: [{ id: "r1", remark: remark! }] });

    const extended = partialOf([["来週の", 0, 0.5], ["リリースは", 0.5, 1.2], ["金曜に", 1.3, 2.0]]);
    settler.partial(extended);
    const bubbles = frameOf(board, { unreflected: [{ id: "r1", remark: remark! }], partials: [settler.unemittedTail(extended)] });

    expect(texts(bubbles)).toEqual(["来週のリリースは", "金曜に"]);
  });

  it("延びた途中結果の語の時刻が、出した分の語より揺れの幅（0.5 秒）を超えてずれていても、出した分の文字は別の吹き出しに出ない", () => {
    const settler = createRemarkSettler();
    const board = createCaptionBoard();
    const [remark] = settle(settler, partialOf([["来週の", 0, 0.5], ["リリースは", 0.5, 1.2]]));
    frameOf(board, { unreflected: [{ id: "r1", remark: remark! }] });

    const shifted = partialOf([["来週の", 0.7, 1.2], ["リリースは", 1.2, 1.9], ["金曜に", 2.0, 2.6]]);
    settler.partial(shifted);
    const bubbles = frameOf(board, { unreflected: [{ id: "r1", remark: remark! }], partials: [settler.unemittedTail(shifted)] });

    expect(texts(bubbles)).toEqual(["来週のリリースは", "金曜に"]);
  });

  it("途中結果の全部が出した分と同じなら、途中結果の吹き出しは増えず、発言の吹き出しの id と本文は変わらない", () => {
    const settler = createRemarkSettler();
    const board = createCaptionBoard();
    const [remark] = settle(settler, partialOf([["来週の", 0, 0.5], ["リリースは", 0.5, 1.2]]));
    const shown = frameOf(board, { unreflected: [{ id: "r1", remark: remark! }] });

    const same = partialOf([["来週の", 0, 0.5], ["リリースは", 0.5, 1.2]]);
    settler.partial(same);
    expect(settler.unemittedTail(same).text).toBe("");
    const bubbles = frameOf(board, { unreflected: [{ id: "r1", remark: remark! }], partials: [settler.unemittedTail(same)] });

    expect(bubbles.map((b) => [b.id, b.text])).toEqual(shown.map((b) => [b.id, b.text]));
  });

  it("頭に挿入が入った途中結果（出した本文が新しい本文の途中に現れる）は、settler が次の発言にするのと同じ位置で切った後ろだけが字幕に入る", () => {
    const settler = createRemarkSettler();
    const board = createCaptionBoard();
    const [remark] = settle(settler, partialOf([["来週の", 0, 0.5], ["リリースは", 0.5, 1.2]]));
    frameOf(board, { unreflected: [{ id: "r1", remark: remark! }] });

    const inserted = partialOf([["えっと、", 0, 0.3], ["来週の", 0.3, 0.8], ["リリースは", 0.8, 1.4], ["金曜に", 1.5, 2.2]]);
    settler.partial(inserted);
    const caption = settler.unemittedTail(inserted);
    const bubbles = frameOf(board, { unreflected: [{ id: "r1", remark: remark! }], partials: [caption] });
    const [next] = settle(settler, inserted);

    expect(caption.text).toBe(next?.text);
    expect(caption.wordTimes).toEqual(next?.wordTimes);
    expect(texts(bubbles)).toEqual(["来週のリリースは", "金曜に"]);
  });
});

// Issue #1221: 吹き出しの「本文の先頭から何文字までが確定（発言になった語）か」。途中結果の語だけが途中
describe("吹き出しの確定の文字数（settledLength）", () => {
  const slot0 = [{ slot: 0, start: 10, end: 14 }];

  it("途中結果だけの吹き出しは、確定 0 文字", () => {
    const bubbles = frameOf(createCaptionBoard(), { partials: [partialOf([["こんにち", 10, 12]])], intervals: slot0 });

    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.settledLength).toBe(0);
  });

  it("自分の途中結果だけの吹き出しは、話者ラベルは「確定」でも確定 0 文字", () => {
    const bubbles = frameOf(createCaptionBoard(), { partials: [partialOf([["担当を分けましょう", 9, 11]], "自分")] });

    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ track: "自分", speaker: "自分", label: "確定", settledLength: 0 });
  });

  it("発言（マップに反映前）だけの吹き出しは、全部確定（本文の長さ）", () => {
    const bubbles = frameOf(createCaptionBoard(), { unreflected: [{ id: "r1", remark: remarkOf([["了解", 10, 12], ["です", 12, 14]], { speaker: "相手 A" }) }], intervals: slot0 });

    expect(bubbles[0]).toMatchObject({ text: "了解です", settledLength: 4 });
  });

  // 発言と途中結果は語の出どころが別なので、同じ吹き出しになるのは、先に途中結果として送った吹き出しの中で一部が発言になったとき
  it("前半が発言・末尾が途中結果の吹き出しは、発言の分の文字数が確定になる", () => {
    const board = createCaptionBoard();
    const first = frameOf(board, { partials: [partialOf([["こんにちは", 10, 12], ["元気", 12.1, 13]])], intervals: slot0 });
    expect(first[0]).toMatchObject({ text: "こんにちは元気", settledLength: 0 });

    const bubbles = frameOf(board, {
      unreflected: [{ id: "r1", remark: remarkOf([["こんにちは", 10, 12]], { speaker: "相手 A" }) }],
      partials: [partialOf([["元気", 12.1, 13]])],
      intervals: slot0,
    });

    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ id: first[0]!.id, text: "こんにちは元気", settledLength: 5 });
  });

  it("話者を待っている発言（held）の語は確定に数える", () => {
    const bubbles = frameOf(createCaptionBoard(), { held: [remarkOf([["はい", 10, 11]])], intervals: slot0 });

    expect(bubbles[0]).toMatchObject({ text: "はい", settledLength: 2 });
  });

  it("held の発言の後ろに途中結果が続けば、held の分だけが確定", () => {
    const board = createCaptionBoard();
    frameOf(board, { partials: [partialOf([["はい", 10, 11], ["そう", 11.1, 12]])], intervals: slot0 });

    const bubbles = frameOf(board, { held: [remarkOf([["はい", 10, 11]])], partials: [partialOf([["そう", 11.1, 12]])], intervals: slot0 });

    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ text: "はいそう", settledLength: 2 });
  });

  it("語彙で補正した発言（置換後の本文）も発言の語なので、補正後の本文の長さが確定", () => {
    const remark = remarkOf([["くろーど", 10, 12]], { speaker: "相手 A" });
    const bubbles = frameOf(createCaptionBoard(), {
      unreflected: [{ id: "r1", remark, replacements: [{ location: 0, length: 4, span: "くろーど", surface: "Claude", score: 1 }] }],
      intervals: slot0,
    });

    expect(bubbles[0]).toMatchObject({ text: "Claude", settledLength: 6 });
  });

  it("英数字の間に入る空白は途中の分の先頭に数える（確定は発言の語の長さだけ）", () => {
    const board = createCaptionBoard();
    frameOf(board, { partials: [partialOf([["OK", 10, 11], ["Google", 11.1, 12]])], intervals: slot0 });

    const bubbles = frameOf(board, {
      unreflected: [{ id: "r1", remark: remarkOf([["OK", 10, 11]], { speaker: "相手 A" }) }],
      partials: [partialOf([["Google", 11.1, 12]])],
      intervals: slot0,
    });

    expect(bubbles[0]).toMatchObject({ text: "OK Google", settledLength: 2 });
  });

  it("途中結果が発言になると、同じ id の吹き出しの確定の文字数が 0 → 本文の長さに増え、build と preview の比較が差分として扱う", () => {
    const board = createCaptionBoard();
    const parts: Part[] = [["こんにちは", 10, 12]];
    const intervals = [{ slot: 0, start: 10, end: 12 }];
    const before = frameOf(board, { partials: [partialOf(parts)], intervals });
    expect(before[0]!.settledLength).toBe(0);

    const previewed = board.preview({ partials: [], unreflected: [{ id: "r5", remark: remarkOf(parts, { speaker: "相手 A" }) }], held: [], intervals, previewLabel });
    const built = frameOf(board, { unreflected: [{ id: "r5", remark: remarkOf(parts, { speaker: "相手 A" }) }], intervals });

    expect(previewed[0]).toMatchObject({ id: before[0]!.id, settledLength: 5 });
    expect(built[0]).toMatchObject({ id: before[0]!.id, settledLength: 5 });
    expect(JSON.stringify(previewed)).not.toBe(JSON.stringify(before));
  });

  it("途中結果の語が伸びても確定の文字数は変わらない（途中の分だけが伸びる）", () => {
    const board = createCaptionBoard();
    const settledRemark = { id: "r1", remark: remarkOf([["あい", 10, 11]], { speaker: "相手 A" }) };
    frameOf(board, { partials: [partialOf([["あい", 10, 11], ["う", 11.1, 12]])], intervals: slot0 });
    const first = frameOf(board, { unreflected: [settledRemark], partials: [partialOf([["う", 11.1, 12]])], intervals: slot0 });

    const next = frameOf(board, { unreflected: [settledRemark], partials: [partialOf([["うえお", 11.1, 13]])], intervals: slot0 });

    expect(first[0]).toMatchObject({ text: "あいう", settledLength: 2 });
    expect(next[0]).toMatchObject({ id: first[0]!.id, text: "あいうえお", settledLength: 2 });
  });
});
