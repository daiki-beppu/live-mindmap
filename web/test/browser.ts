import { Effect } from "effect";
import { Playwright } from "../../server/src/playwright.ts";
import { managedPlaywright } from "../../server/test/fixtures/managedPlaywright.ts";

// heavy IT が共有する、利用者と同じ管理ルートの Chromium の起動。

export type Browser = Effect.Success<ReturnType<(typeof Playwright)["Service"]["launch"]>>;
export type Page = Awaited<ReturnType<Browser["newPage"]>>;

// 利用者と同じ管理ルートの Chromium で起動し、use の後に必ず閉じる
export async function withBrowser<T>(use: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Playwright).launch();
    }).pipe(Effect.provide(managedPlaywright), Effect.scoped),
  );
  try {
    return await use(browser);
  } finally {
    await browser.close();
  }
}
