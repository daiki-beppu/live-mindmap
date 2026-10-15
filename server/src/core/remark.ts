import { Schema } from "effect";

export const Track = Schema.Literals(["自分", "相手"]);
export type Track = typeof Track["Type"];

// 発言（GLOSSARY.md）
export const Remark = Schema.Struct({
  id: Schema.String,
  track: Track,
  start: Schema.Finite, // 会議の中の秒
  end: Schema.Finite,
  text: Schema.mutableKey(Schema.String),
  duplicate: Schema.optionalKey(Schema.Boolean), // 重複の印。付いた発言は差分更新に使わない
  // 話者（Issue #1021）。"自分" か、サーバーが振ったラベル（"相手 A"）。無ければ話者なし（古いログも）
  speaker: Schema.optionalKey(Schema.String),
});
export type Remark = typeof Remark["Type"];


// 根拠の発言のうち、開始がいちばん早い発言。同じ開始なら ids の前のほう。発言の表に無い id は飛ばす（1 件も引けなければ undefined）
export function earliestRemark(ids: readonly string[], remarks: ReadonlyMap<string, Remark>): Remark | undefined {
  let earliest: Remark | undefined;
  for (const id of ids) {
    const r = remarks.get(id);
    if (r && (!earliest || r.start < earliest.start)) earliest = r;
  }
  return earliest;
}
