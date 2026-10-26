import { Schema } from "effect";

export const Track = Schema.Literals(["自分", "相手"]);
export type Track = typeof Track["Type"];

export const Remark = Schema.Struct({
  id: Schema.String,
  track: Track,
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.mutableKey(Schema.String),
  duplicate: Schema.optionalKey(Schema.Boolean),
  speaker: Schema.optionalKey(Schema.String),
});
export type Remark = typeof Remark["Type"];

const FILLERS: ReadonlySet<string> = new Set([
  "あ", "え", "う", "お", "ん", "うん", "ふん", "ええ", "はあ", "へえ", "ほう",
  "あの", "えっと", "えと", "その", "まあ", "はい",
]);

export function hasContent(text: string): boolean {
  const words = text.replace(/[ー〜~]/g, "").split(/[\s\p{P}\p{S}]+/u).filter((w) => w !== "");
  return words.some((w) => !FILLERS.has(w));
}

export const speakerOf = (r: Remark): string => r.speaker ?? r.track;


export function earliestRemark(ids: readonly string[], remarks: ReadonlyMap<string, Remark>): Remark | undefined {
  let earliest: Remark | undefined;
  for (const id of ids) {
    const r = remarks.get(id);
    if (r && (!earliest || r.start < earliest.start)) earliest = r;
  }
  return earliest;
}
