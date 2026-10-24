import { Schema } from "effect";

export class UpdaterUnavailable extends Schema.TaggedError<UpdaterUnavailable>()("UpdaterUnavailable", {
  message: Schema.String,
  dependency: Schema.optionalKey(Schema.Literal("claude")),
}) {}
