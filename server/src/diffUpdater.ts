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

export const claudeUpdaterLayer = (model: Extract<ExecutableModel, { route: "claude" }>) => Layer.unwrap(
  Effect.tryPromise({
    try: () => import("./claude.ts"),
    catch: (e) => new UpdaterUnavailable({ message: e instanceof Error ? e.message : String(e) }),
  }).pipe(Effect.map(({ layerClaude, AgentSdk }) => layerClaude(model.model).pipe(Layer.provide(AgentSdk.layer)))),
);

export const prepareUpdaterLayer = Effect.fnUntraced(function* (model: ExecutableModel) {
  if (model.route === "claude") return claudeUpdaterLayer(model);
  if (model.route === "apple") {
    const state = yield* (yield* AppleIntelligence).availability;
    const refusal = appleRefusal(state);
    if (refusal !== undefined) return yield* new UpdaterUnavailable({ message: refusal.join("\n") });
    return yield* prepareAppleUpdater(model);
  }
  const classify = yield* (model.route === "chatgpt" ? prepareChatgpt(model) : prepareCompatible(model));
  return localUpdaterLayer(classify);
}, Effect.mapError((failure) => new UpdaterUnavailable({ message: failure.message })));
