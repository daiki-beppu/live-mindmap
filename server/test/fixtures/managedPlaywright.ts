import { Effect, Layer } from "effect";
import { depsDirConfig } from "../../src/config.ts";
import { ManagedDeps, ManagedDepsFailed } from "../../src/managedDeps.ts";
import { Playwright } from "../../src/playwright.ts";
import { managedLayer } from "./managedDeps.ts";

// heavy IT は利用者と同じ管理ルートを使う。未導入を画像や DOM の失敗として扱わない。
export const managedPlaywright = Layer.unwrap(Effect.gen(function* () {
  const root = yield* depsDirConfig;
  return Playwright.layer.pipe(Layer.provide(Layer.unwrap(Effect.gen(function* () {
    const deps = yield* ManagedDeps;
    const items = yield* deps.check(["chromium"]);
    if (items.some((item) => item.state !== "ready")) {
      return yield* new ManagedDepsFailed({ message: "Chromium がありません。pnpm cli install chromium で入る（LIVE_MINDMAP_DEPS で置き場所を変更できます）" });
    }
    return Layer.succeed(ManagedDeps, deps);
  }).pipe(Effect.provide(managedLayer(root))))));
}));
