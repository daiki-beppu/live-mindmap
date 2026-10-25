import { Effect } from "effect";
import { Playwright } from "../../server/src/playwright.ts";
import { managedPlaywright } from "../../server/test/fixtures/managedPlaywright.ts";

export type Browser = Effect.Success<(typeof Playwright)["Service"]["launch"]>;
export type BrowserContext = Awaited<ReturnType<Browser["newContext"]>>;
export type Page = Awaited<ReturnType<Browser["newPage"]>>;

export const launchBrowser = (): Promise<Browser> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Playwright).launch;
    }).pipe(Effect.provide(managedPlaywright), Effect.scoped),
  );

export async function withContext<T>(browser: Browser, options: { viewport: { width: number; height: number } }, use: (context: BrowserContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext(options);
  try {
    return await use(context);
  } finally {
    await context.close();
  }
}
