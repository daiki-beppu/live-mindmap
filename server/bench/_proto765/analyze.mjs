// PROTOTYPE（#765）— m765.ts の出力を数える。node analyze.mjs <out.json>...
// 遅れ: 行の話し終わり（end − 0.3 秒）を含む発言が、ノードに出るまで（#763 の analyze.mjs と同じ数え方）。判定の時間も含む
// 費用: 呼び出しごとの usage × そのモデルの定価（$/100 万トークン）。キャッシュの書き込みは 5 分（FORCE_PROMPT_CACHING_5M）。
//       Haiku 5.5 は 1 回の要求が 10 万トークンを超えると高い表だが、呼び出しの合計しか持たないので低い表で数える
//       Jev は入力 $0.042（出力は無料）
import { readFileSync } from "node:fs";

const PRICE = {
  "claude-sonnet-5-5": { in: 2, out: 10, w: 2.5, read: 0.2 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, w: 0.125, read: 0.01 },
};
const JEV = 0.042;
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");

const rows = [];
for (const path of process.argv.slice(2)) {
  const o = JSON.parse(readFileSync(path, "utf8"));
  const toNode = [];
  let missing = 0;
  for (const l of o.lines) {
    const t = l.end - 0.3;
    if (!o.items.some((r) => r.start <= t && t <= r.end + 1)) continue;
    const a = o.arrivals.filter((x) => x.start <= t && t <= x.end + 1).sort((x, y) => x.at - y.at)[0];
    if (a) toNode.push(a.at - l.end); else missing++;
  }
  const minutes = (Math.max(...o.lines.map((l) => l.end)) - Math.min(...o.lines.map((l) => l.start))) / 60;
  let usd = 0, w = 0, rd = 0;
  const byModel = {};
  for (const c of o.calls) {
    const u = c.usage;
    if (u) {
      const p = PRICE[u.model] ?? PRICE["claude-sonnet-5-5"];
      usd += (u.input * p.in + u.cacheWrite * p.w + u.cacheRead * p.read + u.output * p.out) / 1e6;
      w += u.cacheWrite; rd += u.cacheRead;
      byModel[u.model] = (byModel[u.model] ?? 0) + 1;
    }
    usd += ((c.judge.jevTokens ?? 0) * JEV) / 1e6;
  }
  const j = o.calls.map((c) => c.judge);
  const sonnetShare = j.filter((x) => x.to === "sonnet").length / j.length;
  const ps = j.filter((x) => x.p !== undefined);
  const share = (min) => (ps.length ? ((ps.filter((x) => x.p >= min).length + j.filter((x) => x.jevError).length) / j.length) : NaN);
  const jevMs = ps.map((x) => x.jevMs);
  const r = o.recall ?? {};
  rows.push({
    run: path.split("/").at(-1).replace(".json", ""), minutes,
    p50: pct(toNode, 0.5), p90: pct(toNode, 0.9), missing, calls: o.calls.length, failed: o.failed,
    dec: r.決定 ? [r.決定.hit, r.決定.total] : null, todo: r.TODO ? [r.TODO.hit, r.TODO.total] : null,
    usd, per60: (usd * 60) / minutes, w, rd, sonnetShare, byModel,
    share05: share(0.5), share07: share(0.7), jevErr: j.filter((x) => x.jevError).length,
    jev50: pct(jevMs, 0.5), jev90: pct(jevMs, 0.9),
  });
}
const pctS = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");
console.log("| ラン | → ノード p50 / p90 | 呼び出し（失敗） | 決定 | TODO | 費用（60 分あたり） | Sonnet に回った | jev 0.5 / 0.7 | 判定 p50 / p90 ms（時間切れ・失敗） | キャッシュ 書き込み / 読み込み |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const x of rows) {
  console.log(`| ${x.run} | ${f1(x.p50)} / ${f1(x.p90)} | ${x.calls}（${x.failed}） | ${x.dec ? x.dec.join("/") : "-"} | ${x.todo ? x.todo.join("/") : "-"} | $${x.usd.toFixed(2)}（$${x.per60.toFixed(2)}） | ${pctS(x.sonnetShare)} | ${pctS(x.share05)} / ${pctS(x.share07)} | ${Number.isFinite(x.jev50) ? `${Math.round(x.jev50)} / ${Math.round(x.jev90)}（${x.jevErr}）` : "-"} | ${(x.w / 1000).toFixed(0)}k / ${(x.rd / 1000).toFixed(0)}k |`);
}
// 1 回の差分更新の秒数（判定の後 → 応答）をモデルごとに
console.log("\n| ラン | Sonnet 1 回 p50 / p90 秒（回） | Haiku 1 回 p50 / p90 秒（回） |\n| --- | --- | --- |");
for (const path of process.argv.slice(2)) {
  const o = JSON.parse(readFileSync(path, "utf8"));
  const d = (m) => o.calls.filter((c) => c.usage?.model === m).map((c) => c.end - c.judged);
  const fmt = (v) => (v.length ? `${f1(pct(v, 0.5))} / ${f1(pct(v, 0.9))}（${v.length}）` : "-");
  console.log(`| ${path.split("/").at(-1).replace(".json", "")} | ${fmt(d("claude-sonnet-5-5"))} | ${fmt(d("claude-haiku-5-5"))} |`);
}
if (process.env.JSON) console.log(JSON.stringify(rows));
