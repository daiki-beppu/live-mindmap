// 行ごとの区間: 話し終わり → 発言（at） → 差分更新の呼び出し開始 → 応答。ノードは reflectedArrivals（add/update の根拠になった時刻）
import { readFileSync } from "node:fs";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const E = 1e-6;
const pct = (v, p) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x) => (Number.isNaN(x) ? "-" : x.toFixed(1));
const cover = (line, xs) => { const mid = (line.start + line.end) / 2; return xs.filter((a) => a.start - E <= mid && mid <= a.end + E); };
const seg = { toRemark: [], toCall: [], call: [], toResponse: [], toNode: [], afterResponse: [] };
const callOf = (id) => d.calls.filter((c) => c.ok && c.fresh.includes(id)).sort((a, b) => a.start - b.start)[0];
let noRemark = 0, noNode = 0;
for (const line of d.lines) {
  const rs = cover(line, d.items).sort((a, b) => a.at - b.at);
  if (!rs.length) { noRemark++; continue; }
  const r = rs[0];
  seg.toRemark.push(r.at - line.end);
  const c = callOf(r.id);
  if (c) { seg.toCall.push(c.start - r.at); seg.call.push(c.end - c.start); seg.toResponse.push(c.end - line.end); }
  const ns = cover(line, d.arrivals).map((a) => a.at);
  if (ns.length) { const n = Math.min(...ns); seg.toNode.push(n - line.end); if (c) seg.afterResponse.push(n - c.end); } else noNode++;
}
const names = { toRemark: "話し終わり → 発言", toCall: "発言 → 呼び出し開始", call: "呼び出し → 応答", toResponse: "話し終わり → 応答（初回）", toNode: "話し終わり → ノード", afterResponse: "初回の応答 → ノード" };
console.log("| 区間 | 件数 | p50 | p90 |\n|---|---|---|---|");
for (const k in seg) console.log(`| ${names[k]} | ${seg[k].length} | ${f(pct(seg[k], 0.5))} | ${f(pct(seg[k], 0.9))} |`);
const nodeLines = seg.toNode.length;
const sources = d.items.reduce((a, i) => ((a[i.source] = (a[i.source] ?? 0) + 1), a), {});
const sizes = d.calls.filter((c) => c.ok).map((c) => c.fresh.length);
console.log(`\n行 ${d.lines.length}・発言なし ${noRemark}・ノードに反映されない行 ${noNode}・ノードに反映 ${nodeLines}`);
console.log(`発言の出どころ ${JSON.stringify(sources)}・呼び出し ${d.calls.length}（失敗 ${d.calls.filter((c) => !c.ok).length}）・1 回の発言数 p50 ${pct(sizes, 0.5)} 最大 ${Math.max(...sizes)}`);
console.log(`usage ${JSON.stringify(d.usage)}`);
if (d.recall) console.log(`再現率 ${JSON.stringify(d.recall)}`);
