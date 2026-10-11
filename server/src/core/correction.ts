// 発言の補正（Issue #640、仕様 #633「照合と置き換え」）。I/O を持たない純粋な部品。
// 語彙と、語ごとの読みつきの発言から、直した本文と置き換えの一覧を返す。
// ふつうの語の一覧の守りはこの部品に含めない（別のチケット）。
import type { Word } from "./words.ts";

// 語彙の語。romaji は読み（照合のキーの元になるローマ字）。読みが無い語は語彙に入れない（呼び出し側で除く）
export type VocabularyWord = { readonly surface: string; readonly romaji: string };

// 置き換え 1 件。location / length は元の本文の UTF-16 コード単位、span は置き換えた区間の元の表記、score は近さ
export type Replacement = {
  readonly location: number;
  readonly length: number;
  readonly span: string;
  readonly surface: string;
  readonly score: number;
};

export type Correction = { readonly text: string; readonly replacements: readonly Replacement[] };

const MAX_SPAN_WORDS = 5;
const MIN_SPAN_KEY_LENGTH = 3;
const MIN_SCORE = 0.8;
const MIN_LENGTH_RATIO = 0.6;
const MAX_LENGTH_RATIO = 1.6;
// 読みのキーがこの長さ以下の語は、キーの完全一致でだけ置き換える
const EXACT_ONLY_KEY_LENGTH = 5;

const SPELLING_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["sh", "s"], ["ch", "t"], ["ts", "t"], ["j", "z"], ["dz", "z"], ["f", "h"], ["l", "r"], ["v", "b"], ["-", ""], ["'", ""],
];

// 照合のキー。ローマ字の揺れ（shi/si、tsu/tu、ou/o、小さいカナ）をそろえ、長音・促音を潰す
function matchKey(romaji: string): string {
  let s = romaji.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  // 小さいカナ: ~tsu を落とし、残る ~ を外す（ts→t の寄せより前に行う）
  s = s.replaceAll("~tsu", "").replaceAll("~", "");
  for (const [from, to] of SPELLING_VARIANTS) s = s.replaceAll(from, to);
  const out: string[] = [];
  for (const c of s) {
    if (!/[\p{L}\p{N}]/u.test(c)) continue;
    const last = out[out.length - 1];
    if (last === c) continue; // 長音・促音
    if (c === "u" && last === "o") continue; // ou → o
    if (c === "i" && last === "e") continue; // ei → e
    out.push(c);
  }
  return out.join("");
}

function editDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function similarity(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

const HIRAGANA = /^[ぁ-ゟ]+$/;
const HIRAGANA_RUN = /[ぁ-ゟ]+/g;
const PUNCTUATION_OR_SPACE = /^[\p{P}\s]*$/u;
const normalizeSurface = (s: string): string => s.normalize("NFKC").toLowerCase();
const isHiraganaOnly = (s: string): boolean => HIRAGANA.test(s);

type Term = { readonly surface: string; readonly key: string };
type Candidate = { readonly location: number; readonly length: number; readonly span: string; readonly term: Term; readonly score: number };

// 区間（句読点・空白をまたがない連続する 1〜5 語）ごとに、一番近い語を 1 つ選んで守りを当てる
function findCandidates(terms: readonly Term[], text: string, words: readonly Word[]): Candidate[] {
  const found: Candidate[] = [];
  for (let i = 0; i < words.length; i++) {
    let romaji = "";
    for (let j = i; j < Math.min(i + MAX_SPAN_WORDS, words.length); j++) {
      const word = words[j]!;
      if (word.romaji === "" || PUNCTUATION_OR_SPACE.test(word.surface)) break;
      // 前の語との間に本文がある（空白など）ときは、またがない
      if (j > i) {
        const previous = words[j - 1]!;
        if (text.slice(previous.location + previous.length, word.location) !== "") break;
      }
      romaji += word.romaji;
      const spanKey = matchKey(romaji);
      if (spanKey.length < MIN_SPAN_KEY_LENGTH) continue;
      const first = words[i]!;
      if (isHiraganaOnly(first.surface) || isHiraganaOnly(word.surface)) continue;
      const location = first.location;
      const length = word.location + word.length - location;
      const span = text.slice(location, location + length);
      const chars = [...span];
      if (chars.length < 2 || isHiraganaOnly(chars[0]!) || isHiraganaOnly(chars[chars.length - 1]!)) continue;

      let best: { term: Term; score: number } | undefined;
      // 区間が語彙のどれかの語の表記を含むなら、候補の絞り込みとは関係なく直さない
      const normalizedSpan = normalizeSurface(span);
      if (terms.some((term) => normalizedSpan.includes(normalizeSurface(term.surface)))) continue;
      for (const term of terms) {
        const ratio = spanKey.length / term.key.length;
        if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) continue;
        const score = similarity(spanKey, term.key);
        if (term.key.length <= EXACT_ONLY_KEY_LENGTH && score < 1) continue;
        if (score < MIN_SCORE) continue;
        if (best === undefined || score > best.score) best = { term, score };
      }
      if (best === undefined) continue;
      // 区間の中のひらがなを、置き換え先が落とすなら直さない
      const hiraganaRuns = span.match(HIRAGANA_RUN) ?? [];
      if (hiraganaRuns.some((run) => !best.term.surface.includes(run))) continue;
      found.push({ location, length, span, term: best.term, score: best.score });
    }
  }
  return found;
}

// 語彙と、語ごとの読みつきの発言から、直した本文と置き換えの一覧を返す。
// 重なる区間は近さの高い方を採り、同じなら長い方を採る（それも同じなら先に出る区間）
export function correctRemark(vocabulary: readonly VocabularyWord[], text: string, words: readonly Word[]): Correction {
  const terms: Term[] = vocabulary.flatMap((v) => {
    const key = matchKey(v.romaji);
    return key === "" ? [] : [{ surface: v.surface, key }];
  });
  if (terms.length === 0 || words.length === 0) return { text, replacements: [] };

  const ranked = findCandidates(terms, text, words).sort((a, b) => (a.score !== b.score ? b.score - a.score : b.length - a.length));
  const picked: Candidate[] = [];
  for (const c of ranked) {
    if (!picked.some((p) => c.location < p.location + p.length && p.location < c.location + c.length)) picked.push(c);
  }
  picked.sort((a, b) => a.location - b.location);

  let corrected = text;
  for (const c of [...picked].reverse()) {
    corrected = corrected.slice(0, c.location) + c.term.surface + corrected.slice(c.location + c.length);
  }
  return {
    text: corrected,
    replacements: picked.map((c) => ({ location: c.location, length: c.length, span: c.span, surface: c.term.surface, score: c.score })),
  };
}
