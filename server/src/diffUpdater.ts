// 差分更新の準備。経路ごとの設定と接続検査は core の外で解決する。
// claude.ts は Claude Agent SDK を読み込むので、使うコマンドの handler が動くときだけ開く（import も遅らせる）。
import { Effect, Layer, Schema } from "effect";
import type { ExecutableModel } from "./modelSelection.ts";
import { localUpdaterLayer, type Classify } from "./localDiffUpdater.ts";
import { prepareChatgpt } from "./chatgptResponses.ts";
import { prepareCompatible } from "./openaiCompatible.ts";

// 差分更新を開けなかった失敗。message は入口で改行を保って表示する。
export class UpdaterUnavailable extends Schema.TaggedError<UpdaterUnavailable>()("UpdaterUnavailable", {
  message: Schema.String,
}) {}

export const claudeUpdaterLayer = (model: Extract<ExecutableModel, { route: "claude" }>) => Layer.unwrap(
  Effect.tryPromise({
    try: () => import("./claude.ts"),
    catch: (e) => new UpdaterUnavailable({ message: e instanceof Error ? e.message : String(e) }),
  }).pipe(Effect.map(({ layerClaude, AgentSdk }) => layerClaude(model.model).pipe(Layer.provide(AgentSdk.layer)))),
);

export const prepareUpdaterLayer = Effect.fnUntraced(function* (model: ExecutableModel) {
  if (model.route === "claude") return claudeUpdaterLayer(model);
  const preparation: Effect.Effect<Classify, { readonly message: string }, import("effect").FileSystem.FileSystem | import("effect/http").HttpClient.HttpClient> = model.route === "chatgpt" ? prepareChatgpt(model) : prepareCompatible(model);
  const classify = yield* preparation.pipe(
    Effect.mapError((failure) => new UpdaterUnavailable({ message: failure.message })),
  );
  return localUpdaterLayer(classify);
});
