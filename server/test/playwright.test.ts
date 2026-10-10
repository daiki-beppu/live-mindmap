import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Stream } from "effect";
import type { Browser } from "playwright-core";
import type * as PlaywrightModule from "playwright-core";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import { Playwright } from "../src/playwright.ts";

describe("Playwright の管理依存", () => {
  it.effect("Layer 構築は読み込まず、各起動で現在の管理モジュールを使う", () => Effect.gen(function* () {
    const first = { version: () => "a" } as Browser;
    const second = { version: () => "b" } as Browser;
    let browser = first;
    const deps = ManagedDeps.of({
      check: () => Effect.die("check は呼ばない"),
      install: () => Stream.die("install は呼ばない"),
      load: () => Effect.sync(() => ({
        chromium: { launch: async () => browser },
      } as typeof PlaywrightModule)),
    });
    yield* Effect.gen(function* () {
      const service = yield* Playwright;
      expect((yield* service.launch()).version()).toBe("a");
      browser = second;
      expect((yield* service.launch()).version()).toBe("b");
    }).pipe(Effect.provide(Playwright.layer.pipe(Layer.provide(Layer.succeed(ManagedDeps, deps)))));
  }));

  it.effect("Chromium の起動例外を ManagedDepsFailed として返す", () => Effect.gen(function* () {
    const deps = ManagedDeps.of({
      check: () => Effect.die("check は呼ばない"),
      install: () => Stream.die("install は呼ばない"),
      load: () => Effect.succeed({
        chromium: { launch: async (): Promise<Browser> => { throw new Error("launch failed"); } },
      } as typeof PlaywrightModule),
    });
    yield* Effect.gen(function* () {
      const result = yield* Effect.result((yield* Playwright).launch());
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ManagedDepsFailed);
        expect(result.failure.message).toContain("launch failed");
      }
    }).pipe(Effect.provide(Playwright.layer.pipe(Layer.provide(Layer.succeed(ManagedDeps, deps)))));
  }));

  it.effect("未導入でも構築でき、起動時に管理依存の失敗を返す", () => Effect.gen(function* () {
    const error = new ManagedDepsFailed({ message: "未導入" });
    const deps = ManagedDeps.of({
      check: () => Effect.die("check は呼ばない"),
      install: () => Stream.die("install は呼ばない"),
      load: () => Effect.fail(error),
    });
    yield* Effect.gen(function* () {
      const service = yield* Playwright;
      const result = yield* Effect.result(service.launch());
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toBe("未導入");
    }).pipe(Effect.provide(Playwright.layer.pipe(Layer.provide(Layer.succeed(ManagedDeps, deps)))));
  }));
});
