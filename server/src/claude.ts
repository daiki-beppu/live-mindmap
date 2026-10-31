import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Context, Effect, Exit, Layer, Option, Queue, Ref, Schema, Scope, Stream } from "effect";
import { DiffOperations, DiffUpdatePaused, DiffUpdater, type DiffInput, type KatakanaAnswer, type DiffResult, type DiffUsage, type MeetingMap, type ScreenChange } from "./core/index.ts";

import { buildPrompt, CRITERIA_OUTPUT_SCHEMA, OUTPUT_SCHEMA, DIFF_SYSTEM as SYSTEM } from "./claudePrompt.ts";
import { fmtTime } from "./remarkLine.ts";
import { KATAKANA_JSON_SCHEMA, KATAKANA_SYSTEM, KatakanaOutput, katakanaPrompt, toAnswers } from "./katakanaPrompt.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { SupplementOutput, type SupplementInput } from "./core/supplement.ts";
import { SUPPLEMENT_JSON_SCHEMA, SUPPLEMENT_SYSTEM, supplementPrompt } from "./supplementPrompt.ts";

export { buildPrompt, NOOP_SCOPE } from "./claudePrompt.ts";

type ContentBlockParam = Exclude<SDKUserMessage["message"]["content"], string>[number];

function screenBlocks(screens: readonly ScreenChange[]): ContentBlockParam[] {
  return screens.flatMap((s): ContentBlockParam[] =>
    s.image === null
      ? [{ type: "text", text: `## 共有画面：なし（[${fmtTime(s.start)}] から）` }]
      : [
          { type: "text", text: `## 共有画面 [${fmtTime(s.start)}] から` },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(s.image.bytes).toString("base64") } },
        ],
  );
}

// 1 つの query を開いたまま使い回す回数。会話の履歴がたまり続けないよう、この回数ごとに開き直す。
// 14 は、計測（#75）で品質を確かめた最長の回数
export const QUERY_RENEW_CALLS = 14;
const RETAINED_SCREENS_MAX = 2;

// Haiku 5.5 のときだけ SYSTEM の末尾に足す念押し（#719）
const HAIKU_DECISION_APPEND = [
  "# 念押し（必ず守る）",
  "## 決定を TODO で置き換えない",
  "- 合意した内容（「〜してもらう」「〜を絞る」「〜にする」）は、論点の子の決定にする。合意に担当者の作業が付いていても、決定を TODO で済ませない。",
  "- その作業は、決定とは別に TODO として add する。決定と TODO の両方を残す。",
].join("\n");

export const claudeTuning = (model: string): { readonly effort: "low" | "medium"; readonly systemAppend: string } =>
  model === "claude-haiku-5-5"
    ? { effort: "low", systemAppend: HAIKU_DECISION_APPEND }
    : { effort: "medium", systemAppend: "" };

export class AgentSdk extends Context.Service<AgentSdk, {
  readonly query: typeof import("@anthropic-ai/claude-agent-sdk")["query"];
}>()("live-mindmap/server/AgentSdk") {
  static readonly layer = Layer.effect(AgentSdk, Effect.gen(function* () {
    const sdk = yield* (yield* ManagedDeps).load("claude");
    return AgentSdk.of({ query: sdk.query });
  }));
}

export class ClaudeQueryFailed extends Schema.TaggedError<ClaudeQueryFailed>()("ClaudeQueryFailed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ClaudeResultFailed extends Schema.TaggedError<ClaudeResultFailed>()("ClaudeResultFailed", {
  message: Schema.String,
  subtype: Schema.String,
}) {}

export class DiffOutputInvalid extends Schema.TaggedError<DiffOutputInvalid>()("DiffOutputInvalid", {
  message: Schema.String,
  issue: Schema.Defect(),
}) {}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Open = {
  readonly scope: Scope.Closeable;
  readonly input: Queue.Queue<SDKUserMessage, Cause.Done>;
  readonly query: Query;
  readonly output: AsyncIterator<SDKMessage>;
  readonly calls: number;
  readonly sent?: MeetingMap;
};

export const layerClaude = (model: string) => Layer.effect(
  DiffUpdater,
  Effect.gen(function* () {
    const sdk = yield* AgentSdk;
    const tuning = claudeTuning(model);
    const diffSystem = tuning.systemAppend ? `${SYSTEM}\n\n${tuning.systemAppend}` : SYSTEM;
    const sessionScope = yield* Scope.Scope;
    const current = yield* Ref.make(Option.none<Open>());
    const retainedScreens = yield* Ref.make<readonly ScreenChange[]>([]);
    const closed = yield* Ref.make(false);
    yield* Effect.addFinalizer(() => Ref.set(closed, true));

    const acquireQuery = (systemPrompt: string, schema: Record<string, unknown>) => Effect.acquireRelease(
      Effect.gen(function* () {
        const input = yield* Queue.unbounded<SDKUserMessage, Cause.Done>();
        const q = yield* Effect.try({
          try: () => sdk.query({
            prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
            options: {
              model, systemPrompt, effort: tuning.effort,
              tools: [], settingSources: [], persistSession: false, maxTurns: 4,
              mcpServers: {}, strictMcpConfig: true, plugins: [], skills: [], agents: {},
              outputFormat: { type: "json_schema", schema },
              // env は subprocess の環境を置き換えるので process.env を引き継ぐ。NONESSENTIAL_TRAFFIC はテレメトリー・エラー報告などの不要な通信を止める
              env: { ...process.env, FORCE_PROMPT_CACHING_5M: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
            },
          }),
          catch: (e) => new ClaudeQueryFailed({ message: messageOf(e), cause: e }),
        }).pipe(Effect.tapError(() => Queue.end(input)));
        return { input, query: q, output: q[Symbol.asyncIterator]() };
      }),
      (o) => Queue.end(o.input).pipe(Effect.andThen(Effect.sync(() => o.query.close()))),
    );

    const open = (criteria: readonly string[] | undefined) => Effect.gen(function* () {
      const scope = yield* Scope.fork(sessionScope, "sequential");
      return yield* acquireQuery(diffSystem, criteria?.length ? CRITERIA_OUTPUT_SCHEMA : OUTPUT_SCHEMA).pipe(
        Effect.map((q): Open => ({ scope, ...q, calls: 0 })),
        Scope.provide(scope),
        Effect.tapError(() => Scope.close(scope, Exit.void)),
      );
    });

    const discard = (o: Open) =>
      Ref.update(current, (c) => (Option.isSome(c) && c.value.scope === o.scope ? Option.none() : c)).pipe(
        Effect.andThen(Scope.close(o.scope, Exit.void)),
      );

    const advance = (o: Open, f: (x: Open) => Open) =>
      Ref.update(current, (c) => (Option.isSome(c) && c.value.scope === o.scope ? Option.some(f(c.value)) : c));

    // 型は必須だが、値は null や欠けがありうる（usage 自体が無い result も流れる）ので 0 に寄せる
    const usageOf = (
      u: Partial<Record<"input_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens" | "output_tokens", number | null>> | undefined,
      model: string,
    ): DiffUsage => ({
      input: u?.input_tokens ?? 0,
      cacheWrite: u?.cache_creation_input_tokens ?? 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      output: u?.output_tokens ?? 0,
      model,
    });

    // resetsAt は秒なのでミリ秒にして渡す
    const pausedByLimit = (resetsAt: number | undefined) =>
      new DiffUpdatePaused({ reason: "Claude の利用上限", message: "Claude の利用上限", ...(resetsAt !== undefined ? { retryAt: resetsAt * 1000 } : {}) });

    const next = (o: { readonly output: AsyncIterator<SDKMessage> }) =>
      Effect.tryPromise({
        try: () => o.output.next(),
        catch: (e) => new ClaudeQueryFailed({ message: messageOf(e), cause: e }),
      });

    // SDK は 1 応答をブロックごとの assistant で、同じ id・同じ usage のまま流す。output_tokens は仮の値なので、
    // assistant の usage を足すと重なって出力が少なくなる。そのため 4 項目は result の usage（その turn の分。
    // 構造化出力のやり直しも含む）から取り、model だけ assistant から取る。
    // modelUsage・total_cost_usd は query 全体の累計なので使わない（金額は単価が変わるので持たない）
    const awaitStructured = Effect.fnUntraced(function* (o: { readonly output: AsyncIterator<SDKMessage> }, label: string): Effect.fn.Return<{ structured: unknown; usage: DiffUsage | undefined }, ClaudeQueryFailed | ClaudeResultFailed | DiffUpdatePaused> {
      let model: string | undefined;
      for (;;) {
        const { value: m, done } = yield* next(o);
        if (done) return yield* new ClaudeQueryFailed({ message: `${label}の結果が無い`, cause: "stream ended before result" });
        if (m.type === "assistant") {
          model = m.message.model;
          continue;
        }
        if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") return yield* pausedByLimit(m.rate_limit_info.resetsAt);
        if (m.type !== "result") continue;
        if (m.subtype !== "success") return yield* new ClaudeResultFailed({ message: `${label}に失敗: ${m.subtype}`, subtype: m.subtype });
        return { structured: m.structured_output, usage: model === undefined ? undefined : usageOf(m.usage, model) };
      }
    });

    const awaitResult = Effect.fnUntraced(function* (o: Open): Effect.fn.Return<DiffResult, ClaudeQueryFailed | ClaudeResultFailed | DiffOutputInvalid | DiffUpdatePaused> {
      const { structured, usage } = yield* awaitStructured(o, "差分更新");
      const decoded = yield* Schema.decodeUnknownEffect(DiffOperations)(structured).pipe(
        Effect.mapError((e) => new DiffOutputInvalid({ message: `差分更新の出力が不正: ${e.message}`, issue: e.issue })),
      );
      return { ...decoded, ...(usage ? { usage } : {}) };
    });

    const update = Effect.fn("DiffUpdater.update")(function* (input: DiffInput) {
      if (yield* Ref.get(closed)) return yield* Effect.die(new Error("差分更新の updater は閉じています"));
      let c = yield* Ref.get(current);
      if (Option.isSome(c) && c.value.calls >= QUERY_RENEW_CALLS) {
        yield* discard(c.value);
        c = Option.none();
      }
      const o = Option.isSome(c) ? c.value : yield* open(input.criteria);
      if (Option.isNone(c)) yield* Ref.set(current, Option.some(o));
      return yield* Effect.gen(function* () {
        yield* advance(o, (x) => ({ ...x, calls: x.calls + 1 }));
        const prompt = buildPrompt(input, o.sent);
        const screens = input.screens ?? [];
        const retained = yield* Ref.get(retainedScreens);
        const starts = new Set(screens.map((screen) => screen.start));
        const resend = o.sent === undefined ? retained.filter((screen) => !starts.has(screen.start)) : [];
        const blocks = screenBlocks([...resend, ...screens]);
        const content = blocks.length ? [...blocks, { type: "text" as const, text: prompt }] : prompt;
        if (screens.length) yield* Ref.set(retainedScreens, [...retained, ...screens].slice(-RETAINED_SCREENS_MAX));
        yield* Queue.offer(o.input, { type: "user", message: { role: "user", content }, parent_tool_use_id: null });
        yield* advance(o, (x) => ({ ...x, sent: input.map }));
        return yield* awaitResult(o);
      }).pipe(
        Effect.onError(() => discard(o)),
      );
    });

    const katakana = Effect.fn("DiffUpdater.katakana")(function* (words: ReadonlyArray<string>) {
      if (yield* Ref.get(closed)) return yield* Effect.die(new Error("差分更新の updater は閉じています"));
      return yield* Effect.scoped(Effect.gen(function* () {
        const o = yield* acquireQuery(KATAKANA_SYSTEM, KATAKANA_JSON_SCHEMA);
        yield* Queue.offer(o.input, { type: "user", message: { role: "user", content: katakanaPrompt(words) }, parent_tool_use_id: null });
        const { structured } = yield* awaitStructured(o, "読みの取得");
        const decoded = yield* Schema.decodeUnknownEffect(KatakanaOutput)(structured).pipe(
          Effect.mapError((e) => new DiffOutputInvalid({ message: `読みの出力が不正: ${e.message}`, issue: e.issue })),
        );
        const answers: KatakanaAnswer[] = toAnswers(decoded);
        return answers;
      }));
    });

    const supplement = Effect.fn("DiffUpdater.supplement")(function* (input: SupplementInput) {
      if (yield* Ref.get(closed)) return yield* Effect.die(new Error("差分更新の updater は閉じています"));
      return yield* Effect.scoped(Effect.gen(function* () {
        const o = yield* acquireQuery(SUPPLEMENT_SYSTEM, SUPPLEMENT_JSON_SCHEMA);
        yield* Queue.offer(o.input, { type: "user", message: { role: "user", content: supplementPrompt(input) }, parent_tool_use_id: null });
        const { structured, usage } = yield* awaitStructured(o, "補足の生成");
        const decoded = yield* Schema.decodeUnknownEffect(SupplementOutput)(structured).pipe(
          Effect.mapError((e) => new DiffOutputInvalid({ message: `補足の出力が不正: ${e.message}`, issue: e.issue })),
        );
        return { ...decoded, ...(usage === undefined ? {} : { usage }) };
      }));
    });

    return DiffUpdater.of({ update, katakana, supplement });
  }),
);
