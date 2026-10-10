// 差分更新（Claude）。開始時に選んだモデルを Agent SDK で呼ぶ。認証は利用者の ANTHROPIC_API_KEY（ADR 0004）。
// Claude の呼び出しはこの関数の後ろに閉じる（ADR 0003）。
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Context, Effect, Exit, Layer, Option, Queue, Ref, Schema, Scope, Stream } from "effect";
import { DiffOperations, DiffUpdater, type DiffInput, type DiffResult, type DiffUsage, type MeetingMap, type ScreenChange } from "./core/index.ts";

import { buildPrompt, fmtTime, OUTPUT_SCHEMA, SYSTEM } from "./claudePrompt.ts";

export { buildPrompt, NOOP_SCOPE } from "./claudePrompt.ts";

type ContentBlockParam = Exclude<SDKUserMessage["message"]["content"], string>[number];

// 入力に来た共有画面の列を、そのままの順で見出し（text）と画像のブロックにする。「なし」は見出しだけ。どれを添えるかは core が決める
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

// Agent SDK の query。テストでは偽物の Layer に替える
export class AgentSdk extends Context.Service<AgentSdk, {
  readonly query: typeof query;
}>()("live-mindmap/server/AgentSdk") {
  static readonly layer = Layer.succeed(AgentSdk, AgentSdk.of({ query }));
}

// SDK が例外を投げた、または result の前にストリームが終わった
export class ClaudeQueryFailed extends Schema.TaggedError<ClaudeQueryFailed>()("ClaudeQueryFailed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

// result の subtype が success ではない
export class ClaudeResultFailed extends Schema.TaggedError<ClaudeResultFailed>()("ClaudeResultFailed", {
  message: Schema.String,
  subtype: Schema.String,
}) {}

// structured_output が無い、または DiffOutput の形に合わない
export class DiffOutputInvalid extends Schema.TaggedError<DiffOutputInvalid>()("DiffOutputInvalid", {
  message: Schema.String,
  issue: Schema.Defect(),
}) {}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 開いている query。子の Scope を閉じると、入力の Queue を終えて query.close() を呼ぶ
type Open = {
  readonly scope: Scope.Closeable;
  readonly input: Queue.Queue<SDKUserMessage, Cause.Done>;
  readonly query: Query;
  readonly output: AsyncIterator<SDKMessage>;
  readonly calls: number;
  readonly sent?: MeetingMap; // この query に前回送ったマップ。開き直しで Open ごと捨てられ、次の最初のメッセージで再び全体を送る
};

// 1 つのセッション（会議）で、開いたままの query を使い回す差分更新。
// 最初の呼び出しで開き、回数・失敗・ストリームの終わりで開き直し、セッションの Scope を閉じると閉じる。
// 呼び出しは同時に 1 つしか走らない前提（core の session が直列に呼ぶ）。
export const layerClaude = (model: string) => Layer.effect(
  DiffUpdater,
  Effect.gen(function* () {
    const sdk = yield* AgentSdk;
    const sessionScope = yield* Scope.Scope;
    const current = yield* Ref.make(Option.none<Open>());
    const closed = yield* Ref.make(false);
    yield* Effect.addFinalizer(() => Ref.set(closed, true));

    const open = Effect.gen(function* () {
      const scope = yield* Scope.fork(sessionScope, "sequential");
      return yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<SDKUserMessage, Cause.Done>();
          const q = yield* Effect.try({
            try: () => sdk.query({
              prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
              options: {
                model, systemPrompt: SYSTEM,
                tools: [], settingSources: [], persistSession: false, maxTurns: 4,
                mcpServers: {}, strictMcpConfig: true, plugins: [], skills: [], agents: {},
                outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA },
                env: { ...process.env, FORCE_PROMPT_CACHING_5M: "1" }, // env は subprocess の環境を置き換えるので process.env を引き継ぐ
              },
            }),
            catch: (e) => new ClaudeQueryFailed({ message: messageOf(e), cause: e }),
          }).pipe(Effect.tapError(() => Queue.end(input)));
          const opened: Open = { scope, input, query: q, output: q[Symbol.asyncIterator](), calls: 0 };
          return opened;
        }),
        (o) => Queue.end(o.input).pipe(Effect.andThen(Effect.sync(() => o.query.close()))),
      ).pipe(
        Scope.provide(scope),
        Effect.tapError(() => Scope.close(scope, Exit.void)),
      );
    });

    // 使っている query を捨てる。Ref を空にしてから子の Scope を閉じる
    const discard = (o: Open) =>
      Ref.update(current, (c) => (Option.isSome(c) && c.value.scope === o.scope ? Option.none() : c)).pipe(
        Effect.andThen(Scope.close(o.scope, Exit.void)),
      );

    // 今の query が o と同じ（scope が同じ）ときだけ、Open を新しい値に置き換える。discard した後の query は戻さない
    const advance = (o: Open, f: (x: Open) => Open) =>
      Ref.update(current, (c) => (Option.isSome(c) && c.value.scope === o.scope ? Option.some(f(c.value)) : c));

    const next = (o: Open) =>
      Effect.tryPromise({
        try: () => o.output.next(),
        catch: (e) => new ClaudeQueryFailed({ message: messageOf(e), cause: e }),
      });

    // result までに届いた assistant の message.usage を足す（再試行で要求が複数でも全部数える）。
    // result の usage は最後の 1 回分しか持たず、modelUsage・total_cost_usd は使わない（金額は単価が変わるので持たない）
    const awaitResult = Effect.fnUntraced(function* (o: Open): Effect.fn.Return<DiffResult, ClaudeQueryFailed | ClaudeResultFailed | DiffOutputInvalid> {
      let usage: DiffUsage | undefined;
      for (;;) {
        const { value: m, done } = yield* next(o);
        if (done) return yield* new ClaudeQueryFailed({ message: "差分更新の結果が無い", cause: "stream ended before result" });
        if (m.type === "assistant") {
          const u = m.message.usage;
          usage = {
            input: (usage?.input ?? 0) + u.input_tokens,
            cacheWrite: (usage?.cacheWrite ?? 0) + (u.cache_creation_input_tokens ?? 0),
            cacheRead: (usage?.cacheRead ?? 0) + (u.cache_read_input_tokens ?? 0),
            output: (usage?.output ?? 0) + u.output_tokens,
            model: m.message.model,
          };
          continue;
        }
        if (m.type !== "result") continue;
        if (m.subtype !== "success") return yield* new ClaudeResultFailed({ message: `差分更新に失敗: ${m.subtype}`, subtype: m.subtype });
        const decoded = yield* Schema.decodeUnknownEffect(DiffOperations)(m.structured_output).pipe(
          Effect.mapError((e) => new DiffOutputInvalid({ message: `差分更新の出力が不正: ${e.message}`, issue: e.issue })),
        );
        return { ...decoded, ...(usage ? { usage } : {}) };
      }
    });

    const update = Effect.fn("DiffUpdater.update")(function* (input: DiffInput) {
      if (yield* Ref.get(closed)) return yield* Effect.die(new Error("差分更新の updater は閉じています"));
      let c = yield* Ref.get(current);
      if (Option.isSome(c) && c.value.calls >= QUERY_RENEW_CALLS) {
        yield* discard(c.value);
        c = Option.none();
      }
      const o = Option.isSome(c) ? c.value : yield* open;
      if (Option.isNone(c)) yield* Ref.set(current, Option.some(o));
      return yield* Effect.gen(function* () {
        yield* advance(o, (x) => ({ ...x, calls: x.calls + 1 }));
        const prompt = buildPrompt(input, o.sent);
        // 開き直した query の最初のメッセージ（o.sent が未設定）にだけ、core が載せた送り直す画面を、新しく添える画面の前に付ける。
        // 画面のブロックが無い呼び出しは、今までどおり文字列のまま
        const blocks = [...(o.sent === undefined ? screenBlocks(input.previousScreens ?? []) : []), ...screenBlocks(input.screens ?? [])];
        const content = blocks.length ? [...blocks, { type: "text" as const, text: prompt }] : prompt;
        yield* Queue.offer(o.input, { type: "user", message: { role: "user", content }, parent_tool_use_id: null });
        yield* advance(o, (x) => ({ ...x, sent: input.map }));
        return yield* awaitResult(o);
      }).pipe(
        // 失敗・defect・中断のどれでも、その query は使い続けず、次の呼び出しで開き直す
        Effect.onError(() => discard(o)),
      );
    });

    return DiffUpdater.of({ update });
  }),
);
