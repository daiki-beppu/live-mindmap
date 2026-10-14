// 素の Node プロセスで ManagedDeps.load("chromium") → launch → close を通す。
// vitest のモジュール実行は CJS の default を名前つき export として補うため、不具合は vitest の中では隠れる。
import { Effect } from "effect";
import { depsDirConfig } from "../../src/config.ts";
import { ManagedDeps } from "../../src/managedDeps.ts";
import { managedLayer } from "./managedDeps.ts";

const program = Effect.gen(function* () {
  const root = yield* depsDirConfig;
  return yield* Effect.gen(function* () {
    const deps = yield* ManagedDeps;
    const items = yield* deps.check(["chromium"]);
    if (items.some((item) => item.state !== "ready")) {
      return yield* Effect.fail(new Error("Chromium がありません。pnpm cli install chromium で入る（LIVE_MINDMAP_DEPS で置き場所を変更できます）"));
    }
    const module = yield* deps.load("chromium");
    return yield* Effect.tryPromise({
      try: async () => {
        const browser = await module.chromium.launch();
        try {
          return { version: await browser.version() };
        } finally {
          await browser.close();
        }
      },
      catch: (error) => error instanceof Error ? error : new Error(String(error)),
    });
  }).pipe(Effect.provide(managedLayer(root)));
});

try {
  process.stdout.write(JSON.stringify(await Effect.runPromise(program)));
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
}
