import { readFileSync } from "node:fs";
const [items, lines] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, "utf8")));
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : "-"; };
const rows = [];
lines.forEach((l, i) => {
  const mid = (l.start + l.end) / 2;
  const r = items.filter((a) => a.start <= mid && mid <= a.end).sort((a, b) => a.at - b.at)[0];
  if (!r) return;
  const gap = i + 1 < lines.length ? lines[i + 1].start - l.end : 9;
  // 発言が覆う行の数（複数行が 1 発言にまとまったか）
  const span = lines.filter((m) => r.start <= (m.start + m.end) / 2 && (m.start + m.end) / 2 <= r.end).length;
  rows.push({ d: r.at - l.end, gap, span, len: l.end - l.start, src: r.source, lastInRemark: Math.abs(r.end - l.end) < 1.5 });
});
const groups = { "発言の最後の行": rows.filter((r) => r.lastInRemark), "発言の途中の行（後ろの行を待つ）": rows.filter((r) => !r.lastInRemark) };
for (const [k, g] of Object.entries(groups)) console.log(k, g.length, "p50", pct(g.map((r) => r.d), 0.5), "p90", pct(g.map((r) => r.d), 0.9));
for (const [k, f] of [["次の行まで<0.6s", (r) => r.gap < 0.6], ["0.6-1.5s", (r) => r.gap >= 0.6 && r.gap < 1.5], [">=1.5s", (r) => r.gap >= 1.5]]) { const g = rows.filter(f); console.log(k, g.length, "p50", pct(g.map((r) => r.d), 0.5), "p90", pct(g.map((r) => r.d), 0.9)); }
const spans = rows.map((r) => r.span); console.log("1 発言が覆う行数 p50", pct(spans, 0.5), "p90", pct(spans, 0.9), "max", Math.max(...spans));
console.log("発言の長さ(秒) p50", pct(items.map((i) => i.end - i.start), 0.5), "p90", pct(items.map((i) => i.end - i.start), 0.9));
