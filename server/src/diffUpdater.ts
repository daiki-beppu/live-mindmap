// 差分更新の Layer。Service DiffUpdater は core にあり、実装は claude.ts の ClaudeDiffUpdater.layer。
// claude.ts は Claude Agent SDK を読み込むので、使うコマンドの handler が動くときだけ開く（import も遅らせる）。
import { Effect, Layer, Schema } from "effect";

// 差分更新を開けなかった失敗。message はそのまま入口の 1 行になる
export class UpdaterUnavailable extends Schema.TaggedError<UpdaterUnavailable>()("UpdaterUnavailable", {
  message: Schema.String,
}) {}

export const claudeUpdaterLayer = Layer.unwrap(
  Effect.tryPromise({
    try: () => import("./claude.ts"),
    catch: (e) => new UpdaterUnavailable({ message: e instanceof Error ? e.message : String(e) }),
  }).pipe(Effect.map(({ ClaudeDiffUpdater, AgentSdk }) => ClaudeDiffUpdater.layer.pipe(Layer.provide(AgentSdk.layer)))),
);
