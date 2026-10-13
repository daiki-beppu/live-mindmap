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
      executable: () => Effect.die("実行ファイル取得は対象外"),
      check: () => Effect.die("check は呼ばない"),
      update: () => Stream.die("更新は対象外"), install: () => Stream.die("install は呼ばない"),
      load: (() => Effect.sync(() => ({
        chromium: { launch: async () => browser },
      } as typeof PlaywrightModule))) as ManagedDeps["Service"]["load"],
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
      executable: () => Effect.die("実行ファイル取得は対象外"),
      check: () => Effect.die("check は呼ばない"),
      update: () => Stream.die("更新は対象外"), install: () => Stream.die("install は呼ばない"),
      load: (() => Effect.succeed({
        chromium: { launch: async (): Promise<Browser> => { throw new Error("launch failed"); } },
      } as typeof PlaywrightModule)) as ManagedDeps["Service"]["load"],
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

  // 入っていないときだけ入れ方を示す。入っているのに読めないときに「入れて」と言わない（2026-10-13、#968 の読み込みの失敗で起きた）
  it.effect.each([
    { state: "missing", expected: "ChromiumMissing" },
    { state: "ready", expected: "ManagedDepsFailed" },
  ] as const)("読み込みに失敗したとき、導入の状態が $state なら $expected を返す", ({ state, expected }) => Effect.gen(function* () {
    const error = new ManagedDepsFailed({ message: "読めない" });
    const deps = ManagedDeps.of({
      executable: () => Effect.die("実行ファイル取得は対象外"),
      check: () => Effect.succeed([{ name: "chromium", need: "optional", state }]),
      update: () => Stream.die("更新は対象外"), install: () => Stream.die("install は呼ばない"),
      load: () => Effect.fail(error),
    });
    yield* Effect.gen(function* () {
      const service = yield* Playwright;
      const result = yield* Effect.result(service.launch());
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe(expected);
        if (expected === "ManagedDepsFailed") expect(result.failure).toBe(error);
        else expect(result.failure.message).toContain("pnpm cli install chromium");
      }
    }).pipe(Effect.provide(Playwright.layer.pipe(Layer.provide(Layer.succeed(ManagedDeps, deps)))));
  }));
});
