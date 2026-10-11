// #764 の試作（使い捨て）: Jev の議題が、いまの「今の議題」（Claude の反映で決まり、カメラが寄せる先）と違うときだけが新しい情報。
// その場面の数と当たり、今の議題が追いつくまでの秒を数える。node ahead.mjs <out.json> [<out.json>...]
import { readFileSync } from "node:fs";
for (const path of process.argv.slice(2)) {
  const m = JSON.parse(readFileSync(path, "utf8"));
  const run = JSON.parse(readFileSync(m.run, "utf8"));
  const log = readFileSync(`${run.dir}/log.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "diff");
  const N = new Map(m.nodes.map((n) => [n.id, n]));
  const topicOf = (id) => { for (let c = N.get(id); c; c = N.get(c.parent)) if (c.kind === "議題") return c.id; return null; };
  // 反映ごとの今の議題（server/src/core/topic.ts と同じ: 最後に変わったノードの議題、無ければ前のまま）
  let counter = 0, cur = null;
  const timeline = [];
  log.forEach((d, i) => {
    const refs = new Map();
    let last = null;
    for (const op of d.ops) {
      if (op.op === "add") { const id = `n${++counter}`; refs.set(op.ref, id); last = id; }
      else if (op.op === "update" || op.op === "close") last = op.node;
    }
    if (last) cur = topicOf(last) ?? cur;
    timeline.push({ at: run.diffEnds[i], topic: cur });
  });
  const currentAt = (t) => { let c = null; for (const x of timeline) { if (x.at > t) break; c = x.topic; } return c; };
  const caughtUp = (t, topic) => timeline.find((x) => x.at > t && x.topic === topic)?.at;
  const rows = m.rows.filter((r) => (r.conf ?? 0) >= 0.7 && r.choice !== "new" && r.choice !== "none" && r.truth?.length);
  let same = 0, aheadHit = 0, aheadMiss = 0; const leads = [];
  for (const r of rows) {
    const t = r.at + r.ms / 1000, j = topicOf(r.choice);
    if (j === currentAt(t)) { same++; continue; }
    if (r.truth.some((x) => topicOf(x) === j)) { aheadHit++; const c = caughtUp(t, j); if (c) leads.push(c - t); } else aheadMiss++;
  }
  leads.sort((a, b) => a - b);
  const switches = timeline.filter((x, i) => i && x.topic !== timeline[i - 1].topic).length;
  console.log(`${path}: 光った ${rows.length} 回のうち 今の議題と同じ ${same}・違って当たり ${aheadHit}・違って外れ ${aheadMiss}。当たりで今の議題が追いつくまで p50 ${leads[Math.floor(leads.length / 2)]?.toFixed(1)} 秒（${leads.length} 件）。今の議題が替わった回数 ${switches}`);
}
