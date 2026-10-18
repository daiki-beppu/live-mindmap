import { Effect } from "effect";
import { Playwright } from "../../server/src/playwright.ts";
import { managedPlaywright } from "../../server/test/fixtures/managedPlaywright.ts";

// heavy IT が共有する、利用者と同じ管理ルートの Chromium の起動。

export type Browser = Effect.Success<ReturnType<(typeof Playwright)["Service"]["launch"]>>;
export type BrowserContext = Awaited<ReturnType<Browser["newContext"]>>;
export type Page = Awaited<ReturnType<Browser["newPage"]>>;

// 利用者と同じ管理ルートの Chromium を起動する。ファイルの beforeAll で 1 回だけ呼び、afterAll で閉じる
export const launchBrowser = (): Promise<Browser> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Playwright).launch();
    }).pipe(Effect.provide(managedPlaywright), Effect.scoped),
  );

// テストごとの context。use の後に、成功しても失敗しても必ず閉じる（テストどうしの状態を分ける）
export async function withContext<T>(browser: Browser, options: { viewport: { width: number; height: number } }, use: (context: BrowserContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext(options);
  try {
    return await use(context);
  } finally {
    await context.close();
  }
}
