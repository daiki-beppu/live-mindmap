import { Effect, Schema } from "effect";
import { DiffOperations } from "./core/index.ts";

const HttpOps = DiffOperations.fields.ops.schema.value.mapMembers(([add, update, ...rest]) => [
  add.mapFields((fields) => ({
    ...fields,
    assignee: Schema.NullOr(Schema.requiredKey(fields.assignee)),
    assigneeSpeaker: Schema.NullOr(Schema.requiredKey(fields.assigneeSpeaker)),
    criteria: Schema.NullOr(Schema.requiredKey(fields.criteria)).annotate({ description: "関係する軸。null は指定なし" }),
    due: Schema.NullOr(Schema.requiredKey(fields.due)),
  })),
  update.mapFields((fields) => ({
    ...fields,
    text: Schema.NullOr(Schema.requiredKey(fields.text)),
    planStatus: Schema.NullOr(Schema.requiredKey(fields.planStatus)),
    criteria: Schema.NullOr(Schema.requiredKey(fields.criteria)).annotate({ description: "関係する軸。null は既存の関係づけを保持、[] は解除" }),
    assignee: Schema.NullOr(Schema.requiredKey(fields.assignee)),
    assigneeSpeaker: Schema.NullOr(Schema.requiredKey(fields.assigneeSpeaker)),
  })),
  ...rest,
]);
const HttpDiffOutput = Schema.Struct({
  ops: Schema.Array(HttpOps),
  names: Schema.NullOr(Schema.requiredKey(DiffOperations.fields.names)),
}).annotate({ description: "任意属性は省略する代わりに null を返す。update の null 属性は既存値を保持する" });

export const HTTP_DIFF_OUTPUT_SCHEMA = Schema.toJsonSchemaDocument(HttpDiffOutput, { onExcessProperty: "error" }).schema;

export const decodeHttpDiffOutput = (text: string) => Schema.decodeEffect(Schema.fromJsonString(HttpDiffOutput), { onExcessProperty: "error" })(text).pipe(
  Effect.flatMap(({ ops, names }) => Schema.decodeUnknownEffect(DiffOperations, { onExcessProperty: "error" })({
    ops: ops.map((op) => Object.fromEntries(Object.entries(op).filter(([, value]) => value !== null))),
    ...(names === null ? {} : { names }),
  })),
);
