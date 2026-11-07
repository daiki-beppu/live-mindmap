// vitest のモジュール実行は CJS の default を名前つき export として補うため、不具合は vitest の中では隠れる。
import { Effect } from "effect";
import { ManagedDeps } from "../../src/managedDeps.ts";
import { readyChromiumDeps } from "./managedDeps.ts";

const program = Effect.gen(function* () {
  const module = yield* (yield* ManagedDeps).load("chromium");
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
}).pipe(Effect.provide(readyChromiumDeps));

try {
  process.stdout.write(JSON.stringify(await Effect.runPromise(program)));
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
}
