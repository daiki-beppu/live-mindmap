import { Context, Effect, Layer, Schema } from "effect";
import type { Browser } from "playwright-core";
import { ManagedDeps, ManagedDepsFailed } from "./managedDeps.ts";

export class ChromiumMissing extends Schema.TaggedError<ChromiumMissing>()("ChromiumMissing", {}) {
  override get message(): string {
    return "Chromium が入っていません。pnpm cli install chromium で入る";
  }
}

export class Playwright extends Context.Service<Playwright, {
  readonly launch: Effect.Effect<Browser, ChromiumMissing | ManagedDepsFailed>;
}>()("live-mindmap/server/Playwright") {
  static readonly layer = Layer.effect(Playwright)(Effect.gen(function* () {
    const deps = yield* ManagedDeps;
    const missingOr = (error: ManagedDepsFailed) => deps.check(["chromium"]).pipe(
      Effect.orElseSucceed(() => []),
      Effect.flatMap(([item]): Effect.Effect<never, ChromiumMissing | ManagedDepsFailed> => Effect.fail(item?.state === "missing" ? new ChromiumMissing() : error)),
    );
    return Playwright.of({
      launch: Effect.gen(function* () {
        const module = yield* deps.load("chromium").pipe(Effect.catchTag("ManagedDepsFailed", missingOr));
        return yield* Effect.tryPromise({
          try: () => module.chromium.launch(),
          catch: (error) => new ManagedDepsFailed({ message: error instanceof Error ? error.message : String(error) }),
        });
      }),
    });
  }));
}
