// PROTOTYPE（#765、使い捨て）— 差分更新の呼び出しごとに判定して Haiku 5.5 と Sonnet 5.5 に振り分け、等速で流す。
// m761.ts（#761・#763）を土台に、Haiku 用と Sonnet 用の query を 1 本ずつ開く DiffUpdater を挟んだもの。
//
// node m765.ts <sonnet|jev|kw> <items.json> <lines.json> <out.json> <truth.json>
//   sonnet: 全部 Sonnet（基準）
//   jev:    新しい発言＋直前 6 発言を Jev に渡し、「決定・TODO を含む」の確からしさ ≥ JEV_MIN なら Sonnet。失敗・時間切れは Sonnet
//   kw:     新しい発言に KEYWORDS のどれかがあれば Sonnet
// Jev の鍵は TYPESAFE_API_KEY（op run --env-file=.env.op -- で渡す）
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer, Schema } from "effect";
import { DiffUpdater, LogEvent, recall, type DiffInput, type DiffUsage, type Remark } from "../../src/core/index.ts";
import { AgentSdk, layerClaude } from "../../src/claude.ts";
import { defaultClaude } from "../../src/modelSelection.ts";
import { readTruthFile, readTextFile } from "../../src/truthFile.ts";
import { readJsonFile } from "../entry.ts";
import { ManagedDeps } from "../../src/managedDeps.ts";
import { depsDirConfig } from "../../src/config.ts";
import { SpokenLine } from "../sttLatency.ts";
import { ReplayItem, reflectedArrivals, replayByArrival } from "../sttReplay.ts";

const [mode, itemsPath, linesPath, outPath, truthPath] = process.argv.slice(2);
if (!["sonnet", "jev", "kw"].includes(mode!)) throw new Error(`mode: ${mode}`);
const SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5";
const JEV_MIN = 0.3; // Q7: 迷ったら Sonnet に倒す
const JEV_TIMEOUT_MS = 1000; // Q9
const CONTEXT = 6; // Q8: 直前の発言の数

// Q2: モデルなしの語の規則
export const KEYWORDS = ["決め", "決ま", "決定", "しましょう", "しよう", "やります", "やる", "までに", "お願い", "担当", "TODO", "宿題", "確認します", "進めます", "にします", "でいきましょう", "合意"];
const kwHit = (fresh: readonly Remark[]) => KEYWORDS.filter((k) => fresh.some((r) => r.text.includes(k)));

type Judge = { readonly to: "sonnet" | "haiku"; readonly kw: string[]; readonly p?: number; readonly jevMs?: number; readonly jevTokens?: number; readonly jevError?: string };

async function askJev(recent: readonly Remark[], fresh: readonly Remark[]) {
  const state = ["# 直前の発言（文脈）", recent.slice(-CONTEXT).map((r) => r.text).join("\n") || "（なし）", "# 新しい発言", fresh.map((r) => r.text).join("\n")].join("\n");
  const t0 = performance.now();
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest", state,
      questions: {
        decision: {
          type: "noul",
          instructions: "会議の文字起こしで、「新しい発言」の中に、決まったこと（合意・結論）か、誰かがやること（TODO・依頼・期限）が含まれるか。直前の発言は文脈で、そこだけにあるものは数えない",
          criteria: { true: "新しい発言で、何かが決まる・合意される、または誰かがやることが頼まれる・引き受けられる", false: "新しい発言は、意見・説明・質問・相づちだけで、決まったこともやることも無い" },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}`);
  const b = await res.json() as { answers: { decision: { noul: number } }; usage?: { input_tokens?: number } };
  return { p: b.answers.decision.noul, ms: performance.now() - t0, tokens: b.usage?.input_tokens ?? 0 };
}

const judge = async (input: DiffInput): Promise<Judge> => {
  const kw = kwHit(input.fresh);
  if (mode === "sonnet") return { to: "sonnet", kw };
  if (mode === "kw") return { to: kw.length ? "sonnet" : "haiku", kw };
  try {
    const a = await askJev(input.recent, input.fresh);
    return { to: a.p >= JEV_MIN ? "sonnet" : "haiku", kw, p: a.p, jevMs: a.ms, jevTokens: a.tokens };
  } catch (e) {
    return { to: "sonnet", kw, jevError: e instanceof Error ? e.name + ": " + e.message : String(e) };
  }
};

type Call = { start: number; judged: number; end: number; fresh: string[]; ok: boolean; judge: Judge; usage?: DiffUsage };
const calls: Call[] = [];
let t0 = 0;
const now = () => (performance.now() - t0) / 1000;

// Q3 (a): モデルごとに query を 1 本ずつ持つ。各 query は自分が前回送ったマップからの変更を受け取る。
// 前回の応答の仮 id と捨てた操作（#697）は、その query 自身の前回の応答の分だけを渡す（もう一方のモデルの仮 id は通じない）
const routed = Layer.effect(DiffUpdater)(Effect.gen(function* () {
  const sdk = yield* AgentSdk;
  const build = (model: string) => Layer.build(layerClaude(model).pipe(Layer.provide(Layer.succeed(AgentSdk, sdk)))).pipe(Effect.map((ctx) => Context.getUnsafe(ctx, DiffUpdater)));
  const updaters = { sonnet: yield* build(SONNET), haiku: mode === "sonnet" ? undefined : yield* build(HAIKU) };
  const lastBy: { sonnet?: DiffInput["lastApplied"]; haiku?: DiffInput["lastApplied"] } = {};
  let prev: "sonnet" | "haiku" | undefined;
  return {
    update: (input: DiffInput) => Effect.gen(function* () {
      if (prev) lastBy[prev] = input.lastApplied; // 直前の呼び出しの応答（失敗なら undefined）は、それを返したモデルのもの
      const start = now();
      const j = yield* Effect.promise(() => judge(input));
      const judged = now();
      const { lastApplied: _, ...rest } = input;
      const own = lastBy[j.to];
      prev = j.to;
      const fresh = input.fresh.map((r) => r.id);
      const result = yield* updaters[j.to]!.update({ ...rest, ...(own ? { lastApplied: own } : {}) }).pipe(
        Effect.tapError(() => Effect.sync(() => calls.push({ start, judged, end: now(), fresh, ok: false, judge: j }))),
      );
      calls.push({ start, judged, end: now(), fresh, ok: true, judge: j, ...(result.usage ? { usage: result.usage } : {}) });
      return result;
    }),
  };
})).pipe(Layer.provide(AgentSdk.layer));

const main = Effect.gen(function* () {
  const items = yield* readJsonFile(itemsPath!, Schema.Array(ReplayItem));
  const lines = yield* readJsonFile(linesPath!, Schema.Array(SpokenLine));
  const { createSessionDir, openRecordedSession } = yield* Effect.promise(() => import("../../src/sessionFiles.ts"));
  const dir = yield* createSessionDir(mkdtempSync(join(tmpdir(), "m765-"))).pipe(Effect.orDie);
  const diffEnds: number[] = [];
  const { session } = yield* openRecordedSession({ model: defaultClaude, dir, title: "bench", publish: () => Effect.void, onDiff: Effect.sync(() => diffEnds.push(now())) });
  t0 = performance.now();
  yield* replayByArrival(session, items);
  const log = yield* readTextFile(join(dir, "log.jsonl")).pipe(Effect.orDie);
  const events = yield* Effect.forEach(log.trim().split("\n"), (l) => Schema.decodeEffect(Schema.fromJsonString(LogEvent))(l)).pipe(Effect.orDie);
  const diffs = events.filter((e) => e.type === "diff");
  const arrivals = reflectedArrivals(diffs as never, diffEnds, items);
  const rec = truthPath ? recall(yield* session.exportJson, yield* readTruthFile(truthPath)) : undefined;
  writeFileSync(outPath!, JSON.stringify({ mode, dir, items, lines, calls, diffEnds, arrivals, recall: rec, failed: diffs.filter((d) => "error" in d && d.error).length }));
  console.log(`done ${dir} calls=${calls.length}`);
}).pipe(Effect.scoped, Effect.provide(routed));

const managedDeps = Layer.unwrap(Effect.gen(function* () {
  const root = yield* depsDirConfig;
  return ManagedDeps.layer({ root }).pipe(Layer.provide(NodeServices.layer));
}));
main.pipe(Effect.provide(Layer.mergeAll(managedDeps, NodeServices.layer)), NodeRuntime.runMain);
