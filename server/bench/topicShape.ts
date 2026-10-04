// PROTOTYPE（issue #137 の試作）: longMeetingProto.ts の出力から、時点ごとのマップの形を測る。
//   node bench/topicShape.ts <出力フォルダ>...
// 議題の数（話し中 / 済み）、最大の議題の子孫の数、子が最も多い親の子の数、深さ、閉じる・開き直しの回数を、30 分ごとに出す。
// issue #152: 議題の入れ子も測る（会議の直下の子の数、子の議題を持つ親の議題の数と子の議題の数、3 段以上の議題）。最大の議題は子の議題の下を数えない。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Node = { id: string; parent: string | null; kind: string; text: string };
const jsonl = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const dir of process.argv.slice(2)) {
  const closes = jsonl(join(dir, "closes.jsonl"));
  const snaps = readdirSync(join(dir, "snapshots")).sort();
  const marks = snaps.filter((f, i) => Number(f.slice(0, 3)) % 30 === 0 || i === snaps.length - 1);
  console.log(`## ${dir.replace(/^.*\//, "")}`);
  console.log("| 分 | ノード | 議題（話し中/済み） | 会議の直下 | 親の議題（子の議題の数） | 3 段目の議題 | 最大の議題 | 子が最も多い親 | 深さ | 閉じる累計 | 開き直し累計 |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const f of marks) {
    const min = Number(f.slice(0, 3));
    const nodes: Node[] = JSON.parse(readFileSync(join(dir, "snapshots", f), "utf8")).nodes;
    const by = new Map<string, Node[]>();
    for (const n of nodes) if (n.parent) by.set(n.parent, [...(by.get(n.parent) ?? []), n]);
    const size = (id: string): number => (by.get(id) ?? []).reduce((a, c) => a + (c.kind === "議題" ? 0 : 1 + size(c.id)), 0);
    const kind = (id: string | null) => nodes.find((x) => x.id === id)?.kind;
    const depth = (n: Node): number => { let d = 0; for (let c: Node | undefined = n; c?.parent; c = nodes.find((x) => x.id === c!.parent)) d++; return d; };
    // 済みは closes.jsonl を時刻まで当てて決める
    const closed = new Set<string>();
    let nClose = 0, nReopen = 0;
    for (const e of closes) {
      if (e.at > min * 60) break;
      if (e.type === "close") { closed.add(e.node); nClose++; }
      if (e.type === "reopen") { closed.delete(e.node); nReopen++; }
    }
    const topics = nodes.filter((n) => n.kind === "議題");
    const biggest = topics.map((t) => [size(t.id), t.text] as const).sort((a, b) => b[0] - a[0])[0];
    const fan = nodes.filter((n) => n.kind !== "会議").map((n) => [(by.get(n.id) ?? []).length, n.text] as const).sort((a, b) => b[0] - a[0])[0];
    const open = topics.filter((t) => !closed.has(t.id)).length;
    const top = nodes.filter((n) => kind(n.parent) === "会議").length;
    const parents = topics.map((t) => [(by.get(t.id) ?? []).filter((c) => c.kind === "議題").length, t.text] as const).filter(([k]) => k > 0).sort((a, b) => b[0] - a[0]);
    const deep = topics.filter((t) => kind(t.parent) === "議題" && kind(nodes.find((x) => x.id === t.parent)!.parent) === "議題").length;
    const parentsText = parents.length ? parents.map(([k, t]) => `${t}（${k}）`).join("、") : "-";
    console.log(`| ${min} | ${nodes.length - 1} | ${topics.length}（${open}/${topics.length - open}） | ${top} | ${parentsText} | ${deep} | ${biggest ? `${biggest[0]}「${biggest[1]}」` : "-"} | ${fan ? `${fan[0]}「${fan[1]}」` : "-"} | ${Math.max(0, ...nodes.map(depth))} | ${nClose} | ${nReopen} |`);
  }
  const dropped = closes.filter((e) => e.type === "close-dropped").length;
  console.log(`\n閉じるが無効になった回数: ${dropped}\n`);
}
