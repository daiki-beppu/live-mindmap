// PROTOTYPE — 案 C: Plait（Drawnix の中身）。マインドマップ編集器のボードに、マップを MindElement の木として丸ごと渡し直す。
// 種別は fill / strokeColor / branchColor で、変化は枠の太さで表す。値を渡し直すと Wrapper が fitViewport する（アニメーションなし）。
import { useMemo } from "react";
import { Board, Wrapper } from "@plait-board/react-board";
import { BoardTransforms, getSelectedElements, type PlaitBoardOptions, type PlaitElement, type PlaitPlugin } from "@plait/core";
import { MindThemeColors, withMind, type MindElement } from "@plait/mind";
import { MindLayoutType } from "@plait/layouts";
import { withGroup } from "@plait/common";
import { withDraw } from "@plait/draw";
import "../node_modules/@plait-board/react-board/index.css";
import "../node_modules/@plait-board/react-text/index.css";
import { KIND_STYLE, type View } from "./data";
import type { VariantProps } from "./App";

const plugins: PlaitPlugin[] = [withDraw, withGroup, withMind];
const options: PlaitBoardOptions = { readonly: true, hideScrollbar: true, disabledScrollOnNonFocus: false, themeColors: MindThemeColors };

function toMind(view: View, id: string, showHot: boolean): MindElement {
  const n = view.byId[id]!;
  const k = KIND_STYLE[n.kind]!;
  const status = n.status === "決定済み" ? "✅ " : n.status === "未決" ? "⏳ " : n.status === "却下" ? "✕ " : "";
  const label = n.kind === "会議" ? n.text : `${k.icon}${n.kind}｜${status}${n.text}${n.kind === "TODO" && n.assignee ? `（${n.assignee}）` : ""}`;
  const fresh = n.changeAge === 0, recent = n.changeAge !== undefined && n.changeAge <= 3;
  const el: any = {
    id,
    type: id === "root" ? "mindmap" : "mind_child",
    data: { topic: { children: [{ text: label }] } },
    children: (view.children[id] ?? []).map((c) => toMind(view, c, showHot)),
    fill: n.status === "却下" ? "#f3f4f6" : k.bg,
    strokeColor: showHot && n.hot ? "#f59e0b" : fresh ? "#ef4444" : recent ? "#f97316" : k.color,
    strokeWidth: fresh || (showHot && n.hot) ? 5 : recent ? 3 : 1,
    branchColor: k.color,
    manualWidth: 360, // 折り返し幅。指定しないと 1 行で横に伸びる
  };
  if (id === "root") { el.points = [[0, 0]]; el.layout = MindLayoutType.right; }
  return el;
}

export function VariantPlait({ view, onSelect, showHot }: VariantProps) {
  // 反映が変わったときだけ値を作り直す（Wrapper は値が変わるたびに再描画と fitViewport をする）
  const value = useMemo<PlaitElement[]>(() => [toMind(view, "root", showHot) as unknown as PlaitElement], [view.step, showHot, view.nodes.some((n) => n.hot)]);
  return (
    <div className="plait-host">
      <Wrapper
        value={value} options={options} plugins={plugins}
      >
        <Board afterInit={(board) => {
          setTimeout(() => BoardTransforms.fitViewport(board), 0);
          const orig = board.pointerUp;
          board.pointerUp = (e) => {
            orig(e);
            const s = getSelectedElements(board)[0];
            onSelect(s ? (s.id as string) : null);
          };
        }} />
      </Wrapper>
    </div>
  );
}
