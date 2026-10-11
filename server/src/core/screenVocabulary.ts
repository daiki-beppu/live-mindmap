// 共有画面の文字（OCR の行）から、語彙の候補を取る規則（Issue #643、仕様 #633「共有画面から候補を取る規則」）。I/O を持たない純粋な関数。
// 規則: カタカナ 3 字以上 / 漢字 3〜12 字（々を含む）/ 大文字を含む英字の語 / 3 画面以上に出た 2〜4 字の漢字・かなだけの行。
// 小文字と数字だけの英字の語（1on1）とひらがなだけの行は取らない。

const KATAKANA = /[ァ-ヺ][ァ-ヺー]{2,}/g;
const HAN_RUN = /[\p{Script=Han}々]+/gu;
const LATIN_WORD = /[A-Za-z0-9]+/g;
const HAS_UPPER = /[A-Z]/;
// 参加者の小窓の名前のような短い行: 漢字・ひらがな・カタカナ（々・ー を含む）だけ。ひらがなだけの行は除く
const SHORT_LINE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々ー]+$/u;
const HIRAGANA_ONLY = /^[\p{Script=Hiragana}ー]+$/u;

const HAN_MIN = 3;
const HAN_MAX = 12;
const SHORT_MIN = 2;
const SHORT_MAX = 4;
/** 短い行が、この数の画面に出たら候補にする */
const SHORT_SCREENS = 3;

const codePoints = (s: string): number => [...s].length;

export type ScreenCandidates = {
  /** この画面で取れた候補（重複なし、出た順） */
  readonly candidates: ReadonlyArray<string>;
  /** 短い行ごとの、出た画面の数（次の画面へ引き継ぐ） */
  readonly seen: ReadonlyMap<string, number>;
};

/** 1 画面の行から候補を取る。`seen` は渡されたものを書き換えず、更新した数を新しく返す。 */
export function screenCandidates(seen: ReadonlyMap<string, number>, lines: ReadonlyArray<string>): ScreenCandidates {
  const found = new Set<string>();
  const shortLines = new Set<string>();

  for (const raw of lines) {
    for (const m of raw.matchAll(KATAKANA)) found.add(m[0]);
    for (const m of raw.matchAll(HAN_RUN)) {
      const n = codePoints(m[0]);
      if (n >= HAN_MIN && n <= HAN_MAX) found.add(m[0]);
    }
    for (const m of raw.matchAll(LATIN_WORD)) {
      if (HAS_UPPER.test(m[0])) found.add(m[0]);
    }
    const line = raw.trim();
    const n = codePoints(line);
    if (n >= SHORT_MIN && n <= SHORT_MAX && SHORT_LINE.test(line) && !HIRAGANA_ONLY.test(line)) shortLines.add(line);
  }

  const next = new Map(seen);
  for (const line of shortLines) {
    const count = (next.get(line) ?? 0) + 1;
    next.set(line, count);
    if (count >= SHORT_SCREENS) found.add(line);
  }
  return { candidates: [...found], seen: next };
}
