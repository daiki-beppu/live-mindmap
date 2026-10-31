import type { ExportNode, JsonExport } from "./export.ts";
import { personLine, todoAssignee, type SpeakerNames } from "./personLine.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const criteriaLine = (node: ExportNode): string => node.criteria?.length ? `（判断軸：${node.criteria.join("・")}）` : "";

function stamp(node: ExportNode): string {
  if (node.evidence.length === 0) return "";
  const sec = Math.floor(Math.min(...node.evidence.map((r) => r.start)));
  return `（${pad(Math.floor(sec / 60))}:${pad(sec % 60)}）`;
}

function todoLabel(node: ExportNode, names: SpeakerNames): string {
  const who = todoAssignee(node, names);
  const meta = [who && `担当：${who}`, node.due && `期限：${node.due}`].filter(Boolean);
  return meta.length > 0 ? `${node.text}（${meta.join("・")}）` : node.text;
}

function walk(node: ExportNode, parent: ExportNode | null = null): { node: ExportNode; parent: ExportNode | null }[] {
  return [{ node, parent }, ...node.children.flatMap((c) => walk(c, node))];
}

const supplementLabel = (node: Extract<ExportNode, { kind: "補足" }>): string => `${node.text}（${node.origin}）`;

function supplementLines(node: ExportNode): string[] {
  return node.children.filter((child) => child.kind === "補足")
    .map((child) => `  - ${supplementLabel(child)}${criteriaLine(child)}${stamp(child)}`);
}

function outline(node: ExportNode, depth: number, names: SpeakerNames): string[] {
  const indent = "  ".repeat(depth);
  const person = personLine(node, names);
  let label: string;
  switch (node.kind) {
    case "決定":
      label = `→ 決定：${node.text}`;
      break;
    case "補足":
      label = supplementLabel(node);
      break;
    case "TODO":
      label = todoLabel(node, names);
      break;
    case "案":
      label = node.planStatus === "却下" ? `~~${node.text}~~` : node.text;
      if (person !== null) label += ` ${person}`;
      break;
    case "論点":
      label = node.pointStatus === "未決" ? `${node.text}（未決）` : node.text;
      break;
    default:
      label = node.text;
  }
  return [`${indent}- ${label}${criteriaLine(node)}${stamp(node)}`, ...node.children.flatMap((c) => outline(c, depth + 1, names))];
}

export function toMarkdown(exp: JsonExport): string {
  const names = exp.speakerNames ?? {};
  const all = walk(exp.root);
  const list = (items: string[]) => (items.length > 0 ? items : ["- なし"]);
  const decisions = all
    .filter(({ node }) => node.kind === "決定")
    .flatMap(({ node, parent }) => [
      `- ${parent ? `${parent.text} → ` : ""}${node.text}${criteriaLine(node)}${stamp(node)}`,
      ...(parent ? supplementLines(parent) : []),
      ...supplementLines(node),
    ]);
  const todos = all.filter(({ node }) => node.kind === "TODO").flatMap(({ node }) => [`- ${todoLabel(node, names)}${stamp(node)}`, ...supplementLines(node)]);
  const open = all
    .filter(({ node }) => node.kind === "論点" && node.pointStatus === "未決")
    .flatMap(({ node }) => [`- ${node.text}${criteriaLine(node)}${stamp(node)}`, ...supplementLines(node)]);
  return [
    `# ${exp.root.text}`,
    "",
    ...(exp.criteria?.length ? ["## 判断軸（優先順）", ...exp.criteria.map((axis, i) => `${i + 1}. ${axis}`), ""] : []),
    "## 決定",
    ...list(decisions),
    "",
    "## TODO",
    ...list(todos),
    "",
    "## 未決の論点",
    ...list(open),
    "",
    "## アウトライン",
    ...list(exp.root.children.flatMap((c) => outline(c, 0, names))),
    "",
  ].join("\n");
}
