import { Context, Effect, Layer, Schema } from "effect";
import type { Browser } from "playwright-core";
import { ManagedDeps, ManagedDepsFailed } from "./managedDeps.ts";

// Chromium が管理ディレクトリに入っていない（入れれば直る）。入っているのに読めない・起動できないときは ManagedDepsFailed のまま
export class ChromiumMissing extends Schema.TaggedError<ChromiumMissing>()("ChromiumMissing", {}) {
  override get message(): string {
    return "Chromium が入っていません。pnpm cli install chromium で入る";
  }
}

// Chromium の起動。テストでは偽物の Layer に替える
export class Playwright extends Context.Service<Playwright, {
  readonly launch: () => Effect.Effect<Browser, ChromiumMissing | ManagedDepsFailed>;
}>()("live-mindmap/server/Playwright") {
  static readonly layer = Layer.effect(Playwright)(Effect.gen(function* () {
    const deps = yield* ManagedDeps;
    // 読み込みに失敗したときだけ導入の状態を見て、入っていないなら ChromiumMissing にする（入っているなら元の失敗を返す）
    const missingOr = (error: ManagedDepsFailed) => deps.check(["chromium"]).pipe(
      Effect.orElseSucceed(() => []),
      Effect.flatMap(([item]): Effect.Effect<never, ChromiumMissing | ManagedDepsFailed> => Effect.fail(item?.state === "missing" ? new ChromiumMissing() : error)),
    );
    return Playwright.of({
      launch: Effect.fnUntraced(function* () {
        const module = yield* deps.load("chromium").pipe(Effect.catchTag("ManagedDepsFailed", missingOr));
        return yield* Effect.tryPromise({
          try: () => module.chromium.launch(),
          catch: (error) => new ManagedDepsFailed({ message: error instanceof Error ? error.message : String(error) }),
        });
      }),
    });
  }));
}
