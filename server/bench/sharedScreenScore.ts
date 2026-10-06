// 試作（#183、使い捨て）: sharedScreenRun.ts のランを、screen.truth.json と truth.json で採点する。
//   node server/bench/sharedScreenScore.ts <セッションのフォルダ>...
// 指す発言・話だけ: どの種別でも、根拠の発言が区間と重なり、キーワードを全部含むノードがあれば当たり（照合は回帰評価と同じ）。
// 出てはいけない: 時刻を問わず、キーワードのどれかを本文に含むノードがあれば漏れ
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTruth, recall, type ExportNode, type JsonExport } from "../src/core/index.ts";

const SAMPLE = join(homedir(), "live-mindmap-samples/synth/screen");
const MEETING_HOURS = 1372 / 3600;
type Item = { text: string; from: number; to: number; keywords: (string | string[])[]; memory?: boolean; remark?: string };
const screen = JSON.parse(readFileSync(join(SAMPLE, "screen.truth.json"), "utf8")) as Record<"指す発言" | "話だけ" | "出てはいけない", Item[]>;
const truth = parseTruth(JSON.parse(readFileSync(join(SAMPLE, "truth.json"), "utf8")));
const norm = (s: string) => s.normalize("NFKC").replace(/\s/g, "");
const alts = (k: string | string[]) => (Array.isArray(k) ? k : [k]);

const nodesOf = (exp: JsonExport) => {
  const all: ExportNode[] = [];
  const walk = (n: ExportNode) => n.children.forEach((c) => (all.push(c), walk(c)));
  walk(exp.root);
  return all;
};
const hits = (nodes: ExportNode[], it: Item) =>
  nodes.filter((n) => n.evidence.some((r) => r.start <= it.to && r.end >= it.from) && it.keywords.every((k) => alts(k).some((a) => norm(n.text).includes(norm(a)))));

const rows: string[][] = [];
const detail: string[] = [];
for (const dir of process.argv.slice(2)) {
  const exp = JSON.parse(readFileSync(join(dir, "map.json"), "utf8")) as JsonExport;
  const stats = JSON.parse(readFileSync(join(dir, "stats.json"), "utf8"));
  const nodes = nodesOf(exp);
  const point = screen.指す発言.map((it) => hits(nodes, it));
  const spoken = screen.話だけ.map((it) => hits(nodes, it));
  const leaked = screen.出てはいけない.map((it) => nodes.filter((n) => it.keywords.some((k) => alts(k).some((a) => norm(n.text).includes(norm(a))))));
  const r = recall(exp, truth);
  const count = (xs: unknown[][]) => xs.filter((x) => x.length > 0).length;
  const memIdx = screen.指す発言.flatMap((it, i) => (it.memory ? [i] : []));
  rows.push([
    `${stats.mode} ${dir.split("/").slice(-2, -1)[0]}`,
    `${count(point)}/${point.length}`,
    `${memIdx.filter((i) => point[i]!.length).length}/${memIdx.length}`,
    `${count(spoken)}/${spoken.length}`,
    `${count(leaked)}/${leaked.length}`,
    `${r.決定.hit}/${r.決定.total}`, `${r.TODO.hit}/${r.TODO.total}`,
    String(nodes.length),
    `$${stats.cost.toFixed(2)}`, `$${(stats.cost / MEETING_HOURS).toFixed(2)}`,
    String(stats.screensSent.length),
  ]);
  detail.push(`### ${stats.mode} ${dir}`);
  screen.指す発言.forEach((it, i) => detail.push(`- ${point[i]!.length ? "○" : "×"} ${Math.round(it.from)}s ${it.text}${point[i]!.length ? ` ← ${point[i]![0]!.kind}: ${point[i]![0]!.text}` : ""}`));
  leaked.forEach((ns, i) => ns.length && detail.push(`- 漏れ: ${screen.出てはいけない[i]!.text} ← ${ns.map((n) => `${n.kind}: ${n.text}`).join(" / ")}`));
}
const head = ["ラン", "指す発言", "うち記憶", "話だけ", "出てはいけない", "決定", "TODO", "ノード", "費用(22分)", "費用/時", "画面を送った回数"];
const line = (c: string[]) => `| ${c.join(" | ")} |`;
console.log([line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n") + "\n\n" + detail.join("\n"));
