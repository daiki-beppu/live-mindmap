// 試作（Issue #736）: #153 のキー。Foldkit の streamFromKeyBindings の表で、SessionView.tsx と ReviewView.tsx が
// @tanstack/react-hotkeys に登録していたものを並べる。修飾キーは厳密に照合されるので、Shift が要る字（? < >、JIS の =）は Shift 付きも並べる
import type { KeyBinding } from "foldkit/dom";
import { enterFoldsSelection } from "../enterFold.ts";
import { reviewHotkeyYieldsToFocus } from "../reviewKeys.ts";
import { Message } from "./message.ts";

type ViewKey = typeof Message.PressedViewKey.Type["key"];
type ReviewAction = typeof Message.PressedReviewKey.Type["action"];

const elementOf = (target: EventTarget | null) => (target instanceof Element ? target : null);

export function keyBindings(hasSelection: boolean, audio: boolean): ReadonlyArray<KeyBinding<Message>> {
  const view = (keys: string, key: ViewKey): KeyBinding<Message> => ({ keys, mapEvent: () => Message.PressedViewKey({ key }), whenRepeated: "Allow" });
  const review = (keys: string, action: ReviewAction, repeat = false): KeyBinding<Message> => ({
    keys,
    mapEvent: () => Message.PressedReviewKey({ action }),
    ...(repeat ? { whenRepeated: "Allow" as const } : {}),
  });
  const arrow = (keys: string, dir: "left" | "right" | "up" | "down"): KeyBinding<Message> => ({ keys, mapEvent: () => Message.PressedArrow({ dir }), whenRepeated: "Allow" });
  return [
    { keys: "Escape", mapEvent: () => Message.PressedEscape() },
    view("=", "="),
    view("Shift+=", "="),
    view("-", "-"),
    view("0", "0"),
    view("F", "F"),
    view("Z", "Z"),
    view("Shift+ArrowLeft", "Shift+ArrowLeft"),
    view("Shift+ArrowRight", "Shift+ArrowRight"),
    view("Shift+ArrowUp", "Shift+ArrowUp"),
    view("Shift+ArrowDown", "Shift+ArrowDown"),
    arrow("ArrowLeft", "left"),
    arrow("ArrowRight", "right"),
    arrow("ArrowUp", "up"),
    arrow("ArrowDown", "down"),
    // 開閉に使うときだけ既定動作を取り消す（ほかのボタンの Enter は押せるまま）
    {
      keys: "Enter",
      preventDefault: false,
      mapEvent: (e) => {
        if (!enterFoldsSelection(elementOf(e.target), hasSelection)) return Message.IgnoredKey();
        e.preventDefault();
        return Message.PressedEnter();
      },
    },
    { keys: "?", mapEvent: () => Message.PressedKeyList() },
    { keys: "Shift+?", mapEvent: () => Message.PressedKeyList() },
    { keys: "E", mapEvent: () => Message.PressedSide() },
    { keys: "C", mapEvent: () => Message.PressedCaptions() },
    // Space は開閉の丸の中では譲る（ボタンの click を残す）。それ以外では自分で取り消す
    {
      keys: "Space",
      preventDefault: false,
      mapEvent: (e) => {
        if (reviewHotkeyYieldsToFocus("Space", elementOf(e.target))) return Message.IgnoredKey();
        e.preventDefault();
        return Message.PressedReviewKey({ action: "toggle" });
      },
    },
    review("K", "toggle"),
    review("J", "back", true),
    review("L", "forward", true),
    review(",", "prev", true),
    review(".", "next", true),
    review("<", "slower"),
    review("Shift+<", "slower"),
    review(">", "faster"),
    review("Shift+>", "faster"),
    review("Home", "start"),
    review("End", "end"),
    { ...review("M", "mute"), isEnabled: audio },
  ];
}
