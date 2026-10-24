import type { Word, WordTime } from "./words.ts";

export type VocabularyWord = { readonly surface: string; readonly romaji: string };

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
const EXACT_ONLY_KEY_LENGTH = 5;

const SPELLING_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ["sh", "s"], ["ch", "t"], ["ts", "t"], ["j", "z"], ["dz", "z"], ["f", "h"], ["l", "r"], ["v", "b"], ["-", ""], ["'", ""],
];

function matchKey(romaji: string): string {
  let s = romaji.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  // 小さいカナ: ~tsu を落とし、残る ~ を外す（ts→t の寄せより前に行う）
  s = s.replaceAll("~tsu", "").replaceAll("~", "");
  for (const [from, to] of SPELLING_VARIANTS) s = s.replaceAll(from, to);
  const out: string[] = [];
  for (const c of s) {
    if (!/[\p{L}\p{N}]/u.test(c)) continue;
    const last = out[out.length - 1];
    if (last === c) continue;
    if (c === "u" && last === "o") continue;
    if (c === "i" && last === "e") continue;
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
const PUNCTUATION_OR_SPACE = /^[\p{P}\s]*$/u;
export const normalizeSurface = (s: string): string => s.normalize("NFKC").toLowerCase();
const isHiraganaOnly = (s: string): boolean => HIRAGANA.test(s);
const isLatinOnly = (s: string): boolean => /^[A-Za-z]+$/.test(s.normalize("NFKC"));

type Term = { readonly surface: string; readonly key: string; readonly latin: boolean };
type Candidate = { readonly location: number; readonly length: number; readonly span: string; readonly term: Term; readonly score: number };

function spanOf(terms: readonly Term[], text: string, words: readonly Word[], i: number, j: number): { location: number; length: number; span: string } | undefined {
  const first = words[i]!;
  const word = words[j]!;
  if (isHiraganaOnly(first.surface) || isHiraganaOnly(word.surface)) return undefined;
  const location = first.location;
  const length = word.location + word.length - location;
  const span = text.slice(location, location + length);
  const chars = [...span];
  if (chars.length < 2 || isHiraganaOnly(chars[0]!) || isHiraganaOnly(chars[chars.length - 1]!)) return undefined;
  const normalizedSpan = normalizeSurface(span);
  if (terms.some((term) => normalizedSpan.includes(normalizeSurface(term.surface)))) return undefined;
  return { location, length, span };
}

function scoreOf(term: Term, spanKey: string, isCommon: boolean): number | undefined {
  if (isCommon && !term.latin) return undefined;
  const ratio = spanKey.length / term.key.length;
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) return undefined;
  const score = similarity(spanKey, term.key);
  if (term.key.length <= EXACT_ONLY_KEY_LENGTH && score < 1) return undefined;
  return score < MIN_SCORE ? undefined : score;
}

function bestTerm(terms: readonly Term[], span: string, spanKey: string, kanaWords: readonly string[], commonWords: ReadonlySet<string>): { term: Term; score: number } | undefined {
  let best: { term: Term; score: number } | undefined;
  const isCommon = commonWords.has(span);
  for (const term of terms) {
    const score = scoreOf(term, spanKey, isCommon);
    if (score !== undefined && (best === undefined || score > best.score)) best = { term, score };
  }
  if (best === undefined) return undefined;
  return best.score < 1 && kanaWords.some((word) => !best.term.surface.includes(word)) ? undefined : best;
}

function candidatesFrom(terms: readonly Term[], text: string, words: readonly Word[], commonWords: ReadonlySet<string>, i: number): Candidate[] {
  const found: Candidate[] = [];
  let romaji = "";
  for (let j = i; j < Math.min(i + MAX_SPAN_WORDS, words.length); j++) {
    const word = words[j]!;
    if (word.romaji === "" || PUNCTUATION_OR_SPACE.test(word.surface)) break;
    if (j > i && text.slice(words[j - 1]!.location + words[j - 1]!.length, word.location) !== "") break;
    romaji += word.romaji;
    const spanKey = matchKey(romaji);
    if (spanKey.length < MIN_SPAN_KEY_LENGTH) continue;
    const area = spanOf(terms, text, words, i, j);
    const kanaWords = words.slice(i, j + 1).map((w) => w.surface).filter(isHiraganaOnly);
    const best = area && bestTerm(terms, area.span, spanKey, kanaWords, commonWords);
    if (area && best) found.push({ ...area, term: best.term, score: best.score });
  }
  return found;
}

function findCandidates(terms: readonly Term[], text: string, words: readonly Word[], commonWords: ReadonlySet<string>): Candidate[] {
  return words.flatMap((_, i) => candidatesFrom(terms, text, words, commonWords, i));
}

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

export type CaptionCorrection = { readonly text: string; readonly wordTimes: readonly WordTime[] };

type AppliedReplacement = {
  readonly r: Replacement;
  readonly size: number;
  readonly cumulative: readonly number[];
  readonly innerOffsets: ReadonlyMap<number, number>;
};

function innerOffsets(r: Replacement, size: number, kept: readonly WordTime[], required: readonly number[]): Map<number, number> {
  const values = kept.map((w) => Math.round(((w.location - r.location) * size) / r.length));
  let floor = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] = Math.max(values[i]!, floor + required[i]!);
    floor = values[i]!;
  }
  let ceiling = size;
  for (let i = values.length - 1; i >= 0; i--) {
    values[i] = Math.min(values[i]!, ceiling - required[i + 1]!);
    ceiling = values[i]!;
  }
  return new Map(kept.map((w, i) => [w.location, values[i]!]));
}

type BubbleOf = (w: WordTime) => string | undefined;

function effectiveOwners(sorted: readonly WordTime[], replacements: readonly Replacement[], bubbleOf: BubbleOf): (string | undefined)[] {
  const isInside = (position: number) => replacements.some((r) => r.location < position && position < r.location + r.length);
  const effective: (string | undefined)[] = [];
  for (const [i, w] of sorted.entries()) effective.push(bubbleOf(w) ?? (i > 0 && isInside(w.location) ? effective[i - 1] : undefined));
  return effective;
}

function ownersWithOutsideText(text: string, sorted: readonly WordTime[], replacements: readonly Replacement[], effective: readonly (string | undefined)[]): Set<string> {
  const isCovered = (position: number) => replacements.some((r) => r.location <= position && position < r.location + r.length);
  const hasOutside = new Set<string>();
  for (const [i, w] of sorted.entries()) {
    const owner = effective[i];
    if (owner === undefined) continue;
    for (let p = i === 0 ? 0 : w.location; p < (sorted[i + 1]?.location ?? text.length); p++) {
      if (!isCovered(p) && text[p]!.trim() !== "") {
        hasOutside.add(owner);
        break;
      }
    }
  }
  return hasOutside;
}

function planReplacements(sorted: readonly WordTime[], replacements: readonly Replacement[], bubbleOf: BubbleOf, needsChar: (owner: string | undefined) => number) {
  const applied: AppliedReplacement[] = [];
  const dropped = new Set<WordTime>();
  for (const r of replacements) {
    const chars = [...r.surface];
    const inner = sorted.filter((w) => r.location < w.location && w.location < r.location + r.length);
    const kept = inner.filter((w) => {
      const owner = bubbleOf(w);
      const before = sorted[sorted.indexOf(w) - 1];
      return owner !== undefined && owner !== (before === undefined ? undefined : bubbleOf(before));
    });
    const head = sorted.findLast((w) => w.location <= r.location);
    const required = [needsChar(head === undefined ? undefined : bubbleOf(head)), ...kept.map((w) => needsChar(bubbleOf(w)))];
    if (required.reduce((sum, n) => sum + n, 0) > chars.length) continue;
    for (const w of inner) if (!kept.includes(w)) dropped.add(w);
    const cumulative = chars.reduce<number[]>((acc, c) => [...acc, acc[acc.length - 1]! + c.length], [0]);
    applied.push({ r, size: chars.length, cumulative, innerOffsets: innerOffsets(r, chars.length, kept, required) });
  }
  return { applied, dropped };
}

function mergeDropped(sorted: readonly WordTime[], dropped: ReadonlySet<WordTime>): WordTime[] {
  const runs: WordTime[] = [];
  for (const w of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && dropped.has(w)) runs[runs.length - 1] = { ...last, length: Math.max(last.length, w.location + w.length - last.location), end: Math.max(last.end, w.end) };
    else runs.push(w);
  }
  return runs;
}

function placeAfter(applied: readonly AppliedReplacement[], position: number): number {
  let shift = 0;
  for (const { r, size, cumulative, innerOffsets: offsets } of applied) {
    if (position >= r.location + r.length) {
      shift += r.surface.length - r.length;
      continue;
    }
    if (position <= r.location) break;
    const entries = [...offsets];
    const lower = entries.findLast(([location]) => location <= position)?.[1] ?? 0;
    const upper = entries.find(([location]) => location >= position)?.[1] ?? size;
    const offset = offsets.get(position) ?? Math.min(Math.max(Math.round(((position - r.location) * size) / r.length), lower), upper);
    return r.location + shift + cumulative[offset]!;
  }
  return position + shift;
}

export function placeCorrectionForCaptions(text: string, wordTimes: readonly WordTime[], replacements: readonly Replacement[], bubbleOf: BubbleOf): CaptionCorrection {
  const sorted = [...wordTimes].sort((a, b) => a.location - b.location);
  const effective = effectiveOwners(sorted, replacements, bubbleOf);
  const hasOutside = ownersWithOutsideText(text, sorted, replacements, effective);
  const needsChar = (owner: string | undefined): number => (owner === undefined || hasOutside.has(owner) ? 0 : 1);
  const { applied, dropped } = planReplacements(sorted, replacements, bubbleOf, needsChar);

  let corrected = text;
  for (const { r } of [...applied].reverse()) corrected = corrected.slice(0, r.location) + r.surface + corrected.slice(r.location + r.length);
  return {
    text: corrected,
    wordTimes: mergeDropped(sorted, dropped).map((w) => {
      const location = placeAfter(applied, w.location);
      return { ...w, location, length: placeAfter(applied, w.location + w.length) - location };
    }),
  };
}
