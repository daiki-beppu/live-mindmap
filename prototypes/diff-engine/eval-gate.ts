// PROTOTYPE — Jev ゲート単体の評価。Sonnet の 1 発言ごとのランを正解ラベルにする。
// 使い方: op run --env-file=.env.op -- bun eval-gate.ts [runs/<batch1 のラン>.json]
import { writeFileSync } from "node:fs";
import { JevGate, type GateAnswers } from "./gate";
import { emptyMap, type MindMap } from "./map";

const path = process.argv[2] ?? "runs/facilitators-meeting__claude-sonnet-5-5__batch1.json";
const run = await Bun.file(path).json();
const gate = new JevGate();

type Row = { seg: string; changed: boolean; touched: string[]; added: boolean; ans: GateAnswers };
const rows: Row[] = [];
for (const [i, step] of run.steps.entries()) {
  const before: MindMap = i === 0 ? emptyMap() : run.steps[i - 1].map; // その発言が届いた時点のマップ
  const seg = run.segments.find((s: any) => s.id === step.segIds[0]);
  const recent = run.segments.slice(Math.max(0, run.segments.indexOf(seg) - 3), run.segments.indexOf(seg));
  const ans = await gate.ask(before, recent, seg);
  const ok = step.results.filter((r: any) => r.ok && r.op.op !== "noop");
  rows.push({
    seg: seg.id, changed: ok.length > 0, added: ok.some((r: any) => r.op.op === "add"),
    touched: ok.filter((r: any) => r.op.op !== "add").map((r: any) => r.nodeId), ans,
  });
}
writeFileSync(`runs-gate-eval.json`, JSON.stringify(rows));

const pos = rows.filter((r) => r.changed).length;
console.log(`発言 ${rows.length}、Sonnet がマップを変えた発言 ${pos}（${((pos / rows.length) * 100).toFixed(0)}%）`);
console.log(`Jev 応答 p50 ${rows.map((r) => r.ans.latencyMs).sort((a, b) => a - b)[rows.length >> 1]}ms`);
console.log("閾値\t捨てる発言\t取りこぼす変更");
for (const th of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
  const dropped = rows.filter((r) => r.ans.mapWorthy < th);
  const missed = dropped.filter((r) => r.changed).length;
  console.log(`${th}\t${((dropped.length / rows.length) * 100).toFixed(0)}%\t\t${missed}/${pos}（${((missed / pos) * 100).toFixed(0)}%）`);
}
// AUC: 変えた発言の mapWorthy が、変えなかった発言より高い確率
const P = rows.filter((r) => r.changed).map((r) => r.ans.mapWorthy), N = rows.filter((r) => !r.changed).map((r) => r.ans.mapWorthy);
const auc = P.reduce((t, p) => t + N.reduce((u, n) => u + (p > n ? 1 : p === n ? 0.5 : 0), 0), 0) / (P.length * N.length);
console.log(`mapWorthy の AUC ${auc.toFixed(2)}`);

const upd = rows.filter((r) => r.touched.length && !r.added);
const hit = upd.filter((r) => r.touched.includes(r.ans.target)).length;
console.log(`update だけの発言 ${upd.length} 件のうち、target が更新されたノードと一致 ${hit}`);
const none = rows.filter((r) => r.ans.target === "none");
console.log(`target=none ${none.length} 件のうち、Sonnet が変えた ${none.filter((r) => r.changed).length}`);

const tin = rows.reduce((t, r) => t + r.ans.usage.input, 0), tout = rows.reduce((t, r) => t + r.ans.usage.output, 0);
console.log(`Jev トークン: 入力 ${tin}（1 回平均 ${Math.round(tin / rows.length)}、最後 ${rows.at(-1)!.ans.usage.input}）・出力 ${tout}`);
