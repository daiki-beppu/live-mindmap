// Dom.streamFromKeyBindings は変換中（isComposing）のイベントを無視するので、日本語入力の道は halfWidthKeyOf で半角に直して同じ表で照合する
import { Filter, Option, Stream } from "effect";
import { Dom } from "foldkit";
import { enterFoldsSelection, type Focused } from "../../enterFold.ts";
import { halfWidthKeyOf } from "../../imeKey.ts";
import { reviewHotkeyYieldsToFocus } from "../../reviewKeys.ts";
import { matchKey } from "./match.ts";
import { Message } from "./message.ts";
import { bindingsOf, type Binding, type KeyId, type Screen } from "./table.ts";

export type KeyPressConfig = { screen: Screen; hasSelection: () => boolean; target?: EventTarget };

type Modifiers = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };

const pressedKey = (key: KeyId, { metaKey, ctrlKey, altKey }: Modifiers): Message => Message.PressedKey({ key, metaKey, ctrlKey, altKey });

const focusedOf = (event: KeyboardEvent): Focused => {
  const { target } = event;
  return target !== null && "closest" in target && typeof target.closest === "function" ? (target as Focused) : null;
};

const isFromEditable = (event: KeyboardEvent): boolean =>
  event.composedPath().some((node) => {
    if (!("tagName" in node) || typeof node.tagName !== "string") return false;
    const tag = node.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || ("isContentEditable" in node && node.isContentEditable === true);
  });

const yields = (binding: Binding, focused: Focused, hasSelection: boolean): boolean =>
  binding.key === "Enter" ? !enterFoldsSelection(focused, hasSelection) : binding.key === "Space" && reviewHotkeyYieldsToFocus(focused);

const isConditional = (binding: Binding): boolean => binding.key === "Enter" || binding.key === "Space";

export const keyPressStream = ({ screen, hasSelection, target }: KeyPressConfig): Stream.Stream<Message> => {
  const bindings = bindingsOf(screen);
  const resolveTarget = (): Document => (target ?? document) as Document;

  const keyBindings = Stream.filterMap(
    Dom.streamFromKeyBindings({
      target: resolveTarget,
      bindings: bindings.map((binding) =>
        isConditional(binding)
          ? {
              keys: binding.keys,
              whenRepeated: "Allow" as const,
              preventDefault: false,
              mapEvent: (event: KeyboardEvent): Option.Option<Message> => {
                if (yields(binding, focusedOf(event), hasSelection())) return Option.none();
                event.preventDefault();
                return Option.some(pressedKey(binding.key, event));
              },
            }
          : { keys: binding.keys, whenRepeated: "Allow" as const, mapEvent: (event: KeyboardEvent): Option.Option<Message> => Option.some(pressedKey(binding.key, event)) },
      ),
    }),
    Filter.fromPredicateOption((message: Option.Option<Message>) => message),
  );

  const halfWidthKeys = Dom.streamFromEventFilterMapPreventDefault({
    target: resolveTarget,
    type: "keydown",
    filterMapEvent: (event: KeyboardEvent): Option.Option<Message> => {
      if (event.defaultPrevented || isFromEditable(event)) return Option.none();
      const half = halfWidthKeyOf(event);
      if (half === null) return Option.none();
      const binding = matchKey(bindings, half);
      if (binding === undefined || yields(binding, focusedOf(event), hasSelection())) return Option.none();
      return Option.some(pressedKey(binding.key, event));
    },
  });

  return Stream.merge(keyBindings, halfWidthKeys);
};
