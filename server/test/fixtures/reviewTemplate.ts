import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { ReviewBuild } from "../../src/review.ts";

export function buildReviewTemplateHtml(): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { build } = yield* ReviewBuild;
      return yield* build;
    }).pipe(Effect.provide(ReviewBuild.layer), Effect.provide(NodeFileSystem.layer)),
  );
}
