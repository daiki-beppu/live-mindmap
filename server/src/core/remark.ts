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
});
export type Remark = typeof Remark["Type"];

