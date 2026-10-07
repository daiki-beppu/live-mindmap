import type { PlaybackEvent } from "./reviewPlayback.ts";

// 見返しのキーから再生の出来事への対応（DOM なし）。C（字幕）は SessionView の登録を使うので、ここには含めない。

// J・L で動かす秒数
export const SKIP_SECONDS = 10;

export type ReviewKeyAction = "toggle" | "back" | "forward" | "prev" | "next" | "slower" | "faster" | "start" | "end" | "mute";

// 定数で、hook を呼ぶ数と順序は変わらない
export const REVIEW_HOTKEYS = [
  ["Space", "toggle"],
  ["K", "toggle"],
  ["J", "back"],
  ["L", "forward"],
  [",", "prev"],
  [".", "next"],
  ["<", "slower"],
  [">", "faster"],
  ["Home", "start"],
  ["End", "end"],
] as const satisfies readonly (readonly [string, ReviewKeyAction])[];

// M（ミュート）は音声つきの見返しだけ。REVIEW_HOTKEYS に混ぜず、ReviewView が常に登録して音声なしでは enabled で切る
export const AUDIO_HOTKEYS = [["M", "mute"]] as const satisfies readonly (readonly [string, ReviewKeyAction])[];

type Modifiers = { meta: boolean; ctrl: boolean; alt: boolean };

// movesTime が true なら operate（人が時刻を動かした操作）、false なら dispatch に送る。⌘・Ctrl・Option と一緒なら null。
// 0〜会議の長さに収める処理は reducer の seek に任せる
export function reviewKeyEvent(action: ReviewKeyAction, { meta, ctrl, alt }: Modifiers, time: number, duration: number): { event: PlaybackEvent; movesTime: boolean } | null {
  if (meta || ctrl || alt) return null;
  switch (action) {
    case "toggle":
    case "prev":
    case "next":
      return { event: { type: action }, movesTime: true };
    case "back":
      return { event: { type: "seek", time: time - SKIP_SECONDS }, movesTime: true };
    case "forward":
      return { event: { type: "seek", time: time + SKIP_SECONDS }, movesTime: true };
    case "start":
      return { event: { type: "seek", time: 0 }, movesTime: true };
    case "end":
      return { event: { type: "seek", time: duration }, movesTime: true };
    case "mute":
      return { event: { type: "toggleMute" }, movesTime: false };
    case "slower":
    case "faster":
      return { event: { type: action }, movesTime: false };
  }
}
