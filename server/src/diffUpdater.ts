// 差分更新の準備。経路ごとの設定と接続検査は core の外で解決する。
// claude.ts は Claude Agent SDK を読み込むので、使うコマンドの handler が動くときだけ開く（import も遅らせる）。
import { Effect, Layer } from "effect";
import { AppleIntelligence } from "./appleIntelligence.ts";
import { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { localUpdaterLayer, type Classify } from "./localDiffUpdater.ts";
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
  }
  const preparation: Effect.Effect<Classify, { readonly message: string }, import("effect").FileSystem.FileSystem | import("effect/http").HttpClient.HttpClient> = model.route === "chatgpt"
    ? prepareChatgpt(model)
    : prepareCompatible(model.route === "apple"
      ? { name: model.name, route: "openai-compatible" as const, model: "apple", local: false as const, ...(yield* (yield* AppleIntelligence).launch) }
      : model);
  const classify = yield* preparation.pipe(
    Effect.mapError((failure) => new UpdaterUnavailable({ message: failure.message })),
  );
  return localUpdaterLayer(classify);
});
