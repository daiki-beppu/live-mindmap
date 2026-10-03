// 長い会議の計測（issue #127 の調査用）: longMeeting.ts の出力から 10 分ごとの表を作る。
//   node bench/longMeetingReport.ts <出力フォルダ>
// 入力トークン = input_tokens + cache_read_input_tokens + cache_creation_input_tokens（1 回の呼び出しでモデルが読んだ量）。
// アウトラインのトークンは、各 query の最初の呼び出し（会話の履歴がない）で「トークン = 前置き + k × プロンプトの文字数」を最小二乗で当てはめた k で見積もる。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { measure, toJsonExport, type Snapshot } from "../src/core/index.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node bench/longMeetingReport.ts <出力フォルダ>");
type Call = {
  call: number; query: number; at: number; fresh: number; nodesBefore: number; promptChars: number; outlineChars: number;
  wallMs: number; callCost: number; costSum: number; error?: string; ops: string[];
  result?: { duration_ms: number; usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number } };
};
const calls: Call[] = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const tokIn = (c: Call) => (c.result ? c.result.usage.input_tokens + c.result.usage.cache_read_input_tokens + c.result.usage.cache_creation_input_tokens : 0);

// k（1 文字あたりのトークン）と前置き S を、各 query の最初の呼び出しから当てはめる
const firsts = calls.filter((c, i) => c.result && (i === 0 || calls[i - 1]!.query !== c.query));
const n = firsts.length;
const mx = firsts.reduce((s, c) => s + c.promptChars, 0) / n;
const my = firsts.reduce((s, c) => s + tokIn(c), 0) / n;
const k = firsts.reduce((s, c) => s + (c.promptChars - mx) * (tokIn(c) - my), 0) / firsts.reduce((s, c) => s + (c.promptChars - mx) ** 2, 0);
const S = my - k * mx;

// Sonnet 5.5 の定価（$/100 万トークン）。キャッシュの書き込みは SDK が 1 時間の TTL で書くので入力の 2 倍
const prices = { read: 0.2, write: 4, output: 10 };

const snaps = new Map<number, Snapshot>();
for (const f of readdirSync(join(dir, "snapshots"))) snaps.set(Number(f.replace(".json", "")), JSON.parse(readFileSync(join(dir, "snapshots", f), "utf8")));

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const OPS = ["add", "update", "combine", "move", "delete", "noop"];

const end = Math.max(...calls.map((c) => c.at));
const lines: string[] = [];
lines.push(`k = ${k.toFixed(3)} トークン/文字、前置き S ≈ ${Math.round(S)} トークン（${n} 個の query の最初の呼び出しから）`);
lines.push(`呼び出し ${calls.length} 回・失敗 ${calls.filter((c) => c.error).length} 回・query ${calls.at(-1)!.query} 個・累計 $${calls.at(-1)!.costSum.toFixed(2)}`);
lines.push("");
lines.push("| 区間（分） | 呼び出し | 入力トークン 平均 / 最大 | うち今回のプロンプト 平均 | うちアウトライン 平均（今回分） | 1 回の費用 平均 | 応答 p50 / p90（秒） | 累計費用 | ノード | 深さ | add | update | combine | move | delete | noop | 失敗 |");
lines.push("| --- | " + Array(16).fill("---").join(" | ") + " |");
for (let t = 10; t - 10 < end; t += 10) {
  const bin = calls.filter((c) => c.at > (t - 10) * 60 && c.at <= t * 60);
  if (bin.length === 0) continue;
  const ok = bin.filter((c) => c.result);
  const ops = Object.fromEntries(OPS.map((o) => [o, bin.reduce((s, c) => s + c.ops.filter((x) => x === o).length, 0)]));
  const label = snaps.has(t) ? t : Math.max(...[...snaps.keys()].filter((x) => x <= t));
  const snap = snaps.get(label);
  const m = snap ? measure(toJsonExport(snap, snap.remarks)) : undefined;
  lines.push(`| ${t - 10}–${t} | ${bin.length} | ${Math.round(avg(ok.map(tokIn)))} / ${Math.max(...ok.map(tokIn))} | ${Math.round(avg(bin.map((c) => k * c.promptChars)))} | ${Math.round(avg(bin.map((c) => k * c.outlineChars)))} | $${avg(bin.map((c) => c.callCost)).toFixed(4)} | ${(pct(bin.map((c) => c.wallMs), 0.5) / 1000).toFixed(1)} / ${(pct(bin.map((c) => c.wallMs), 0.9) / 1000).toFixed(1)} | $${bin.at(-1)!.costSum.toFixed(2)} | ${m?.nodes ?? "-"} | ${m?.depth ?? "-"} | ${OPS.map((o) => ops[o]).join(" | ")} | ${bin.filter((c) => c.error).length} |`);
}

// #75 の見立て用: 1 回の費用を「前置き + 履歴（キャッシュ読み）」「今回の書き込み」「出力」に分け、アウトラインが今回の書き込みに占める割合を出す
lines.push("");
lines.push("| 区間（分） | 費用の内訳 read / write / output（1 回平均 $） | アウトライン ÷ 今回の書き込み | アウトラインの履歴分 ÷ キャッシュ読み |");
lines.push("| --- | --- | --- | --- |");
for (let t = 10; t - 10 < end; t += 10) {
  const bin = calls.filter((c) => c.result && c.at > (t - 10) * 60 && c.at <= t * 60);
  if (bin.length === 0) continue;
  const r = avg(bin.map((c) => c.result!.usage.cache_read_input_tokens)) * prices.read / 1e6;
  const w = avg(bin.map((c) => c.result!.usage.cache_creation_input_tokens + c.result!.usage.input_tokens)) * prices.write / 1e6;
  const o = avg(bin.map((c) => c.result!.usage.output_tokens)) * prices.output / 1e6;
  const outlineShareWrite = avg(bin.map((c) => (k * c.outlineChars) / (c.result!.usage.cache_creation_input_tokens + c.result!.usage.input_tokens)));
  // 同じ query の前の呼び出しのアウトライン（履歴としてキャッシュから読む分）
  const histShare = avg(bin.map((c) => {
    const prev = calls.filter((p) => p.query === c.query && p.call < c.call);
    return (k * prev.reduce((s, p) => s + p.outlineChars, 0)) / Math.max(1, c.result!.usage.cache_read_input_tokens);
  }));
  lines.push(`| ${t - 10}–${t} | ${r.toFixed(4)} / ${w.toFixed(4)} / ${o.toFixed(4)} | ${(outlineShareWrite * 100).toFixed(0)}% | ${(histShare * 100).toFixed(0)}% |`);
}
process.stdout.write(lines.join("\n") + "\n");
