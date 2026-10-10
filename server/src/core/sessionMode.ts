// 配信中のモードだけを伝える。推論子の PID・宛先や保存形式とは独立した画面用の通知。
export type SessionModeFrame = { type: "session-mode"; local: boolean };
