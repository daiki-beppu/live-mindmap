// 発言の本文を語に区切った要素（Issue #639）。ヘルパーの `Word`（helper/Sources/HelperCore/Words.swift）と同じ項目名と単位。
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

// 発言の本文の 1 区間の時刻（Issue #1019）。ヘルパーの `WordTime`（helper/Sources/HelperCore/Words.swift）と同じ項目名と単位。
// location / length は本文の UTF-16 コード単位、start / end は会議の原点からの秒（発言の start / end と同じ基準）。
// words とは区切りの元が違う（words は CFStringTokenizer の語、こちらは STT の run）。
export const WordTime = Schema.Struct({
  location: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: Schema.Finite,
  end: Schema.Finite,
});
export type WordTime = typeof WordTime["Type"];

// 本文の先頭 at コード単位を切ったときの語（と語の区間）。切った後に完全に残る要素（location >= at）だけを残し、位置を切った後の本文に合わせる。
// 切る位置をまたぐ要素は落とす（元の読みを別の表記へ流用しない）
export function cutWords<W extends { readonly location: number }>(words: readonly W[], at: number): W[] {
  return words.filter((w) => w.location >= at).map((w) => ({ ...w, location: w.location - at }));
}

// 本文の先頭から pos コード単位までを残したときの語（と語の区間）。pos を越える要素（location + length > pos）は落とす
export function keepWordsBefore<W extends { readonly location: number; readonly length: number }>(words: readonly W[], pos: number): W[] {
  return words.filter((w) => w.location + w.length <= pos);
}
