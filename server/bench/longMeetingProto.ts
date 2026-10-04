// PROTOTYPE（issue #130 の試作）: longMeeting.ts を、bench/protoClaude.ts（閉じる・済みの議題を畳んで渡す）で流す版。--style full|title|outcomes。閉じる・開き直しは closes.jsonl に残す。
// 文字起こしを待ち時間なしで再生し（play と同じ流し方）、差分更新 1 回ごとに次を calls.jsonl に残す:
//   会議の中の時刻・応答時間（壁時計）・プロンプトの文字数とアウトラインの文字数・SDK の result（usage / total_cost_usd / duration）
// あわせて log.jsonl（play と同じ形）と、10 分ごとのスナップショット（snapshots/<分>.json）を書く。
//   node bench/longMeeting.ts <文字起こし> <出力フォルダ> [--budget <ドル>]
// 予算（既定 $15）を累計の費用が超えたら、その時点で止める。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { openClaudeUpdater, type ClosedStyle } from "./protoClaude.ts";
import { createSession, fromTranscript, type DiffUpdater } from "../src/core/index.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { budget: { type: "string", default: "15" }, title: { type: "string" }, style: { type: "string", default: "outcomes" }, diff: { type: "boolean", default: false } } });
const [file, out] = positionals;
if (!file || !out) throw new Error("usage: node bench/longMeeting.ts <文字起こし> <出力フォルダ> [--budget <ドル>]");
const budget = Number(values.budget);
mkdirSync(join(out, "snapshots"), { recursive: true });

// query を包んで、各呼び出しの result メッセージを拾う
let lastResult: SDKMessage | undefined;
let queries = 0;
const run: typeof query = (args) => {
  queries++;
  const q = query(args);
  const it = q[Symbol.asyncIterator]();
  const wrapped: AsyncIterator<SDKMessage> = {
    async next() {
      const r = await it.next();
      if (!r.done && r.value.type === "result") lastResult = r.value;
      return r;
    },
  };
  (q as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = () => wrapped;
  return q as Query;
};

const owned = openClaudeUpdater(run, values.style as ClosedStyle, join(out, "closes.jsonl"), values.diff);
let calls = 0;
let costSum = 0;
let prevQuery = 0;
let prevCumCost = 0;
let stopped = false;

const section = (prompt: string, head: string) => {
  const start = prompt.indexOf(head);
  if (start < 0) return "";
  const next = prompt.indexOf("\n## ", start + head.length);
  return prompt.slice(start, next < 0 ? undefined : next);
};

const updater: DiffUpdater = async (input) => {
  if (stopped) throw new Error("予算を超えたので止めた");
  const prompt = owned.prompt(input);
  const outline = section(prompt, "## 現在のマップ") || section(prompt, "## 前回からのマップの変更");
  lastResult = undefined;
  const t0 = performance.now();
  let error: string | undefined;
  let result: Awaited<ReturnType<DiffUpdater>> | undefined;
  try {
    result = await owned.update(input);
  } catch (e) {
    error = String(e);
  }
  const wallMs = performance.now() - t0;
  calls++;
  const r = lastResult as Record<string, any> | undefined;
  // total_cost_usd が query ごとの累計か 1 回分かは SDK の版で違いうるので、生の値と差分の両方を残す
  const cum = typeof r?.total_cost_usd === "number" ? r.total_cost_usd : 0;
  if (queries !== prevQuery) { prevQuery = queries; prevCumCost = 0; }
  const callCost = Math.max(0, cum - prevCumCost);
  prevCumCost = cum;
  costSum += callCost;
  const rec = {
    call: calls,
    query: queries,
    at: input.fresh.at(-1)!.end,
    fresh: input.fresh.length,
    nodesBefore: input.map.order.length - 1,
    promptChars: prompt.length,
    outlineChars: outline.length,
    wallMs: Math.round(wallMs),
    callCost,
    costSum,
    error,
    ops: result?.ops.map((o) => o.op) ?? [],
    result: r ? { subtype: r.subtype, total_cost_usd: r.total_cost_usd, duration_ms: r.duration_ms, duration_api_ms: r.duration_api_ms, num_turns: r.num_turns, usage: r.usage, modelUsage: r.modelUsage } : undefined,
  };
  appendFileSync(join(out, "calls.jsonl"), JSON.stringify(rec) + "\n");
  appendFileSync(join(out, "prompts.jsonl"), JSON.stringify({ call: calls, query: queries, prompt, ops: result?.ops }) + "\n");
  if (calls % 20 === 0) process.stderr.write(`call ${calls} at ${(rec.at / 60).toFixed(1)}min nodes ${rec.nodesBefore} cost $${costSum.toFixed(3)} wall ${rec.wallMs}ms\n`);
  if (costSum > budget) {
    stopped = true;
    process.stderr.write(`予算 $${budget} を超えた（$${costSum.toFixed(3)}）。止める\n`);
  }
  if (error) throw new Error(error);
  return result!;
};

const transcript = JSON.parse(readFileSync(file, "utf8"));
const session = createSession({
  title: values.title ?? file.replace(/^.*\//, "").replace(/\.transcript\.json$/, ""),
  updater,
  log: (event) => appendFileSync(join(out, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"),
});

const STEP = 600;
let nextMark = STEP;
const saveSnapshot = (label: number) => writeFileSync(join(out, "snapshots", `${String(label).padStart(3, "0")}.json`), JSON.stringify(session.snapshot()));
try {
  // playback（待ち時間なし）と同じ流し方。10 分の区切りをまたぐ発言を流す前に、その時点のマップを残す
  for (const r of fromTranscript(transcript)) {
    while (r.end > nextMark) {
      saveSnapshot(nextMark / 60);
      nextMark += STEP;
    }
    if (stopped) break;
    session.push(r);
    await session.idle();
  }
  if (!stopped) await session.flush();
  saveSnapshot(Math.ceil((fromTranscript(transcript).at(-1)?.end ?? 0) / 60));
  writeFileSync(join(out, "export.json"), JSON.stringify(session.exportJson()));
} finally {
  owned.close();
}
process.stderr.write(`done: calls ${calls}, queries ${queries}, cost $${costSum.toFixed(3)}${stopped ? "（予算で停止）" : ""}\n`);
