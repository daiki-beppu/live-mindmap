// PROTOTYPE（#880）— 発言を流すのが遅れた分（replayByArrival は前の発言からの差だけ眠るので、遅れが残る）を、
// セッションログの remark の時刻から引き、話し終わり → ノードを数え直す。node drift.mjs <out.json>...
import { readFileSync } from "node:fs";
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const path of process.argv.slice(2)) {
  const o = JSON.parse(readFileSync(path, "utf8"));
  const log = readFileSync(o.dir + "/log.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const pushed = new Map(log.filter((e) => e.type === "remark").map((e) => [e.remark.id, Date.parse(e.at) / 1000]));
  // t0 は「呼び出しの始まり」の基準と同じにしたいので、最初の呼び出しを含む発言の時刻で合わせる（ずれ = 0 と置く）
  const first = o.items[0];
  const base = pushed.get(first.id) - first.at;
  const drift = new Map(o.items.map((r) => [r.id, pushed.get(r.id) - base - r.at]));
  const toNode = [];
  for (const l of o.lines) {
    const t = l.end - 0.3;
    const r = o.items.filter((r) => r.start <= t && t <= r.end + 1).sort((a, b) => a.at - b.at)[0];
    if (!r) continue;
    const a = o.arrivals.filter((x) => x.start <= t && t <= x.end + 1).sort((x, y) => x.at - y.at)[0];
    if (a) toNode.push(a.at - l.end - drift.get(r.id));
  }
  const d = [...drift.values()];
  console.log(`| ${path.split("/").at(-1)} | ずれ p50 ${pct(d, 0.5).toFixed(1)} / max ${Math.max(...d).toFixed(1)} | ${pct(toNode, 0.5).toFixed(1)} / ${pct(toNode, 0.9).toFixed(1)} |`);
}
