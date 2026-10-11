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

// 本文の先頭 at コード単位を切ったときの語。切った後に完全に残る語（location >= at）だけを残し、位置を切った後の本文に合わせる。
// 切る位置をまたぐ語は落とす（元の読みを別の表記へ流用しない）
export function cutWords(words: readonly Word[], at: number): Word[] {
  return words.filter((w) => w.location >= at).map((w) => ({ ...w, location: w.location - at }));
}
