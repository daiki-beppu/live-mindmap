// 回帰評価: 再生したマップの指標と、正解の決定・TODO に対する再現率。Node に依存しない（ADR 0003）。
import type { ExportNode, JsonExport } from "./export.ts";
import { KINDS, type Kind } from "./map.ts";

// 正解は人が書く。from / to は会議の中の秒（Remark.start / end と同じ単位）。text は人が読むためで、照合には使わない。
export type TruthItem = { text: string; from: number; to: number };
export const TRUTH_KINDS = ["決定", "TODO"] as const satisfies readonly Kind[];
export type TruthKind = (typeof TRUTH_KINDS)[number];
export type Truth = Record<TruthKind, TruthItem[]>;

export type Metrics = { nodes: number; depth: number; byKind: Record<Kind, number> };
export type Recall = { hit: number; total: number };
export type Run = { name: string; title: string; exp: JsonExport };

// JSON.parse した正解を検証して Truth にする。形が違えば Error（呼び出し側がファイルのパスを添える）
export function parseTruth(raw: unknown): Truth {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("正解はオブジェクトで書く");
  const obj = raw as Record<string, unknown>;
  const truth = {} as Truth;
  for (const kind of TRUTH_KINDS) {
    const list = obj[kind];
    if (!Array.isArray(list)) throw new Error(`「${kind}」は配列で書く`);
    truth[kind] = list.map((item, i) => {
      const { text, from, to } = (item ?? {}) as Record<string, unknown>;
      const at = `「${kind}」の ${i + 1} 件目`;
      if (typeof from !== "number" || typeof to !== "number") throw new Error(`${at}: from / to は秒の数値で書く`);
      if (from > to) throw new Error(`${at}: from が to より大きい`);
      return { text: typeof text === "string" ? text : "", from, to };
    });
  }
  return truth;
}

const walk = (node: ExportNode, depth: number, visit: (n: ExportNode, depth: number) => void) => {
  for (const c of node.children) {
    visit(c, depth + 1);
    walk(c, depth + 1, visit);
  }
};

// ノード数はルートを除く。深さはルートの子を 1 とし、ノードが無ければ 0
export function measure(exp: JsonExport): Metrics {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
  let nodes = 0;
  let depth = 0;
  walk(exp.root, 0, (n, d) => {
    nodes++;
    depth = Math.max(depth, d);
    if (n.kind !== "会議") byKind[n.kind]++;
  });
  return { nodes, depth, byKind };
}

// 同じ種別のノードの根拠の発言のどれか 1 つが正解の区間と重なる（端が接するのも重なり）なら再現できた
export function recall(exp: JsonExport, truth: Truth): Record<TruthKind, Recall> {
  const nodes: ExportNode[] = [];
  walk(exp.root, 0, (n) => nodes.push(n));
  return Object.fromEntries(
    TRUTH_KINDS.map((kind) => {
      const evidence = nodes.filter((n) => n.kind === kind).flatMap((n) => n.evidence);
      const hit = truth[kind].filter(({ from, to }) => evidence.some((r) => r.start <= to && r.end >= from)).length;
      return [kind, { hit, total: truth[kind].length }];
    }),
  ) as Record<TruthKind, Recall>;
}

const RECALL_HEADERS: Record<TruthKind, string> = { 決定: "決定の再現率", TODO: "TODO の再現率" };

const formatRecall = ({ hit, total }: Recall) => (total === 0 ? "0/0" : `${hit}/${total} (${Math.round((hit / total) * 100)}%)`);

// 表のセルに入れる文字列。区切りの `|` と、その直前の `\` をエスケープし、改行は空白 1 つにして 1 行に保つ
const escapeCell = (cell: string) => cell.replace(/[\\|]/g, "\\$&").replace(/\r\n|\r|\n/g, " ");

// 1 ラン 1 行の Markdown の表。truth があるときだけ再現率の列を足す
export function formatTable(runs: Run[], truth?: Truth): string {
  const header = ["ラン", "会議", "ノード", "深さ", ...KINDS, ...(truth ? TRUTH_KINDS.map((k) => RECALL_HEADERS[k]) : [])];
  const rows = runs.map(({ name, title, exp }) => {
    const m = measure(exp);
    const recalls = truth ? TRUTH_KINDS.map((k) => formatRecall(recall(exp, truth)[k])) : [];
    return [name, title, m.nodes, m.depth, ...KINDS.map((k) => m.byKind[k]), ...recalls].map(String);
  });
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}
