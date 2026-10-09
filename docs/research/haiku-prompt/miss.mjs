// 使い方: node miss.mjs <truth.json> <session dir>...  正解ごとに当たり/外れ、外れなら区間に根拠が重なるノード（種別と本文）を出す
import { readFileSync, readdirSync } from "node:fs";
const norm = (s) => s.normalize("NFKC").replace(/\s+/g, "");
const has = (b, k) => (Array.isArray(k) ? k : [k]).some((a) => b.includes(norm(a)));
const truth = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const dir of process.argv.slice(3)) {
  const sub = readdirSync(dir)[0];
  const exp = JSON.parse(readFileSync(`${dir}/${sub}/export.json`, "utf8"));
  const nodes = []; const walk = (n, path) => { for (const c of n.children) { nodes.push({ ...c, path }); walk(c, [...path, c.text.slice(0, 20)]); } }; walk(exp.root, []);
  console.log(`\n## ${dir.split("/").pop()}`);
  for (const kind of ["決定", "TODO"]) for (const t of truth[kind]) {
    const ov = nodes.filter((n) => n.evidence.some((r) => r.start <= t.to && r.end >= t.from));
    const hit = ov.some((n) => n.kind === kind && t.keywords.every((k) => has(norm(n.text), k)));
    if (hit) { console.log(`○ ${kind} ${t.text}`); continue; }
    console.log(`× ${kind} ${t.text}`);
    const kw = ov.filter((n) => t.keywords.every((k) => has(norm(n.text), k)));
    for (const n of kw) console.log(`    kw一致・種別=${n.kind}: ${n.text}`);
    if (!kw.length) for (const n of ov.filter((n) => n.kind === kind)) console.log(`    同種別・kw不一致: ${n.text}`);
    if (!kw.length && !ov.some((n) => n.kind === kind)) console.log(`    重なるノード ${ov.length} 件: ${ov.slice(0,4).map((n)=>n.kind+":"+n.text.slice(0,30)).join(" / ")}`);
  }
}
