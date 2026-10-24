// location / length は本文の UTF-16 コード単位（発言の時刻 start / end の秒とは別）。
// romaji は CFStringTokenizer のローマ字の読みで、読みが無い語は空文字。
import { Schema } from "effect";

export const Word = Schema.Struct({
  surface: Schema.String,
  romaji: Schema.String,
  location: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type Word = typeof Word["Type"];

export const WordTime = Schema.Struct({
  location: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: Schema.Finite,
  end: Schema.Finite,
});
export type WordTime = typeof WordTime["Type"];

export function cutWords<W extends { readonly location: number }>(words: readonly W[], at: number): W[] {
  return words.filter((w) => w.location >= at).map((w) => ({ ...w, location: w.location - at }));
}

export function keepWordsBefore<W extends { readonly location: number; readonly length: number }>(words: readonly W[], pos: number): W[] {
  return words.filter((w) => w.location + w.length <= pos);
}
