import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { ReviewBuild } from "../../src/review.ts";

// 本物の Vite（single-file）で見返しのテンプレート HTML（ログを差し込む前）を 1 回ビルドして返す。
// ReviewBuild.layer が要る FileSystem を server の依存で満たすので、web の heavy IT は @effect/platform-node を持たずに済む。
export function buildReviewTemplateHtml(): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { build } = yield* ReviewBuild;
      return yield* build;
    }).pipe(Effect.provide(ReviewBuild.layer), Effect.provide(NodeFileSystem.layer)),
  );
}
