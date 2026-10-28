// Drawnix が読み込みで確かめるのは type・elements が配列・viewport がオブジェクトの 3 点だけ。
import type { ExportNode, JsonExport } from "./export.ts";
import type { Kind } from "./map.ts";
import { personLine, speakerName, type SpeakerNames } from "./personLine.ts";

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

const PERSON_COLOR = "#6b7280";

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
  if (node.criteria?.length) el.data.topic.children.push({ text: ` 判断軸：${node.criteria.join("・")}`, color: PERSON_COLOR });
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
