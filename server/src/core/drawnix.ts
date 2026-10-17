// エクスポート（Drawnix）: drawnix.com で開いて直せるマインドマップ。根拠・状態は含めない。
// Drawnix が読み込みで確かめるのは type・elements が配列・viewport がオブジェクトの 3 点だけ。
import type { ExportNode, JsonExport } from "./export.ts";
import type { Kind } from "./map.ts";
import { personLine, speakerName, type SpeakerNames } from "./personLine.ts";

// 種別ごとに 1 色。ノードの淡い塗り・枠・親からの枝をこの色で揃える（表示の色もこれに合わせる）。
// 色相は 議題=青、論点=黄、課題=赤、案=紫、決定=緑。TODO は資料に定めがないので橙、要点=桃。
export const KIND_COLORS: Record<Kind, { fill: string; stroke: string }> = {
  議題: { fill: "#dbeafe", stroke: "#3b82f6" },
  論点: { fill: "#fef9c3", stroke: "#eab308" },
  課題: { fill: "#fee2e2", stroke: "#ef4444" },
  案: { fill: "#f3e8ff", stroke: "#a855f7" },
  決定: { fill: "#dcfce7", stroke: "#22c55e" },
  TODO: { fill: "#ffedd5", stroke: "#f97316" },
  要点: { fill: "#f1f5f9", stroke: "#94a3b8" },
};

export type DrawnixElement = {
  id: string;
  type: "mindmap" | "mind_child";
  data: { topic: { children: { text: string; color?: string }[] } };
  children: DrawnixElement[];
  points?: [number, number][];
  layout?: "right";
  fill?: string;
  strokeColor?: string;
  branchColor?: string;
};

export type DrawnixFile = {
  type: "drawnix";
  version: 1;
  source: "web";
  elements: DrawnixElement[];
  viewport: { zoom: number };
};

// 人の行の薄い文字（画面の text-gray-500）
const PERSON_COLOR = "#6b7280";

// 話者を持つ（人を出す）セッションのエクスポートか。古いセッションの書き出しを変えないための印。
// 根拠発言の話者、担当の話者、人を表す案の出した人（話者なしの "相手" は人ではない）のどれかが木にあれば true
function hasSpeakers(node: ExportNode): boolean {
  return (
    node.evidence.some((r) => r.speaker !== undefined) ||
    node.assigneeSpeaker !== undefined ||
    (node.proposer !== undefined && speakerName(node.proposer) !== null) ||
    node.children.some(hasSpeakers)
  );
}

function toElement(node: ExportNode, isRoot: boolean, names: SpeakerNames, speakers: boolean): DrawnixElement {
  const el: DrawnixElement = {
    id: node.id,
    type: isRoot ? "mindmap" : "mind_child",
    data: { topic: { children: [{ text: node.text }] } },
    children: node.children.map((c) => toElement(c, false, names, speakers)),
  };
  const person = speakers ? personLine(node, names) : null;
  if (person !== null) el.data.topic.children.push({ text: ` ${person}`, color: PERSON_COLOR });
  if (isRoot) {
    el.points = [[0, 0]];
    el.layout = "right";
  }
  const color = node.kind === "会議" ? undefined : KIND_COLORS[node.kind];
  if (color) {
    el.fill = color.fill;
    el.strokeColor = color.stroke;
    el.branchColor = color.stroke;
  }
  return el;
}

export function toDrawnix(exp: JsonExport): DrawnixFile {
  return { type: "drawnix", version: 1, source: "web", elements: [toElement(exp.root, true, exp.speakerNames ?? {}, hasSpeakers(exp.root))], viewport: { zoom: 1 } };
}
