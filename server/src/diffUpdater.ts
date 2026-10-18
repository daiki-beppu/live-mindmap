// 差分更新の準備。経路ごとの設定と接続検査は core の外で解決する。
// claude.ts は Claude Agent SDK を読み込むので、使うコマンドの handler が動くときだけ開く（import も遅らせる）。
import { Context, Effect, Layer } from "effect";
import { AppleIntelligence } from "./appleIntelligence.ts";
import { prepareAppleUpdater } from "./appleDiffUpdater.ts";
import { UpdaterUnavailable } from "./updaterUnavailable.ts";
import { DiffUpdater } from "./core/index.ts";
import { type ExecutableModel } from "./modelSelection.ts";
import { type JudgeModel } from "./judgeSelection.ts";
import { HAIKU, routedUpdater, SONNET } from "./routedDiffUpdater.ts";
import { makeSystemOne } from "./systemOne.ts";
import { localUpdaterLayer } from "./localDiffUpdater.ts";
import { prepareChatgpt } from "./chatgptResponses.ts";
import { prepareCompatible } from "./openaiCompatible.ts";
import { appleRefusal } from "./modelSelection.ts";

type ClaudeModel = Extract<ExecutableModel, { route: "claude" }>;

const loadClaude = Effect.fnUntraced(function* () {
  const { layerClaude, AgentSdk } = yield* Effect.tryPromise({
    try: () => import("./claude.ts"),
    catch: (e) => new UpdaterUnavailable({ message: e instanceof Error ? e.message : String(e), dependency: "claude" }),
  });
  const sdk = yield* AgentSdk.pipe(Effect.provide(AgentSdk.layer));
  return (model: string) => layerClaude(model).pipe(Layer.provide(Layer.succeed(AgentSdk, sdk)));
}, Effect.mapError((error) => new UpdaterUnavailable({ message: error.message, dependency: "claude" })));

const prepareClaude = Effect.fnUntraced(function* (model: ClaudeModel) {
  return (yield* loadClaude())(model.model);
});

// Sonnet 5.5 用と Haiku 5.5 用の query を 1 本ずつ持つ振り分け。keys は judgeEnvs(judge) の順の値（鍵の有無は planLayer が確かめ済み）
export const prepareRoutedLayer = Effect.fnUntraced(function* (judge: JudgeModel, keys: readonly string[]) {
  const ask = yield* makeSystemOne(judge, { apiKey: keys[0]!, ...(judge.accountIdEnv === undefined ? {} : { accountId: keys[1]! }) });
  const claude = yield* loadClaude();
  return Layer.effect(DiffUpdater, Effect.gen(function* () {
    // それぞれの Layer は自分の Service を提供するので、別々に build して取り出す（セッションの Scope が閉じると両方閉じる）
    const sonnet = Context.get(yield* Layer.build(claude(SONNET)), DiffUpdater);
    const haiku = Context.get(yield* Layer.build(claude(HAIKU)), DiffUpdater);
    return yield* routedUpdater({ ask, sonnet, haiku });
  }));
});

export const claudeUpdaterLayer = (model: Extract<ExecutableModel, { route: "claude" }>) => Layer.unwrap(prepareClaude(model));

export const prepareUpdaterLayer = Effect.fnUntraced(function* (model: ExecutableModel) {
  if (model.route === "claude") return yield* prepareClaude(model);
  if (model.route === "apple") {
    const state = yield* (yield* AppleIntelligence).availability;
    const refusal = appleRefusal(state);
    if (refusal !== undefined) return yield* new UpdaterUnavailable({ message: refusal.join("\n") });
    return yield* prepareAppleUpdater(model);
  }
  const local = yield* (model.route === "chatgpt" ? prepareChatgpt(model) : prepareCompatible(model));
  return localUpdaterLayer(local);
}, Effect.mapError((failure) => failure instanceof UpdaterUnavailable ? failure : new UpdaterUnavailable({ message: failure.message })));
