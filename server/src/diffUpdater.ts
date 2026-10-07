// 差分更新の Layer。Layer が 1 つ分の updater を取得し、使い終わり（最後の反映と最終撮影の後）に閉じる。
// Service DiffUpdater は core にある。段 7 で claude.ts を置き換えるまでは、Promise の claude.ts の updater をここで包む。
import { Effect, Layer, Schema } from "effect";
import { DiffUpdater } from "./core/index.ts";

// 差分更新を開けなかった失敗。message はそのまま入口の 1 行になる
export class UpdaterUnavailable extends Schema.TaggedError<UpdaterUnavailable>()("UpdaterUnavailable", {
  message: Schema.String,
}) {}

// 差分更新の 1 回が失敗した（claude.ts の Promise の reject）。core はタグと message だけを見て、ログの error 欄に残す
export class DiffUpdateFailed extends Schema.TaggedError<DiffUpdateFailed>()("DiffUpdateFailed", {
  message: Schema.String,
}) {}

export const LegacyClaudeDiffUpdater = {
  // claude.ts は Claude Agent SDK を読み込むので、使うコマンドの handler が動くときだけ開く（import も遅らせる）
  layer: Layer.effect(
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
      return DiffUpdater.of({
        update: (input) =>
          Effect.tryPromise({
            try: () => opened.update(input),
            catch: (e) => new DiffUpdateFailed({ message: e instanceof Error ? e.message : String(e) }),
          }),
      });
    }),
  ),
};
