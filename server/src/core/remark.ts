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


export function earliestRemark(ids: readonly string[], remarks: ReadonlyMap<string, Remark>): Remark | undefined {
  let earliest: Remark | undefined;
  for (const id of ids) {
    const r = remarks.get(id);
    if (r && (!earliest || r.start < earliest.start)) earliest = r;
  }
  return earliest;
}
