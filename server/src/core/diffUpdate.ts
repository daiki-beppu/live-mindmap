import { Schema } from "effect";

export const DiffUpdateReason = Schema.Literal("ChatGPT の利用上限");
export const DiffUpdateState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("running") }),
  Schema.Struct({ status: Schema.Literal("restarting") }),
  Schema.Struct({ status: Schema.Literal("paused"), reason: DiffUpdateReason }),
  Schema.Struct({ status: Schema.Literal("stopped") }),
]);
export type DiffUpdateState = typeof DiffUpdateState["Type"];
export type DiffUpdateFrame = { type: "diff-update"; state: DiffUpdateState | null };

export class DiffUpdatePaused extends Schema.TaggedError<DiffUpdatePaused>()("DiffUpdatePaused", {
  reason: DiffUpdateReason,
  message: Schema.String,
}) {}

export const DiffUpdatePausedEvent = Schema.Struct({ type: Schema.Literal("diff-update-paused"), reason: DiffUpdateReason });
export const DiffUpdateRetryEvent = Schema.Struct({ type: Schema.Literal("diff-update-retry"), reason: DiffUpdateReason });
export const DiffUpdateResumedEvent = Schema.Struct({ type: Schema.Literal("diff-update-resumed") });
export const DIFF_UPDATE_RETRY_MS = 5 * 60_000;
