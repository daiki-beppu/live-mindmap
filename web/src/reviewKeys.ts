import { FOLD_DOT_CLASSES, type Focused } from "./enterFold.ts";
import type { PlaybackEvent } from "./reviewPlayback.ts";

// 見返しのキーから再生の出来事への対応（DOM なし）。どのキーがどの動きかは、キーの表（app/keys/table.ts）が持つ。

// J・L で動かす秒数
export const SKIP_SECONDS = 10;

export type ReviewKeyAction = "toggle" | "back" | "forward" | "prev" | "next" | "slower" | "faster" | "start" | "end" | "mute";

type Modifiers = { meta: boolean; ctrl: boolean; alt: boolean };

// movesTime が true なら人が時刻を動かした操作、false なら時刻を動かさない操作。⌘・Ctrl・Option と一緒なら null。
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

// Space を、フォーカス中の開閉の丸のボタンに譲るか。丸の中なら true（再生を切り替えず、ボタン既定の click に任せる）
export function reviewHotkeyYieldsToFocus(focused: Focused): boolean {
  if (focused === null) return false;
  return !!focused.closest(FOLD_DOT_CLASSES.map((c) => `.${c}`).join(", "));
}
