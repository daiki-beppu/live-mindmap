// 発言の補正（Issue #640、仕様 #633「照合と置き換え」）。I/O を持たない純粋な部品。
// 語彙と、語ごとの読みつきの発言から、直した本文と置き換えの一覧を返す。
// ふつうの語の一覧（Issue #641）に載る区間は、英字の語への書き換え（ズーム→Zoom）を除いて直さない。一覧は呼び出し側が渡す。
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
export const normalizeSurface = (s: string): string => s.normalize("NFKC").toLowerCase();
const isHiraganaOnly = (s: string): boolean => HIRAGANA.test(s);
const isLatinOnly = (s: string): boolean => /^[A-Za-z]+$/.test(s.normalize("NFKC"));

// latin は表記が英字だけの語（NFKC にした値で判定）。ふつうの語の区間でも、英字の語への書き換えは通す
type Term = { readonly surface: string; readonly key: string; readonly latin: boolean };
type Candidate = { readonly location: number; readonly length: number; readonly span: string; readonly term: Term; readonly score: number };

// 区間の検査。語彙の表記を含む区間や、端がひらがなの区間は直さない
function spanOf(terms: readonly Term[], text: string, words: readonly Word[], i: number, j: number): { location: number; length: number; span: string } | undefined {
  const first = words[i]!;
  const word = words[j]!;
  if (isHiraganaOnly(first.surface) || isHiraganaOnly(word.surface)) return undefined;
  const location = first.location;
  const length = word.location + word.length - location;
  const span = text.slice(location, location + length);
  const chars = [...span];
  if (chars.length < 2 || isHiraganaOnly(chars[0]!) || isHiraganaOnly(chars[chars.length - 1]!)) return undefined;
  // 区間が語彙のどれかの語の表記を含むなら、候補の絞り込みとは関係なく直さない
  const normalizedSpan = normalizeSurface(span);
  if (terms.some((term) => normalizedSpan.includes(normalizeSurface(term.surface)))) return undefined;
  return { location, length, span };
}

// 区間の表記に対する語の近さ。この語を候補にしないなら undefined
function scoreOf(term: Term, spanKey: string, isCommon: boolean): number | undefined {
  // 区間の表記がふつうの語の一覧に載っていれば、英字の語への書き換えだけを候補に残す
  if (isCommon && !term.latin) return undefined;
  const ratio = spanKey.length / term.key.length;
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) return undefined;
  const score = similarity(spanKey, term.key);
  if (term.key.length <= EXACT_ONLY_KEY_LENGTH && score < 1) return undefined;
  return score < MIN_SCORE ? undefined : score;
}

// 区間に一番近い語を選ぶ（同じ点なら先に出た語）。区間の中のひらがなを置き換え先が落とすなら選ばない
function bestTerm(terms: readonly Term[], span: string, spanKey: string, commonWords: ReadonlySet<string>): { term: Term; score: number } | undefined {
  let best: { term: Term; score: number } | undefined;
  const isCommon = commonWords.has(span);
  for (const term of terms) {
    const score = scoreOf(term, spanKey, isCommon);
    if (score !== undefined && (best === undefined || score > best.score)) best = { term, score };
  }
  if (best === undefined) return undefined;
  const hiraganaRuns = span.match(HIRAGANA_RUN) ?? [];
  return hiraganaRuns.some((run) => !best.term.surface.includes(run)) ? undefined : best;
}

// 語 i から始まる区間の候補。句読点・空白・語の間の隙間のところで打ち切る
function candidatesFrom(terms: readonly Term[], text: string, words: readonly Word[], commonWords: ReadonlySet<string>, i: number): Candidate[] {
  const found: Candidate[] = [];
  let romaji = "";
  for (let j = i; j < Math.min(i + MAX_SPAN_WORDS, words.length); j++) {
    const word = words[j]!;
    if (word.romaji === "" || PUNCTUATION_OR_SPACE.test(word.surface)) break;
    // 前の語との間に本文がある（空白など）ときは、またがない
    if (j > i && text.slice(words[j - 1]!.location + words[j - 1]!.length, word.location) !== "") break;
    romaji += word.romaji;
    const spanKey = matchKey(romaji);
    if (spanKey.length < MIN_SPAN_KEY_LENGTH) continue;
    const area = spanOf(terms, text, words, i, j);
    const best = area && bestTerm(terms, area.span, spanKey, commonWords);
    if (area && best) found.push({ ...area, term: best.term, score: best.score });
  }
  return found;
}

// 区間（句読点・空白をまたがない連続する 1〜5 語）ごとに、一番近い語を 1 つ選んで守りを当てる
function findCandidates(terms: readonly Term[], text: string, words: readonly Word[], commonWords: ReadonlySet<string>): Candidate[] {
  return words.flatMap((_, i) => candidatesFrom(terms, text, words, commonWords, i));
}

// 語彙と、語ごとの読みつきの発言から、直した本文と置き換えの一覧を返す。
// 重なる区間は近さの高い方を採り、同じなら長い方を採る（それも同じなら先に出る区間）
export function correctRemark(vocabulary: readonly VocabularyWord[], text: string, words: readonly Word[], commonWords: ReadonlySet<string>): Correction {
  const terms: Term[] = vocabulary.flatMap((v) => {
    const key = matchKey(v.romaji);
    return key === "" ? [] : [{ surface: v.surface, key, latin: isLatinOnly(v.surface) }];
  });
  if (terms.length === 0 || words.length === 0) return { text, replacements: [] };

  const ranked = findCandidates(terms, text, words, commonWords).sort((a, b) => (a.score !== b.score ? b.score - a.score : b.length - a.length));
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
