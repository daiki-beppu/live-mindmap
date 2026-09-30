// PROTOTYPE — 録音サンプルの文字起こしを会議の時間順に再生し、差分更新を回してログを残す。
// 使い方: bun run.ts --sample facilitators-meeting --model claude-sonnet-5-5 --batch 2 [--gate jev] [--until 600]
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { applyOps, emptyMap, type Applied, type MindMap, type Segment } from "./map";
import { buildPrompt, proposeOps, type CallResult } from "./claude";
import { hintFor, JevGate, OpenAIDecisionsGate, decide, type Gate, type GateAnswers } from "./gate";

const { values: a } = parseArgs({
  options: {
    sample: { type: "string", default: "facilitators-meeting" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    effort: { type: "string" },
    batch: { type: "string", default: "2" }, // ゲートなしのとき、何発言ごとに Claude を呼ぶか
    gate: { type: "string", default: "none" }, // none | jev | openai
    recent: { type: "string", default: "3" }, // 文脈として添える処理済みの発言数
    until: { type: "string" }, // 会議の何秒目まで再生するか
    out: { type: "string" },
  },
});

const raw = await Bun.file(`${homedir()}/live-mindmap-samples/${a.sample}.transcript.json`).json();
const segments: Segment[] = raw.transcript.segments
  .map((s: any, i: number) => ({ id: `s${i + 1}`, start: s.start_seconds, end: s.end_seconds, track: s.track, text: s.text }))
  .filter((s: Segment) => !a.until || s.end <= Number(a.until));

const gate: Gate | null = a.gate === "jev" ? new JevGate() : a.gate === "openai" ? new OpenAIDecisionsGate() : null;
const batch = Number(a.batch), recentN = Number(a.recent);
const name = a.out ?? `${a.sample}__${a.model}${a.effort ? `-${a.effort}` : ""}__${gate ? `gate-${gate.name}` : `batch${batch}`}`;

type Step = {
  at: number; // この呼び出しの対象の最後の発言が終わった時刻（会議内の秒）
  segIds: string[];
  gate?: GateAnswers[];
  hint?: string;
  call?: Omit<CallResult, "ops">;
  results: Applied[];
  map: MindMap;
};

let map = emptyMap(a.sample);
const known = new Set<string>();
const steps: Step[] = [];
let pending: Segment[] = [], pendingAnswers: GateAnswers[] = [];
let done = 0;

async function flush() {
  const fresh = pending, answers = pendingAnswers;
  pending = []; pendingAnswers = [];
  const recent = segments.slice(Math.max(0, done - recentN), done);
  done += fresh.length;
  for (const s of fresh) known.add(s.id);
  const hint = gate ? hintFor(map, answers) : undefined;
  const res = await proposeOps(a.model!, buildPrompt(map, recent, fresh, hint), a.effort as any);
  const { ops, ...call } = res;
  const applied = applyOps(map, ops, fresh.at(-1)!.end, known);
  map = applied.map;
  steps.push({ at: fresh.at(-1)!.end, segIds: fresh.map((s) => s.id), gate: gate ? answers : undefined, hint, call, results: applied.results, map });
  const bad = applied.results.filter((r) => !r.ok).length;
  console.log(`[${fmt(fresh.at(-1)!.end)}] ${fresh.length} 発言 → ${ops.map((o) => o.op).join(",") || "-"}${bad ? ` (不正 ${bad})` : ""} ${call.latencyMs}ms $${call.costUSD.toFixed(4)}${call.error ? ` ERROR ${call.error}` : ""}`);
}

// ゲートが捨てた発言も、Claude を呼ばなかったステップとして記録する
function drop() {
  steps.push({ at: pending.at(-1)!.end, segIds: pending.map((s) => s.id), gate: pendingAnswers, results: [], map });
  done += pending.length;
  for (const s of pending) known.add(s.id); // 捨てた発言も直前の発言として Claude に見えるので、根拠に使えるようにする
  pending = []; pendingAnswers = [];
}
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

for (const [i, seg] of segments.entries()) {
  pending.push(seg);
  if (gate) {
    const ans = await gate.ask(map, segments.slice(Math.max(0, i - recentN), i), seg);
    pendingAnswers.push(ans);
    const action = decide(pending, pendingAnswers, seg.end - pending[0]!.end);
    if (action === "flush") await flush();
    else if (action === "drop") drop();
  } else if (pending.length >= batch) {
    await flush();
  }
}
if (pending.length) await flush();

const calls = steps.filter((s) => s.call);
const sum = (f: (s: Step) => number) => calls.reduce((t, s) => t + f(s), 0);
const summary = {
  calls: calls.length,
  costUSD: sum((s) => s.call!.costUSD),
  meanLatencyMs: Math.round(sum((s) => s.call!.latencyMs) / calls.length),
  invalidOps: steps.flatMap((s) => s.results).filter((r) => !r.ok).length,
  errors: calls.filter((s) => s.call!.error).length,
  nodes: Object.keys(map.nodes).length - 1,
};
console.log(summary);
mkdirSync("runs", { recursive: true });
writeFileSync(`runs/${name}.json`, JSON.stringify({ config: { ...a, name }, segments, steps, summary }));
console.log(`→ runs/${name}.json`);
