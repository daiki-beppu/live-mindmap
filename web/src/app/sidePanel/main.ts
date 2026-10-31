import { Disclosure } from "@foldkit/ui";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { formatClock } from "../../changes.ts";
import { evidenceOf, type Evidence } from "../../evidence.ts";
import { todoAssignee } from "../../../../server/src/core/index.ts";
import type { Model } from "../mapSurface/main.ts";
import { Message } from "../mapSurface/message.ts";

function evidenceBody(h: HtmlBuilder<Message>, { node, remarks }: Evidence): ReadonlyArray<Html> {
  const status = node.kind === "論点" ? node.pointStatus : node.kind === "案" ? node.planStatus : undefined;
  return [
    h.p([h.Class("evidence__meta")], [h.span([h.Class("evidence__kind")], [node.kind]), status ? h.span([h.Class("evidence__status")], [status]) : null]),
    h.p([h.Class("evidence__text")], [node.text]),
    remarks.length === 0
      ? h.p([h.Class("evidence__empty")], ["根拠の発言はありません"])
      : h.ul(
          [],
          remarks.map((r) =>
            h.keyed("li")(
              r.id,
              [h.Class("evidence__remark")],
              [
                h.span([h.Class("evidence__time")], [`${formatClock(r.start)}〜${formatClock(r.end)}`]),
                h.span([h.Class("evidence__track")], [r.track]),
                h.span([h.Class("evidence__remark-text")], [r.text]),
              ],
            ),
          ),
        ),
  ];
}

function evidencePanel(h: HtmlBuilder<Message>, model: Model): Html {
  const selectedId = model.viewing.selection?.id ?? null;
  const evidence = selectedId === null ? null : evidenceOf(model.snapshot, selectedId, model.viewing.humanFolds);
  return h.section(
    [h.Class("evidence"), h.AriaLabelledBy("evidence-heading")],
    [
      h.h2([h.Id("evidence-heading")], [evidence?.node.origin === "会議の外" ? "この語が話された発言" : "根拠"]),
      selectedId === null ? null : h.button([h.Type("button"), h.Class("side__close"), h.OnClick(Message.ClickedEvidenceClose())], ["閉じる"]),
      ...(selectedId === null
        ? [h.p([h.Class("evidence__empty")], ["ノードを選ぶと、根拠の発言が出ます"])]
        : evidence === null
          ? [h.p([h.Class("evidence__empty")], ["選んだノードは今のマップにありません"])]
          : evidenceBody(h, evidence)),
    ],
  );
}

function todoList(h: HtmlBuilder<Message>, model: Model): Html {
  const todos = model.snapshot.nodes.filter((n) => n.kind === "TODO");
  return h.section(
    [h.Class("todos"), h.AriaLabelledBy("todos-heading")],
    [
      h.h2([h.Id("todos-heading")], ["TODO"]),
      todos.length === 0
        ? h.p([h.Class("todos__empty")], ["TODO はまだありません"])
        : h.ul(
            [],
            todos.map((node) => {
              const at = model.snapshot.changes.find((c) => c.node === node.id && c.change === "追加")?.at;
              const who = todoAssignee(node, model.speakerNames);
              return h.keyed("li")(
                node.id,
                [h.Class("todos__item")],
                [
                  h.button(
                    [h.Type("button"), h.Class("todos__button"), h.OnClick(Message.ClickedChangeItem({ nodeId: node.id }))],
                    [
                      at === undefined ? null : h.time([h.Class("todos__time")], [formatClock(at)]),
                      who === null ? null : h.span([h.Class("todos__assignee")], [who]),
                      node.due === undefined ? null : h.span([h.Class("todos__due")], [node.due]),
                      h.span([h.Class("todos__text")], [node.text]),
                    ],
                  ),
                ],
              );
            }),
          ),
    ],
  );
}

function changeList(h: HtmlBuilder<Message>, model: Model): Html {
  return h.aside(
    [h.Class("changes"), h.AriaLabelledBy("changes-heading")],
    [
      h.h2([h.Id("changes-heading")], ["変わったこと"]),
      h.ul(
        [],
        [...model.snapshot.changes].reverse().map((c) =>
          h.keyed("li")(
            `${c.round}-${c.node}-${c.change}`,
            [h.Class("changes__item")],
            [
              h.button(
                [h.Type("button"), h.Class("changes__button"), h.OnClick(Message.ClickedChangeItem({ nodeId: c.node }))],
                [
                  h.time([h.Class("changes__time")], [formatClock(c.at)]),
                  h.span([h.Class("changes__type")], [c.change]),
                  h.span([h.Class("changes__kind")], [c.kind]),
                  h.span([h.Class("changes__text")], [c.text]),
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
      toView: ({ panel }) => (model.viewing.sideHidden === true && model.viewing.selection === undefined ? null : h.div([h.Class(["side", model.viewing.selection === undefined ? "" : "side--selected", model.viewing.sideHidden === true ? "side--hidden" : ""].join(" ")), ...panel], [evidencePanel(h, model), todoList(h, model), changeList(h, model)])),
    },
    h,
  ),
);
