// PROTOTYPE（#880）— 差分更新の呼び方だけを差し替える離散シミュレーター。Claude は呼ばない。
// 呼び出しの所要時間は #878 の実測（out.json の calls）から、渡した発言の数ごとに無作為に引く。
import { readFileSync } from "node:fs";
const D = process.env.HOME + "/live-mindmap-samples/runs/variance-878/";
const load = (f) => JSON.parse(readFileSync(D + f));
const durPool = {}; // n -> durations
for (const f of ["punct50.1.out.json", "punct50.2.out.json", "punct50.3.out.json"]) for (const c of load(f).calls) (durPool[Math.min(c.fresh.length, 3)] ??= []).push(c.end - c.start);
let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const dur = (n) => { const p = durPool[Math.min(n, 3)] ?? durPool[3]; return p[Math.floor(rnd() * p.length)] + (n > 3 ? 0.1 * (n - 3) : 0); };
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// policy: { batch, quiet, afterBatch(呼び出し後にすぐ流す最小件数), minGap(前の呼び出しの始まりからの最短間隔) }
export function simulate(items, lines, pol, s = 1) {
  seed = s;
  const ev = [...items].sort((a, b) => a.at - b.at);
  let pending = [], inFlightEnd = -1, quietAt = Infinity, quiet = false, lastStart = -1e9;
  const nodeAt = new Map(), calls = [];
  let i = 0, t = 0;
  const start = (now, min) => {
    const w = pol.shortLen ? pending.filter((r) => [...r.text].length >= pol.shortLen).length : pending.length;
    if (inFlightEnd > now || pending.length === 0 || (min > 1 || pol.shortLen ? w < min : false)) return false;
    if (pol.minGap && now < lastStart + pol.minGap) return false;
    const d = dur(pending.length), end = now + d;
    calls.push({ start: now, n: pending.length });
    for (const r of pending) nodeAt.set(r.id, end);
    pending = []; inFlightEnd = end; lastStart = now;
    return true;
  };
  for (;;) {
    const nextArr = i < ev.length ? ev[i].at : Infinity;
    const nextEnd = inFlightEnd > t ? inFlightEnd : Infinity;
    const nextGap = pol.minGap && pending.length && lastStart + pol.minGap > t ? lastStart + pol.minGap : Infinity;
    const nt = Math.min(nextArr, nextEnd, quietAt, nextGap);
    if (nt === Infinity) break;
    t = nt;
    if (t === nextEnd) { inFlightEnd = -1; start(t, quiet ? 0 : pol.afterBatch ?? pol.batch); }
    else if (t === quietAt) { quietAt = Infinity; quiet = true; start(t, 0); }
    else if (t === nextGap) { start(t, quiet ? 0 : pol.batch); }
    else { const r = ev[i++]; pending.push(r); quiet = false; quietAt = Infinity; start(t, pol.batch); if (pending.length) quietAt = t + pol.quiet; }
  }
  const toNode = [];
  for (const l of lines) {
    const tt = l.end - 0.3;
    const r = items.filter((r) => r.start <= tt && tt <= r.end + 1).sort((a, b) => a.at - b.at)[0];
    if (r && nodeAt.has(r.id)) toNode.push(nodeAt.get(r.id) - l.end);
  }
  const span = Math.max(...items.map((r) => r.at));
  return { calls: calls.length, p50: pct(toNode, 0.5), p90: pct(toNode, 0.9), nmax: Math.max(...calls.map((c) => c.n)), n1: calls.filter((c) => c.n === 1).length, perHour: calls.length * 3600 / span };
}

const run = (label, file, pol) => {
  const o = load(file);
  const rs = [1, 2, 3, 4, 5].map((s) => simulate(o.items, o.lines, pol, s));
  const avg = (k) => (rs.reduce((a, r) => a + r[k], 0) / rs.length);
  console.log(`| ${label} | ${avg("calls").toFixed(0)} | ${avg("p50").toFixed(1)} / ${avg("p90").toFixed(1)} | ${avg("n1").toFixed(0)} | ${Math.max(...rs.map(r=>r.nmax))} |`);
};
console.log("| 規則・呼び方 | 呼び出し | → ノード p50 / p90 | 1 件の呼び出し | 最大 |\n|---|---|---|---|---|");
run("いま・いま(B2 Q1.5)", "quiet.1.out.json", { batch: 2, quiet: 1.5 });
for (const [label, pol] of [
  ["文末・いま(B2 Q1.5)", { batch: 2, quiet: 1.5 }],
  ["文末・B1（空いていればすぐ）", { batch: 1, quiet: 0 }],
  ["文末・B2 Q1.0", { batch: 2, quiet: 1.0 }],
  ["文末・B2 Q0.5", { batch: 2, quiet: 0.5 }],
  ["文末・B2 Q0.2", { batch: 2, quiet: 0.2 }],
  ["文末・B3 Q1.5", { batch: 3, quiet: 1.5 }],
  ["文末・B3 Q3", { batch: 3, quiet: 3 }],
  ["文末・B2 Q3", { batch: 2, quiet: 3 }],
  ["文末・B1 短い(<8字)は数えない Q1.5", { batch: 1, quiet: 1.5, shortLen: 8 }],
  ["文末・B1 短い(<8字)は数えない Q3", { batch: 1, quiet: 3, shortLen: 8 }],
  ["文末・B2 短いは数えない Q3", { batch: 2, quiet: 3, shortLen: 8 }],
  ["文末・B1 間隔4秒", { batch: 1, quiet: 0, minGap: 4 }],
  ["文末・B1 間隔5秒", { batch: 1, quiet: 0, minGap: 5 }],
  ["文末・B1 間隔6秒", { batch: 1, quiet: 0, minGap: 6 }],
]) run(label, "punct50.1.out.json", pol);
