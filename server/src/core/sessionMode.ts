import { Schema } from "effect";

// 配信中のモードだけを伝える。推論子の PID・宛先や保存形式とは独立した画面用の通知。
export const SessionModeFrame = Schema.Struct({ type: Schema.Literal("session-mode"), local: Schema.Boolean });
export type SessionModeFrame = typeof SessionModeFrame["Type"];
