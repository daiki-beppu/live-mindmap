import { Schema } from "effect";
import { expect } from "vitest";

const Shape = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalProperties: Schema.optionalKey(Schema.Boolean),
  anyOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  items: Schema.optionalKey(Schema.Unknown),
  $defs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

export function assertStrictJsonSchema(input: unknown): void {
  const schema = Schema.decodeUnknownSync(Shape)(input);
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required ?? [])].sort()).toEqual(Object.keys(schema.properties ?? {}).sort());
  }
  for (const child of Object.values(schema.properties ?? {})) assertStrictJsonSchema(child);
  for (const child of Object.values(schema.$defs ?? {})) assertStrictJsonSchema(child);
  for (const child of schema.anyOf ?? []) assertStrictJsonSchema(child);
  if (schema.items !== undefined) assertStrictJsonSchema(schema.items);
}
