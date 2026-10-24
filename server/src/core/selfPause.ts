import { Schema } from "effect";

export const SelfPauseReason = Schema.Literals(["手動", "自動", "判定できない"]);
export type SelfPauseReason = typeof SelfPauseReason["Type"];

export const SelfPauseFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("self-pause"), paused: Schema.Literal(true), reason: Schema.Literals(["手動", "自動"]) }),
  Schema.Struct({ type: Schema.Literal("self-pause"), paused: Schema.Literal(false) }),
]);
export type SelfPauseFrame = typeof SelfPauseFrame["Type"];

export const SelfPaused = Schema.Union([Schema.Literal(false), Schema.Literals(["手動", "自動"])]);
export type SelfPaused = typeof SelfPaused["Type"];

export const SelfPauseState = Schema.Struct({
  manual: Schema.Literals(["none", "pause", "take"]),
  basis: Schema.Literals(["using", "idle", "unknown"]),
  lastKnown: Schema.Literals(["using", "idle", "unknown"]),
  idleFor: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SelfPauseState = typeof SelfPauseState["Type"];

export const INITIAL_SELF_PAUSE_STATE: SelfPauseState = { manual: "none", basis: "unknown", lastKnown: "unknown", idleFor: 0 };

export type SelfPauseLogEvent =
  | { type: "self-paused"; reason: SelfPauseReason; start: number }
  | { type: "self-resumed"; reason: SelfPauseReason; start: number };
