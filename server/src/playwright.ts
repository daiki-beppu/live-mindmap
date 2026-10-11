import { Context, Effect, Layer } from "effect";
import type { Browser } from "playwright-core";
import { ManagedDeps, ManagedDepsFailed } from "./managedDeps.ts";

// Chromium の起動。テストでは偽物の Layer に替える
export class Playwright extends Context.Service<Playwright, {
  readonly launch: () => Effect.Effect<Browser, ManagedDepsFailed>;
}>()("live-mindmap/server/Playwright") {
  static readonly layer = Layer.effect(Playwright)(Effect.gen(function* () {
    const deps = yield* ManagedDeps;
    return Playwright.of({
      launch: Effect.fnUntraced(function* () {
        const module = yield* deps.load("chromium");
        return yield* Effect.tryPromise({
          try: () => module.chromium.launch(),
          catch: (error) => new ManagedDepsFailed({ message: error instanceof Error ? error.message : String(error) }),
        });
      }),
    });
  }));
}
