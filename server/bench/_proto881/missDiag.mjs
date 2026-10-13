// PROTOTYPE（#881）— 合成会議の正解ごとに、マップのどのノードが当たり／惜しかったかを出す（合成会議だけ。evaluate.ts の matches と同じ条件）
// node missDiag.mjs <truth.json> <export.json>...
import { readFileSync } from "node:fs";
const norm = (s) => s.normalize("NFKC").replace(/\s+/g, "");
const has = (b, k) => (Array.isArray(k) ? k : [k]).some((a) => b.includes(norm(a)));
const [truthPath, ...exps] = process.argv.slice(2);
const truth = JSON.parse(readFileSync(truthPath));
for (const p of exps) {
  const nodes = []; const walk = (n) => { nodes.push(n); for (const c of n.children ?? []) walk(c); };
  walk(JSON.parse(readFileSync(p)).root);
  console.log(`## ${p.split("/").slice(-2).join("/")}`);
  for (const kind of ["決定", "TODO"]) truth[kind].forEach((it, i) => {
    const near = (n) => n.evidence.some((r) => r.start <= it.to && r.end >= it.from);
    const kw = (n) => it.keywords.every((k) => has(norm(n.text), k));
    const hit = nodes.filter((n) => n.kind === kind && near(n) && kw(n));
    const otherKind = nodes.filter((n) => n.kind !== kind && near(n) && kw(n));
    const kwOnly = nodes.filter((n) => n.kind === kind && !near(n) && kw(n));
    const nearKind = nodes.filter((n) => n.kind === kind && near(n) && !kw(n));
    console.log(`${kind}${i + 1} 当たり ${hit.length} | 種別違い ${otherKind.map((n) => n.kind).join(",") || "-"} | 時刻外 ${kwOnly.length} | 語が合わない同種 ${nearKind.length}${nearKind.length ? "（" + nearKind.map((n) => n.text).join(" / ") + "）" : ""}`);
  });
}
