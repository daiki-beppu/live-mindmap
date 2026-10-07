// 差分更新の Service。Layer が 1 つ分の updater を取得し、使い終わり（最後の反映と最終撮影の後）に閉じる。
// 段 6 で差分更新そのものを Effect にするまでは、Promise の claude.ts の updater を acquireRelease で包む。
import { Context, Effect, Layer, Schema } from "effect";
import type { DiffUpdater as UpdateFn } from "./core/index.ts";

// 差分更新を開けなかった失敗。message はそのまま入口の 1 行になる
export class UpdaterUnavailable extends Schema.TaggedError<UpdaterUnavailable>()("UpdaterUnavailable", {
  message: Schema.String,
}) {}

export class DiffUpdater extends Context.Service<DiffUpdater, {
  readonly update: UpdateFn;
}>()("live-mindmap/server/DiffUpdater") {
  // claude.ts は Claude Agent SDK を読み込むので、使うコマンドの handler が動くときだけ開く（import も遅らせる）
  static readonly layer = Layer.effect(
    DiffUpdater,
    Effect.gen(function* () {
      const { openClaudeUpdater } = yield* Effect.tryPromise({
        try: () => import("./claude.ts"),
        catch: (e) => new UpdaterUnavailable({ message: e instanceof Error ? e.message : String(e) }),
      });
      const opened = yield* Effect.acquireRelease(
        Effect.sync(() => openClaudeUpdater()),
        (updater) => Effect.sync(() => updater.close()),
      );
      return DiffUpdater.of({ update: opened.update });
    }),
  );
}
