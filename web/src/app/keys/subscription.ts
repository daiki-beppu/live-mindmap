// キーの Subscription（Issue #822）の stream。document の keydown を、2 つの道で受けて、同じ「このキーが押された」の Message（PressedKey）にする。意味は update が決める。
// - 普通の道: Dom.streamFromKeyBindings に表のバインディングを渡す（修飾キーは厳密に照合し、入力欄の中・変換中のイベントは無視する。1 打のキーは押したままの繰り返しでも発火する）
// - 日本語入力の道: 変換中のイベントは普通の道が無視するので、halfWidthKeyOf で半角に直し、同じ表で照合して同じ Message を出す。
//   直したキーを送り直さず（dispatchEvent も stopImmediatePropagation もしない）、Dom.streamFromEventFilterMapPreventDefault で、当たったときだけ既定動作を取り消す
// 2 つの道は重ならない。普通の道は変換中のイベントを無視し、日本語入力の道は halfWidthKeyOf が null を返す普通の半角のキーを無視する
import { Filter, Option, Stream } from "effect";
import { Dom } from "foldkit";
import { enterFoldsSelection, type Focused } from "../../enterFold.ts";
import { halfWidthKeyOf } from "../../imeKey.ts";
import { reviewHotkeyYieldsToFocus } from "../../reviewKeys.ts";
import { matchKey } from "./match.ts";
import { Message } from "./message.ts";
import { bindingsOf, type Binding, type KeyId, type Screen } from "./table.ts";

// hasSelection は keydown のたびに読む（Issue #1133）。張った時点の値で持つと、選択が変わった直後の Enter が張り直しの前の値で判定される
export type KeyPressConfig = { screen: Screen; hasSelection: () => boolean; target?: EventTarget };

type Modifiers = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };

const pressedKey = (key: KeyId, { metaKey, ctrlKey, altKey }: Modifiers): Message => Message.PressedKey({ key, metaKey, ctrlKey, altKey });

// イベントの対象（フォーカス中の要素）。開閉の丸・ノード本体のボタンの中かを見るのに使う
const focusedOf = (event: KeyboardEvent): Focused => {
  const { target } = event;
  return target !== null && "closest" in target && typeof target.closest === "function" ? (target as Focused) : null;
};

// 入力欄（input・textarea・select・contenteditable）の中か。streamFromKeyBindings と同じ範囲
const isFromEditable = (event: KeyboardEvent): boolean =>
  event.composedPath().some((node) => {
    if (!("tagName" in node) || typeof node.tagName !== "string") return false;
    const tag = node.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || ("isContentEditable" in node && node.isContentEditable === true);
  });

// Enter は、選んだノードの開閉に使うときだけ既定動作を取り消して届ける。それ以外ではボタンの Enter を押せるまま残す。
// Space は、開閉の丸の中では譲る（ボタンの click に任せる）
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
              // 取り消すかは譲るかの判定の後で決める（mapEvent が、届けるときだけ取り消す）
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
