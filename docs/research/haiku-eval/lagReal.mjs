// 使い捨て（issue #614 の追加の問い）。--realtime で流したセッションの log.jsonl から、発言が届いてからマップに反映されるまでの実測の遅れを出す。
// 発言の at（届いた時刻）から、その発言を input.fresh に含む diff の at（反映してログに書いた時刻）まで
import { readFileSync } from "node:fs";
for (const log of process.argv.slice(2)) {
  const es = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const arrived = new Map(es.filter((e) => e.type === "remark").map((e) => [e.remark.id, Date.parse(e.at)]));
  const lags = [];
  let calls = 0, sizes = [];
  for (const e of es.filter((e) => e.type === "diff")) {
    calls++; sizes.push(e.input.fresh.length);
    for (const r of e.input.fresh) lags.push((Date.parse(e.at) - arrived.get(typeof r === "string" ? r : r.id)) / 1000);
  }
  lags.sort((a, b) => a - b);
  const q = (p) => lags[Math.min(lags.length - 1, Math.floor(p * lags.length))].toFixed(1);
  const n1 = sizes.filter((s) => s === 1).length;
  console.log(`${log.split("/").at(-3)}\t差分更新 ${calls} 回（1 発言 ${n1} 回）\t反映された発言 ${lags.length}\t遅れ 中央 ${q(0.5)} / p90 ${q(0.9)} / 最大 ${lags.at(-1).toFixed(1)} 秒`);
}
