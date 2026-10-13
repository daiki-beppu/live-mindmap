// PROTOTYPE（#763）— m761.ts の出力を、行の話し終わり（end − 0.3 秒）を含む発言で数え直す。
// node analyze.mjs <out.json>...
import { readFileSync } from "node:fs";

const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : "-"; };
const rows = [["入力", "話し終わり → 発言 p50 / p90", "→ ノード p50 / p90", "ノードに出ない行", "呼び出し", "1 回の新しい発言 p50 / max", "呼び出し → 応答 p50", "入力トークン（書き込み / 読み出し）", "出力", "決定", "TODO", "費用"]];
for (const path of process.argv.slice(2)) {
  const o = JSON.parse(readFileSync(path, "utf8"));
  const byId = new Map(o.items.map((r) => [r.id, r]));
  const firstCall = new Map();
  for (const c of o.calls) for (const id of c.fresh) if (!firstCall.has(id)) firstCall.set(id, c);
  const toRemark = [], toNode = [];
  let missing = 0;
  for (const l of o.lines) {
    const t = l.end - 0.3;
    const covering = o.items.filter((r) => r.start <= t && t <= r.end + 1);
    const r = covering.sort((a, b) => a.at - b.at)[0];
    if (!r) continue;
    toRemark.push(r.at - l.end);
    const a = o.arrivals.filter((x) => x.start <= t && t <= x.end + 1).sort((x, y) => x.at - y.at)[0];
    if (a) toNode.push(a.at - l.end); else missing++;
  }
  const fresh = o.calls.map((c) => c.fresh.length);
  const u = o.usage;
  const rec = o.recall ? Object.fromEntries(Object.entries(o.recall).map(([k, v]) => [k, v])) : {};
  rows.push([path.split("/").at(-1), `${pct(toRemark, 0.5)} / ${pct(toRemark, 0.9)}`, `${pct(toNode, 0.5)} / ${pct(toNode, 0.9)}`, missing, o.calls.length,
    `${pct(fresh, 0.5)} / ${Math.max(...fresh)}`, pct(o.calls.map((c) => c.end - c.start), 0.5),
    `${u.cacheWrite} / ${u.cacheRead}`, u.output,
    rec.決定 ? `${rec.決定.hit}/${rec.決定.total}` : "-", rec.TODO ? `${rec.TODO.hit}/${rec.TODO.total}` : "-",
    // Sonnet 5.5: 入力 $2・書き込み（1 時間 TTL）$4・読み出し $0.10・出力 $10（100 万トークンあたり）
  ]);
  rows.at(-1).push(`$${((u.input * 2 + u.cacheWrite * 4 + u.cacheRead * 0.1 + u.output * 10) / 1e6).toFixed(2)}`);
}
console.log(rows.map((r) => `| ${r.join(" | ")} |`).join("\n"));
