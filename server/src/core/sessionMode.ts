import { Schema } from "effect";

export const SessionModeFrame = Schema.Struct({ type: Schema.Literal("session-mode"), local: Schema.Boolean });
export type SessionModeFrame = typeof SessionModeFrame["Type"];
