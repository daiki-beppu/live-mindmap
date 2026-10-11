import { Schema } from "effect";

export const ManagedDepNames = Schema.Array(Schema.Literals(["chromium", "claude"])).check(Schema.isMinLength(1));
export const CheckDepNames = Schema.Array(Schema.Literals(["chromium", "claude", "cloudflared"])).check(Schema.isMinLength(1));
export const DepNames = Schema.Array(Schema.Literals(["chromium", "claude", "cloudflared", "speech-ja"])).check(Schema.isMinLength(1));
export const InstallBody = Schema.Struct({ names: DepNames });
export const UpdateBody = Schema.Struct({ names: ManagedDepNames });
export const Item = Schema.Struct({
  name: Schema.Literals(["chromium", "claude", "cloudflared", "speech-ja", "helper", "microphone", "screen-capture"]),
  need: Schema.Literals(["required", "optional"]),
  state: Schema.Literals(["ready", "missing", "outdated", "absent"]),
  size: Schema.optionalKey(Schema.Finite),
  install: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});
export const CheckReport = Schema.Struct({
  ready: Schema.Boolean,
  items: Schema.Array(Item),
});
export const CheckFor = Schema.Literals(["start", "resume", "play"]);
export const ModelRoute = Schema.Literals(["claude", "openai-compatible", "chatgpt", "apple"]);
export const StartupRefusal = Schema.TaggedStruct("StartupDepsMissing", {
  items: Schema.Array(Item).check(Schema.isMinLength(1)),
});
export const StartupWarnings = Schema.Struct({ warnings: Schema.optionalKey(Schema.Array(Schema.String)) });
export const InstallEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("progress"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("result"), items: Schema.Array(Item) }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
