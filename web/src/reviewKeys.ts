import { FOLD_DOT_CLASSES, type Focused } from "./enterFold.ts";
import type { PlaybackEvent } from "./reviewPlayback.ts";

export const SKIP_SECONDS = 10;

export type ReviewKeyAction = "toggle" | "back" | "forward" | "prev" | "next" | "slower" | "faster" | "start" | "end" | "mute";

type Modifiers = { meta: boolean; ctrl: boolean; alt: boolean };

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

export function reviewHotkeyYieldsToFocus(focused: Focused): boolean {
  if (focused === null) return false;
  return !!focused.closest(FOLD_DOT_CLASSES.map((c) => `.${c}`).join(", "));
}
