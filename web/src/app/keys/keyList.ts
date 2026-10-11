// キーの一覧（Issue #822）: @foldkit/ui の Popover を isModal: false で開く。開いたままでも背景のマップを動かせる（背景を inert にしない）。
// contentFocus: true にすると、パネルはフォーカスを取らず、blur でも閉じない（マップを押しても一覧が閉じない今の挙動に合う）。
// 一覧の行は、キーの Subscription と同じ表（table.ts）を画面で絞って作る。見た目は今の .key-list（styles.css）をそのまま使う。
// Popover はパネルの位置を trigger の button から決めるので、「?」のボタンは出さず、マップの右上に大きさのない button を置く（見た目と tab の順は変えない）
import { Popover } from "@foldkit/ui";
import type { Html, HtmlBuilder } from "foldkit/html";
import "./keyList.css";
import { keyListRows, type Screen } from "./table.ts";

const KEY_LIST_ID = "key-list";

export const initKeyList = (): Popover.Model => Popover.init({ id: KEY_LIST_ID, isModal: false, contentFocus: true });

export const keyListView = <Message>(h: HtmlBuilder<Message>, model: Popover.Model, screen: Screen, toParentMessage: (message: Popover.Message) => Message): Html =>
  h.submodel({
    slotId: KEY_LIST_ID,
    model,
    view: Popover.view,
    viewInputs: {
      // 一覧はマップの区画の中に出す（portal しない）。パネルの右端を、右上の大きさのない button の右に合わせる
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
