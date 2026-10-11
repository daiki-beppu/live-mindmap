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

export class DiffUpdateStopped extends Schema.TaggedError<DiffUpdateStopped>()("DiffUpdateStopped", {
  message: Schema.String,
}) {}

export type DiffUpdateLifecycle = { readonly status: "running" | "restarting" } | DiffUpdateStopped;
export const DiffUpdateStateEvent = Schema.Struct({ type: Schema.Literal("diff-update-state"), state: DiffUpdateState });

export const DiffUpdatePausedEvent = Schema.Struct({ type: Schema.Literal("diff-update-paused"), reason: DiffUpdateReason });
export const DiffUpdateRetryEvent = Schema.Struct({ type: Schema.Literal("diff-update-retry"), reason: DiffUpdateReason });
export const DiffUpdateResumedEvent = Schema.Struct({ type: Schema.Literal("diff-update-resumed") });
export const DIFF_UPDATE_RETRY_MS = 5 * 60_000;
