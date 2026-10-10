import { Context, Layer } from "effect";
import { chromium } from "playwright";

// Chromium の起動。テストでは偽物の Layer に替える
export class Playwright extends Context.Service<Playwright, {
  readonly launch: typeof chromium.launch;
}>()("live-mindmap/server/Playwright") {
  static readonly layer = Layer.succeed(Playwright, Playwright.of({ launch: (options) => chromium.launch(options) }));
}
