// PROTOTYPE（Issue #1282、使い捨て）: 右の列に TODO の一覧を足す 3 案。web/prototype-todo-panel.html の ?variant=A|B|C で切り替える。
// main に入れない。決まった案はテストつきで書き直す
import type { Html, HtmlBuilder } from "foldkit/html";
import type { SnapshotNode } from "../../../../server/src/core/index.ts";
import { formatClock } from "../../changes.ts";
import { speakerName } from "../../people.ts";
import type { Model } from "../mapSurface/main.ts";
import { Message } from "../mapSurface/message.ts";

export type Variant = "A" | "B" | "C";

export function variantOf(): Variant | null {
  const v = new URLSearchParams(globalThis.location?.search ?? "").get("variant");
  return v === "A" || v === "B" || v === "C" ? v : null;
}

// 並び（上から）と高さの割合
export const LAYOUT: Record<Variant, ReadonlyArray<readonly ["evidence" | "todo" | "changes", number]>> = {
  A: [["evidence", 1], ["todo", 1], ["changes", 1]],
  B: [["todo", 35], ["evidence", 35], ["changes", 30]],
  C: [["evidence", 2], ["todo", 1], ["changes", 1]],
};

type Todo = { node: SnapshotNode; who: string | null; at: number | null };

function todosOf(model: Model): ReadonlyArray<Todo> {
  return model.snapshot.nodes
    .filter((n) => n.kind === "TODO")
    .map((node) => ({
      node,
      who: node.assignee ?? (node.assigneeSpeaker === undefined ? null : speakerName(node.assigneeSpeaker)),
      at: model.snapshot.changes.find((c) => c.node === node.id && c.change === "追加")?.at ?? null,
    }));
}

const BUTTON = "todos__button w-full px-0 py-[6px] [border:0] bg-transparent text-inherit [font:inherit] text-left cursor-pointer";

// A: 変わったことの項目と同じ形。上の行に時刻・担当者・期限（灰色）、下に本文
function itemA(h: HtmlBuilder<Message>, t: Todo): ReadonlyArray<Html> {
  return [
    h.span([h.Class("text-gray-500 [font-variant-numeric:tabular-nums]")], [t.at === null ? "" : formatClock(t.at)]),
    t.who === null ? null : h.span([h.Class("font-semibold text-gray-700")], [t.who]),
    t.node.due === undefined ? null : h.span([h.Class("text-gray-500")], [t.node.due]),
    h.span([h.Class("basis-full wrap-anywhere")], [t.node.text]),
  ];
}

// B: 本文を先頭に。下の行に「→ 担当者 · 期限」、右端に時刻
function itemB(h: HtmlBuilder<Message>, t: Todo): ReadonlyArray<Html> {
  const meta = [t.who, t.node.due].filter((p): p is string => p !== null && p !== undefined);
  return [
    h.span([h.Class("basis-full wrap-anywhere")], [t.node.text]),
    h.span([h.Class("flex-1 text-gray-500")], [meta.length === 0 ? "" : `→ ${meta.join(" · ")}`]),
    h.span([h.Class("text-gray-400 [font-variant-numeric:tabular-nums]")], [t.at === null ? "" : formatClock(t.at)]),
  ];
}

// C: 時刻の欄（固定幅）と、本文＋その下の担当者・期限の 2 列
function itemC(h: HtmlBuilder<Message>, t: Todo): ReadonlyArray<Html> {
  const meta = [t.who, t.node.due].filter((p): p is string => p !== null && p !== undefined);
  return [
    h.span([h.Class("flex-none w-[40px] text-gray-500 [font-variant-numeric:tabular-nums]")], [t.at === null ? "" : formatClock(t.at)]),
    h.span([h.Class("flex-1 min-w-0")], [
      h.span([h.Class("block wrap-anywhere")], [t.node.text]),
      meta.length === 0 ? null : h.span([h.Class("block text-[12px] text-gray-500")], [meta.join(" · ")]),
    ]),
  ];
}

const ITEM_CLASS: Record<Variant, string> = {
  A: "flex flex-wrap gap-x-[8px] gap-y-[4px]",
  B: "flex flex-wrap gap-x-[8px] gap-y-[2px]",
  C: "flex gap-x-[8px]",
};

export function todoPanel(h: HtmlBuilder<Message>, model: Model, variant: Variant, grow: number): Html {
  const todos = todosOf(model);
  const item = variant === "A" ? itemA : variant === "B" ? itemB : itemC;
  return h.section(
    [h.Class("todos min-h-0 box-border p-[12px] overflow-y-auto [border-bottom:1px_solid_var(--color-gray-200)]"), h.Style({ flex: `${grow} 1 0` }), h.AriaLabelledBy("todos-heading")],
    [
      h.h2([h.Id("todos-heading"), h.Class("m-0 mb-[8px] text-[14px]")], ["TODO"]),
      todos.length === 0
        ? h.p([h.Class("text-gray-500")], ["TODO はまだありません"])
        : h.ul(
            [h.Class("m-0 p-0 list-none")],
            todos.map((t) =>
              h.keyed("li")(
                t.node.id,
                [h.Class("[border-bottom:1px_solid_var(--color-gray-100)]")],
                [h.button([h.Type("button"), h.Class(`${BUTTON} ${ITEM_CLASS[variant]}`), h.OnClick(Message.ClickedChangeItem({ nodeId: t.node.id }))], item(h, t))],
              ),
            ),
          ),
    ],
  );
}
