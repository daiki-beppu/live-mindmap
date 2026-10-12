// 右の列（Issue #821）: 選んだノードの根拠のパネルと、変わったことの列。出す・隠すは Disclosure。
// Model と update は持たない。見る状態（選択・人の開閉・sideHidden）は表示面の Model が持つので、その Model から毎回導いて描く。
// 要素・class・文言は React 版（EvidencePanel・ChangeList・SessionView、Issue #829 で削除）から変えない
import { Disclosure } from "@foldkit/ui";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { formatClock } from "../../changes.ts";
import { evidenceOf, type Evidence } from "../../evidence.ts";
import { humanSetsOf } from "../../viewing.ts";
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
  const { opened, folded, unbundled } = humanSetsOf(model.viewing);
  const evidence = selectedId === null ? null : evidenceOf(model.snapshot, selectedId, opened, folded, unbundled);
  return h.section(
    [h.Class("evidence"), h.AriaLabelledBy("evidence-heading")],
    [
      h.h2([h.Id("evidence-heading")], ["根拠"]),
      ...(selectedId === null
        ? [h.p([h.Class("evidence__empty")], ["ノードを選ぶと、根拠の発言が出ます"])]
        : evidence === null
          ? [h.p([h.Class("evidence__empty")], ["選んだノードは今のマップにありません"])]
          : evidenceBody(h, evidence)),
    ],
  );
}

// 新しい順（積んだ順の逆）。Snapshot の並びは書き換えない
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
      // 隠しているときは .side ごと描かない（animatePanel は使わない）
      toView: ({ panel }) => (model.viewing.sideHidden === true ? null : h.div([h.Class("side"), ...panel], [evidencePanel(h, model), changeList(h, model)])),
    },
    h,
  ),
);
