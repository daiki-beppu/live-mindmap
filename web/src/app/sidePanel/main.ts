// 右の列（Issue #821）: 選んだノードの根拠のパネルと、TODO の一覧と、変わったことの列（上からこの順）。出す・隠すは Disclosure。
// Model と update は持たない。見る状態（選択・人の開閉・sideHidden）は表示面の Model が持つので、その Model から毎回導いて描く。
// 要素・class・文言は React 版（EvidencePanel・ChangeList・SessionView、Issue #829 で削除）から変えない
import { Disclosure } from "@foldkit/ui";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { formatClock } from "../../changes.ts";
import { evidenceOf, type Evidence } from "../../evidence.ts";
import { todoAssignee } from "../../../../server/src/core/index.ts";
import { humanSetsOf } from "../../viewing.ts";
import type { Model } from "../mapSurface/main.ts";
import { Message } from "../mapSurface/message.ts";

function evidenceBody(h: HtmlBuilder<Message>, { node, remarks }: Evidence): ReadonlyArray<Html> {
  const status = node.kind === "論点" ? node.pointStatus : node.kind === "案" ? node.planStatus : undefined;
  return [
    h.p([h.Class("evidence__meta")], [h.span([h.Class("evidence__kind font-semibold")], [node.kind]), status ? h.span([h.Class("evidence__status ml-[8px] text-gray-500")], [status]) : null]),
    h.p([h.Class("evidence__text wrap-anywhere")], [node.text]),
    remarks.length === 0
      ? h.p([h.Class("evidence__empty text-gray-500")], ["根拠の発言はありません"])
      : h.ul(
          [],
          remarks.map((r) =>
            h.keyed("li")(
              r.id,
              [h.Class("evidence__remark flex flex-wrap gap-x-[8px] gap-y-[4px] py-[6px] [border-bottom:1px_solid_var(--color-gray-100)]")],
              [
                h.span([h.Class("evidence__time text-gray-500 [font-variant-numeric:tabular-nums]")], [`${formatClock(r.start)}〜${formatClock(r.end)}`]),
                h.span([h.Class("evidence__track font-semibold")], [r.track]),
                h.span([h.Class("evidence__remark-text basis-full wrap-anywhere")], [r.text]),
              ],
            ),
          ),
        ),
  ];
}

function evidencePanel(h: HtmlBuilder<Message>, model: Model): Html {
  const selectedId = model.viewing.selection?.id ?? null;
  const { opened, folded, unbundled } = humanSetsOf(model.viewing);
  const evidence = selectedId === null ? null : evidenceOf(model.snapshot, selectedId, opened, folded, unbundled);
  return h.section(
    [h.Class("evidence flex-1 min-h-0 box-border p-[12px] overflow-y-auto "+"[border-bottom:1px_solid_var(--color-gray-200)]"), h.AriaLabelledBy("evidence-heading")],
    [
      h.h2([h.Id("evidence-heading")], ["根拠"]),
      selectedId === null ? null : h.button([h.Type("button"), h.Class("side__close"), h.OnClick(Message.ClickedEvidenceClose())], ["閉じる"]),
      ...(selectedId === null
        ? [h.p([h.Class("evidence__empty text-gray-500")], ["ノードを選ぶと、根拠の発言が出ます"])]
        : evidence === null
          ? [h.p([h.Class("evidence__empty text-gray-500")], ["選んだノードは今のマップにありません"])]
          : evidenceBody(h, evidence)),
    ],
  );
}

// スナップショットの TODO を、ノードの並び（作られた順）で出す。畳まれた議題の下も含む。時刻は、そのノードの「追加」の変わったことの時刻
function todoList(h: HtmlBuilder<Message>, model: Model): Html {
  const todos = model.snapshot.nodes.filter((n) => n.kind === "TODO");
  return h.section(
    [h.Class("todos flex-1 min-h-0 box-border p-[12px] overflow-y-auto [border-bottom:1px_solid_var(--color-gray-200)]"), h.AriaLabelledBy("todos-heading")],
    [
      h.h2([h.Id("todos-heading")], ["TODO"]),
      todos.length === 0
        ? h.p([h.Class("todos__empty text-gray-500")], ["TODO はまだありません"])
        : h.ul(
            [],
            todos.map((node) => {
              const at = model.snapshot.changes.find((c) => c.node === node.id && c.change === "追加")?.at;
              const who = todoAssignee(node, model.speakerNames);
              return h.keyed("li")(
                node.id,
                [h.Class("todos__item [border-bottom:1px_solid_var(--color-gray-100)]")],
                [
                  h.button(
                    [h.Type("button"), h.Class("todos__button flex flex-wrap gap-x-[8px] gap-y-[4px] w-full px-0 py-[6px] [border:0] bg-transparent text-inherit [font:inherit] text-left cursor-pointer"), h.OnClick(Message.ClickedChangeItem({ nodeId: node.id }))],
                    [
                      at === undefined ? null : h.time([h.Class("todos__time text-gray-500 [font-variant-numeric:tabular-nums]")], [formatClock(at)]),
                      who === null ? null : h.span([h.Class("todos__assignee font-semibold")], [who]),
                      node.due === undefined ? null : h.span([h.Class("todos__due text-gray-500")], [node.due]),
                      h.span([h.Class("todos__text basis-full wrap-anywhere")], [node.text]),
                    ],
                  ),
                ],
              );
            }),
          ),
    ],
  );
}

// 新しい順（積んだ順の逆）。Snapshot の並びは書き換えない
function changeList(h: HtmlBuilder<Message>, model: Model): Html {
  return h.aside(
    [h.Class("changes flex-1 min-h-0 box-border p-[12px] overflow-y-auto"), h.AriaLabelledBy("changes-heading")],
    [
      h.h2([h.Id("changes-heading")], ["変わったこと"]),
      h.ul(
        [],
        [...model.snapshot.changes].reverse().map((c) =>
          h.keyed("li")(
            `${c.round}-${c.node}-${c.change}`,
            [h.Class("changes__item [border-bottom:1px_solid_var(--color-gray-100)]")],
            [
              h.button(
                [h.Type("button"), h.Class("changes__button flex flex-wrap gap-x-[8px] gap-y-[4px] w-full px-0 py-[6px] [border:0] bg-transparent text-inherit [font:inherit] text-left cursor-pointer"), h.OnClick(Message.ClickedChangeItem({ nodeId: c.node }))],
                [
                  h.time([h.Class("changes__time text-gray-500 [font-variant-numeric:tabular-nums]")], [formatClock(c.at)]),
                  h.span([h.Class("changes__type font-semibold text-gray-700")], [c.change]),
                  h.span([h.Class("changes__kind text-gray-500")], [c.kind]),
                  h.span([h.Class("changes__text basis-full wrap-anywhere")], [c.text]),
                ],
              ),
            ],
          ),
        ),
      ),
    ],
  );
}

export const view = Submodel.defineView<Model, Message>((model, h): Html | null =>
  Disclosure.view(
    {
      id: "side",
      isOpen: model.viewing.sideHidden !== true,
      onToggle: (isOpen) => Message.ToggledSide({ isOpen }),
      // 隠していて選んでいないときは .side ごと描かない（animatePanel は使わない）。
      // 隠していて選んでいるときは side--hidden を付けて描く（狭い幅の会議中だけ、根拠のシートとして出す）
      toView: ({ panel }) => (model.viewing.sideHidden === true && model.viewing.selection === undefined ? null : h.div([h.Class(`side${model.viewing.selection === undefined ? "" : " side--selected"}${model.viewing.sideHidden === true ? " side--hidden" : ""} flex-none w-[300px] h-full flex flex-col [border-left:1px_solid_var(--color-gray-200)] text-[13px] text-gray-900`), ...panel], [evidencePanel(h, model), todoList(h, model), changeList(h, model)])),
    },
    h,
  ),
);
