import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Result, Stream } from "effect";
import { Helpers, HelperInstallFailure } from "../src/helpers.ts";
import { InstallDeps } from "../src/installDeps.ts";
import { ManagedDeps } from "../src/managedDeps.ts";
import { readyHelperChecks } from "./fixtures/helperCheck.ts";

const service = (installSpeechJa: Helpers["Service"]["installSpeechJa"]) => InstallDeps.pipe(Effect.provide(InstallDeps.layer.pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(Helpers, Helpers.of({ ...readyHelperChecks, installSpeechJa, apps: Effect.die("対象外"), launch: () => Effect.die("対象外") })),
  Layer.succeed(ManagedDeps, ManagedDeps.of({
    check: () => Effect.die("導入は管理依存を確認しない"), load: () => Effect.die("導入はSDKを読み込まない"),
    update: () => Stream.die("更新は対象外"),
    install: (names) => {
      expect(names).toEqual(["claude"]);
      return Stream.fromIterable([
        { type: "progress" as const, message: "SDK取得中" },
        { type: "result" as const, items: [{ name: "claude" as const, need: "optional" as const, state: "ready" as const }] },
      ]);
    },
  })),
)))));

describe("依存導入の調整", () => {
  it.effect("710-4: 混在要求の進捗を保持し、最後に対象だけの結果を1件返す", () => Effect.gen(function* () {
    const deps = yield* service(Stream.succeed("モデル取得中"));
    expect(yield* Stream.runCollect(deps.install(["claude", "speech-ja"]))).toEqual([
      { type: "progress", message: "SDK取得中" },
      { type: "progress", message: "モデル取得中" },
      { type: "result", items: [
        { name: "claude", need: "optional", state: "ready" },
        { name: "speech-ja", need: "required", state: "ready", install: "pnpm cli install speech-ja" },
      ] },
    ]);
  }));

  it.effect("710-4: 管理依存だけの導入はHelpersを呼ばず進捗と結果を保持する", () => Effect.gen(function* () {
    const deps = yield* service(Stream.die("管理依存だけならモデル導入はしない"));
    expect(yield* Stream.runCollect(deps.install(["claude"]))).toEqual([
      { type: "progress", message: "SDK取得中" },
      { type: "result", items: [{ name: "claude", need: "optional", state: "ready" }] },
    ]);
  }));

  it.effect("710-4: 失敗の後片付け中も競合を拒否し、後片付け終了後に再試行できる", () => Effect.gen(function* () {
    const cleaning = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    let attempts = 0;
    const installing = Stream.unwrap(Effect.sync(() => ++attempts === 1
      ? Stream.fail(new HelperInstallFailure({ message: "取得失敗" })).pipe(Stream.ensuring(Effect.gen(function* () {
        yield* Deferred.succeed(cleaning, undefined);
        yield* Deferred.await(released);
      })))
      : Stream.succeed("取得完了")));
    const deps = yield* service(installing);
    const first = yield* Effect.forkChild(Effect.result(Stream.runDrain(deps.install(["speech-ja"]))));
    yield* Deferred.await(cleaning);
    const competitor = yield* Effect.result(Stream.runDrain(deps.install(["speech-ja"])));
    expect(Result.isFailure(competitor)).toBe(true);
    if (Result.isFailure(competitor)) expect(competitor.failure.message).toBe("導入中です");
    expect(attempts).toBe(1);
    yield* Deferred.succeed(released, undefined);
    expect(Result.isFailure(yield* Fiber.join(first))).toBe(true);
    yield* Stream.runDrain(deps.install(["speech-ja"]));
    expect(attempts).toBe(2);
  }));
});
