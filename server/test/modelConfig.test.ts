import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import { resolveModelCandidate } from "../src/modelConfig.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";

describe("check のモデル候補解決", () => {
  it.effect.each([
    { env: undefined, route: "apple" },
    { env: "remote", route: "claude" },
  ] as const)("環境モデル $env と設定 default から $route を選び、Apple を起動しない", ({ env, route }) => Effect.gen(function* () {
    const fs = FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify({ default: "apple", models: { remote: { route: "claude", model: "synthetic-model" } } })) });
    const selected = yield* resolveModelCandidate({}).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(Layer.mergeAll(unusedApple, ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/synthetic", ...(env === undefined ? {} : { LIVE_MINDMAP_MODEL: env }) })))),
    );
    expect(selected.route).toBe(route);
  }));

  it.effect("不明なモデルの候補解決は失敗する", () => Effect.gen(function* () {
    const result = yield* Effect.result(resolveModelCandidate({ model: "absent" }).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: () => Effect.succeed("{}") })),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/synthetic" }))),
    ));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ModelRefused" } });
  }));
});

describe("check のモデル候補解決と判定の設定", () => {
  it.effect("設定に judges・judge があっても check のモデル候補解決は断られない", () => Effect.gen(function* () {
    const fs = FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify({ judge: "off", judges: { x: { route: "system-one", apiKeyEnv: "X" } } })) });
    const selected = yield* resolveModelCandidate({}).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(Layer.mergeAll(unusedApple, ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/synthetic" })))),
    );
    expect(selected.route).toBe("claude");
  }));
});
