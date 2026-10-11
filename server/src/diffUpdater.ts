// 差分更新の準備。経路ごとの設定と接続検査は core の外で解決する。
// claude.ts は Claude Agent SDK を読み込むので、使うコマンドの handler が動くときだけ開く（import も遅らせる）。
import { Effect, Layer } from "effect";
import { AppleIntelligence } from "./appleIntelligence.ts";
import { prepareAppleUpdater } from "./appleDiffUpdater.ts";
import { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { localUpdaterLayer } from "./localDiffUpdater.ts";
import { prepareChatgpt } from "./chatgptResponses.ts";
import { prepareCompatible } from "./openaiCompatible.ts";
import { appleRefusal } from "./modelSelection.ts";

const prepareClaude = Effect.fnUntraced(function* (model: Extract<ExecutableModel, { route: "claude" }>) {
  const { layerClaude, AgentSdk } = yield* Effect.tryPromise({
    try: () => import("./claude.ts"),
    catch: (e) => new UpdaterUnavailable({ message: e instanceof Error ? e.message : String(e), dependency: "claude" }),
  });
  const sdk = yield* AgentSdk.pipe(Effect.provide(AgentSdk.layer));
  return layerClaude(model.model).pipe(Layer.provide(Layer.succeed(AgentSdk, sdk)));
}, Effect.mapError((error) => new UpdaterUnavailable({ message: error.message, dependency: "claude" })));

export const claudeUpdaterLayer = (model: Extract<ExecutableModel, { route: "claude" }>) => Layer.unwrap(prepareClaude(model));

export const prepareUpdaterLayer = Effect.fnUntraced(function* (model: ExecutableModel) {
  if (model.route === "claude") {
    return yield* prepareClaude(model);
  }
  if (model.route === "apple") {
    const state = yield* (yield* AppleIntelligence).availability;
    const refusal = appleRefusal(state);
    if (refusal !== undefined) return yield* new UpdaterUnavailable({ message: refusal.join("\n") });
    return yield* prepareAppleUpdater(model);
  }
  const local = yield* (model.route === "chatgpt" ? prepareChatgpt(model) : prepareCompatible(model));
  return localUpdaterLayer(local);
}, Effect.mapError((failure) => failure instanceof UpdaterUnavailable ? failure : new UpdaterUnavailable({ message: failure.message })));
