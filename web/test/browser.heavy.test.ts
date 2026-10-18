import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser, withContext, type Browser, type BrowserContext } from "./browser.ts";
import { PAGE_VIEWPORT, TIMEOUT } from "./reviewPage.ts";

// withContext は、テストが失敗（reject）しても context を閉じる。共有の browser では閉じ忘れが後続のテストまで残るため（Issue #1164）。
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, TIMEOUT);
afterAll(async () => {
  await browser?.close();
});

describe("withContext", () => {
  it(
    "use が reject しても、その例外をそのまま投げ、context を閉じる",
    async () => {
      let captured: BrowserContext | undefined;
      await expect(
        withContext(browser, { viewport: PAGE_VIEWPORT }, async (context) => {
          captured = context;
          throw new Error("use の失敗");
        }),
      ).rejects.toThrow("use の失敗");
      // 閉じた context では、もうページを開けない
      await expect(captured!.newPage()).rejects.toThrow();
    },
    TIMEOUT,
  );
});
