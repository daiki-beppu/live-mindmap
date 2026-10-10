import { Schema } from "effect";

export const DepNames = Schema.Array(Schema.Literal("chromium")).check(Schema.isMinLength(1));
export const InstallBody = Schema.Struct({ names: DepNames });
const Item = Schema.Struct({
  name: Schema.Literal("chromium"),
  need: Schema.Literals(["required", "optional"]),
  state: Schema.Literals(["ready", "missing", "outdated", "absent"]),
  size: Schema.optionalKey(Schema.Finite),
  install: Schema.optionalKey(Schema.String),
});
export const InstallEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("progress"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("result"), items: Schema.Array(Item) }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
