// PROTOTYPE（issue #130 の試作）: longMeeting.ts / longMeetingProto.ts の出力を並べて比べる。
//   node bench/longMeetingCompare.ts <出力フォルダ>...
// 費用は usage のトークンに Sonnet 5.5 の定価を掛ける（書き込みは TTL ごとの単価）。適用できなかった操作は log.jsonl の dropped から数える。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const P = { input: 2, read: 0.2, w1h: 4, w5m: 2.5, output: 10 };
type Usage = { input_tokens: number; cache_read_input_tokens: number; output_tokens: number; cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } };
const jsonl = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const dir of process.argv.slice(2)) {
  const calls = jsonl(join(dir, "calls.jsonl"));
  const log = jsonl(join(dir, "log.jsonl"));
  const closes = jsonl(join(dir, "closes.jsonl"));
  const cost = (u: Usage) => (u.input_tokens * P.input + u.cache_read_input_tokens * P.read + u.cache_creation.ephemeral_1h_input_tokens * P.w1h + u.cache_creation.ephemeral_5m_input_tokens * P.w5m + u.output_tokens * P.output) / 1e6;
  const end = Math.max(...calls.map((c) => c.at));
  const hours = Array.from({ length: Math.ceil(end / 3600) }, (_, h) => calls.filter((c) => c.result && c.at > h * 3600 && c.at <= (h + 1) * 3600).reduce((s, c) => s + cost(c.result.usage), 0));
  const diffs = log.filter((e) => e.type === "diff");
  const dropped = diffs.flatMap((e) => e.dropped ?? []);
  const reasons = new Map<string, number>();
  for (const d of dropped) { const r = String(d.reason).replace(/: .*/, ""); reasons.set(r, (reasons.get(r) ?? 0) + 1); }
  const ops = new Map<string, number>();
  for (const e of diffs) for (const o of e.ops) ops.set(o.op, (ops.get(o.op) ?? 0) + 1);
  const kinds = new Map<string, number>();
  for (const c of closes) kinds.set(c.type, (kinds.get(c.type) ?? 0) + 1);
  console.log(`## ${dir.replace(/^.*\//, "")}`);
  console.log(`呼び出し ${calls.length}・失敗 ${calls.filter((c) => c.error).length}・1 時間ごとの費用 ${hours.map((h) => `$${h.toFixed(2)}`).join(" → ")}・合計 $${hours.reduce((a, b) => a + b, 0).toFixed(2)}`);
  console.log(`1 回のプロンプト（文字）: 最初の 30 分 平均 ${avg(calls.filter((c) => c.at < 1800).map((c) => c.promptChars))}、最後の 30 分 平均 ${avg(calls.filter((c) => c.at > end - 1800).map((c) => c.promptChars))}`);
  console.log(`操作: ${[...ops].map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`適用できなかった操作 ${dropped.length}: ${[...reasons].map(([k, v]) => `${k} ${v}`).join("・") || "なし"}`);
  if (closes.length) console.log(`閉じる・開き直し: ${[...kinds].map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log("");
}
function avg(xs: number[]) { return Math.round(xs.reduce((a, b) => a + b, 0) / (xs.length || 1)); }
