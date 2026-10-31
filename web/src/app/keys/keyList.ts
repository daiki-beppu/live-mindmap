// contentFocus: true にすると、パネルはフォーカスを取らず、blur でも閉じない（マップを押しても一覧が閉じない今の挙動に合う）。
// Popover はパネルの位置を trigger の button から決めるので、「?」のボタンは出さず、マップの右上に大きさのない button を置く（見た目と tab の順は変えない）
import { Popover } from "@foldkit/ui";
import type { Option } from "effect";
import { Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { keyListRows, type Screen } from "./table.ts";

const KEY_LIST_ID = "key-list";

export const initKeyList = (): Popover.Model => Popover.init({ id: KEY_LIST_ID, isModal: false, contentFocus: true });

export const keyListFolds = <Model, Message>(parent: {
  readonly read: (model: Model) => Option.Option<Popover.Model>;
  readonly write: (model: Model, keyList: Popover.Model) => Model;
  readonly toParentMessage: (message: Popover.Message) => Message;
}) => {
  const fold = { ...parent, foldOutMessage: () => (model: Model) => ({ model }) };
  return {
    foldKeyList: Update.foldChild({ update: Popover.update, ...fold }),
    foldKeyListOpen: Update.foldChildStep({ update: Popover.open, ...fold }),
    foldKeyListClose: Update.foldChildStep({ update: Popover.close, ...fold }),
  };
};

export const keyListView = <Message>(h: HtmlBuilder<Message>, model: Popover.Model, screen: Screen, toParentMessage: (message: Popover.Message) => Message): Html =>
  h.submodel({
    slotId: KEY_LIST_ID,
    model,
    view: Popover.view,
    viewInputs: {
      anchor: { placement: "bottom-end", portal: false },
      toView: ({ button, panel, isVisible }) =>
        isVisible
          ? h.div(
              [h.Class("key-list__anchor")],
              [
                h.button([...button, h.Class("key-list__trigger"), h.Tabindex(-1), h.AriaHidden(true)]),
                h.div(
                  [...panel, h.Class("key-list")],
                  keyListRows(screen).map((row) =>
                    h.keyed("p")(row.keys, [h.Class("key-list__row")], [h.span([h.Class("key-list__keys")], [row.keys]), ` ${row.action}`]),
                  ),
                ),
              ],
            )
          : h.empty,
    },
    toParentMessage,
  });
