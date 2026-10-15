import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import { modelChosenByUser, resolveJudge, resolveModelCandidate } from "../src/modelConfig.ts";
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

describe("差分更新のモデルを利用者が名指ししたか（判定で振り分けない条件）", () => {
  const chosen = (flags: { model?: string }, env: Record<string, string>, config: unknown) =>
    modelChosenByUser(flags).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify(config)) })),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/synthetic", ...env }))),
    );

  it.effect("何も指定しなければ false。--model claude・LIVE_MINDMAP_MODEL・設定の default は、組み込みと同じ名前でも true", () => Effect.gen(function* () {
    expect(yield* chosen({}, {}, {})).toBe(false);
    expect(yield* chosen({ model: "claude" }, {}, {})).toBe(true);
    expect(yield* chosen({}, { LIVE_MINDMAP_MODEL: "claude" }, {})).toBe(true);
    expect(yield* chosen({}, {}, { default: "claude" })).toBe(true);
  }));
});

describe("判定のモデルの解決（Issue #983）", () => {
  const run = (flags: { judge?: string }, local: boolean, env: Record<string, string>, config: unknown) =>
    Effect.result(resolveJudge(flags, local).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify(config)) })),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/synthetic", ...env }))),
    ));

  it.effect("既定では環境変数の鍵があれば jev を選ぶ", () => Effect.gen(function* () {
    const result = yield* run({}, false, { TYPESAFE_AI_API_KEY: "synthetic-key" }, {});
    expect(result).toMatchObject({ _tag: "Success", success: { judge: { name: "jev", route: "system-one", timeoutMs: 1000 } } });
  }));

  it.effect("LIVE_MINDMAP_JUDGE は設定の judge に勝ち、--judge は LIVE_MINDMAP_JUDGE に勝つ", () => Effect.gen(function* () {
    const config = { judge: "a", judges: {
      a: { route: "system-one", apiKeyEnv: "A_KEY" }, b: { route: "system-one", apiKeyEnv: "B_KEY" }, c: { route: "system-one", apiKeyEnv: "C_KEY" },
    } };
    const env = { A_KEY: "a", B_KEY: "b", C_KEY: "c" };
    expect(yield* run({}, false, env, config)).toMatchObject({ _tag: "Success", success: { judge: { name: "a" } } });
    expect(yield* run({}, false, { ...env, LIVE_MINDMAP_JUDGE: "b" }, config)).toMatchObject({ _tag: "Success", success: { judge: { name: "b" } } });
    expect(yield* run({ judge: "c" }, false, { ...env, LIVE_MINDMAP_JUDGE: "b" }, config)).toMatchObject({ _tag: "Success", success: { judge: { name: "c" } } });
  }));

  it.effect("鍵の環境変数が無いか空なら失敗せず、1 行の知らせとともに判定なしになる", () => Effect.gen(function* () {
    for (const env of [{}, { TYPESAFE_AI_API_KEY: "" }, { TYPESAFE_AI_API_KEY: "  " }] as ReadonlyArray<Record<string, string>>) {
      const result = yield* run({}, false, env, {});
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") continue;
      expect(result.success.judge).toBeUndefined();
      expect(result.success.notice).toContain("TYPESAFE_AI_API_KEY");
      expect(result.success.notice).not.toMatch(/[\r\n]/);
    }
  }));

  it.effect("off は鍵があっても判定なし", () => Effect.gen(function* () {
    const result = yield* run({ judge: "off" }, false, { TYPESAFE_AI_API_KEY: "k" }, {});
    expect(result).toMatchObject({ _tag: "Success", success: { judge: undefined } });
  }));

  it.effect("ローカルモードで LIVE_MINDMAP_JUDGE を明示すると ModelRefused で断り、明示しなければ判定なしで始まる", () => Effect.gen(function* () {
    const env = { TYPESAFE_AI_API_KEY: "k" };
    expect(yield* run({}, true, { ...env, LIVE_MINDMAP_JUDGE: "jev" }, {})).toMatchObject({ _tag: "Failure", failure: { _tag: "ModelRefused" } });
    expect(yield* run({}, true, env, {})).toMatchObject({ _tag: "Success", success: { judge: undefined } });
  }));

  it.effect("知らない名前・judges の書き誤りは ModelRefused で断る", () => Effect.gen(function* () {
    expect(yield* run({ judge: "missing" }, false, {}, {})).toMatchObject({ _tag: "Failure", failure: { _tag: "ModelRefused" } });
    expect(yield* run({}, false, {}, { judges: { bad: { route: "claude" } } })).toMatchObject({ _tag: "Failure", failure: { _tag: "ModelRefused" } });
  }));

  it.effect("設定に judges・judge があっても check のモデル候補解決は断られない", () => Effect.gen(function* () {
    const fs = FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify({ judge: "off", judges: { x: { route: "system-one", apiKeyEnv: "X" } } })) });
    const selected = yield* resolveModelCandidate({}).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(Layer.mergeAll(unusedApple, ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/synthetic" })))),
    );
    expect(selected.route).toBe("claude");
  }));
});
