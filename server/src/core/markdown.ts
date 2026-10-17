// エクスポート（Markdown）: 人が読む議事録。冒頭に決定・TODO・未決の論点の一覧、その後にアウトライン。
// 根拠は、根拠の発言のうち最も早い時刻だけを（mm:ss）で示す。
import type { ExportNode, JsonExport } from "./export.ts";
import { personLine, todoAssignee, type SpeakerNames } from "./personLine.ts";

const pad = (n: number) => String(n).padStart(2, "0");

// 60 分を超えても、分は 60 以上のまま出す
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

// 深さ優先の順に、親を添えて平らにする
function walk(node: ExportNode, parent: ExportNode | null = null): { node: ExportNode; parent: ExportNode | null }[] {
  return [{ node, parent }, ...node.children.flatMap((c) => walk(c, node))];
}

function outline(node: ExportNode, depth: number, names: SpeakerNames): string[] {
  const indent = "  ".repeat(depth);
  const person = personLine(node, names);
  let label: string;
  switch (node.kind) {
    case "決定":
      label = `→ 決定：${node.text}`;
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
  return [`${indent}- ${label}${stamp(node)}`, ...node.children.flatMap((c) => outline(c, depth + 1, names))];
}

export function toMarkdown(exp: JsonExport): string {
  const names = exp.speakerNames ?? {};
  const all = walk(exp.root);
  const list = (items: string[]) => (items.length > 0 ? items : ["- なし"]);
  const decisions = all
    .filter(({ node }) => node.kind === "決定")
    .map(({ node, parent }) => `- ${parent ? `${parent.text} → ` : ""}${node.text}${stamp(node)}`);
  const todos = all.filter(({ node }) => node.kind === "TODO").map(({ node }) => `- ${todoLabel(node, names)}${stamp(node)}`);
  const open = all
    .filter(({ node }) => node.kind === "論点" && node.pointStatus === "未決")
    .map(({ node }) => `- ${node.text}${stamp(node)}`);
  return [
    `# ${exp.root.text}`,
    "",
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
