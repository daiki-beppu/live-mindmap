import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import { defaultClaude, type ExecutableModel } from "../src/modelSelection.ts";
import type { JudgeModel } from "../src/judgeSelection.ts";
import { acceptPlan, needsTransferToken, planBody, planModel, resolvePlan, type UpdatePlan } from "../src/updatePlan.ts";
import { availableApple } from "./fixtures/appleIntelligence.ts";

// 更新の計画の規則（単一モデルか振り分けか、server が受けてよい本文、転送用トークンの要否）。
// 鍵の有無は resolvePlan では見ない。鍵と知らせは planLayer（judgeRouting.test.ts）が所有する。
const jev: JudgeModel = { name: "jev", route: "system-one", apiKeyEnv: "TYPESAFE_AI_API_KEY", timeoutMs: 1000 };
const compat: ExecutableModel = { name: "local-llm", route: "openai-compatible", model: "synthetic-model", url: "http://127.0.0.1:11434/v1", local: false };
const chatgpt: ExecutableModel = { name: "gpt", route: "chatgpt", model: "synthetic-gpt", local: false };
const apple: ExecutableModel = { name: "apple", route: "apple", local: true };

describe("resolvePlan: 振り分けるかを 1 回だけ決める", () => {
  type Flags = { model?: string; judge?: string; local?: boolean };
  const resolve = (flags: Flags, env: Record<string, string> = {}, config: unknown = {}) =>
    Effect.result(resolvePlan(flags).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify(config)) })),
      Effect.provide(Layer.mergeAll(availableApple, ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/synthetic", ...env })))),
    ));
  const plan = Effect.fnUntraced(function* (flags: Flags, env?: Record<string, string>, config?: unknown) {
    const result = yield* resolve(flags, env, config);
    if (result._tag !== "Success") throw new Error(`計画が作れません: ${JSON.stringify(result.failure)}`);
    return result.success;
  });
  const refused = (result: unknown) =>
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ModelRefused" } });

  it.effect("何も指定しなければ jev で routed になる。鍵が環境に無くても single にしない", () => Effect.gen(function* () {
    expect(yield* plan({})).toMatchObject({ kind: "routed", judge: { name: "jev", route: "system-one", timeoutMs: 1000 } });
    expect(yield* plan({}, { TYPESAFE_AI_API_KEY: "synthetic-key" })).toMatchObject({ kind: "routed", judge: { name: "jev" } });
    expect(yield* plan({}, { TYPESAFE_AI_API_KEY: "" })).toMatchObject({ kind: "routed" });
  }));

  it.effect("差分更新のモデルを名指ししたら、組み込みと同じ名前でも single になる（--model・LIVE_MINDMAP_MODEL・設定の default）", () => Effect.gen(function* () {
    expect(yield* plan({ model: "claude" })).toEqual({ kind: "single", model: defaultClaude });
    expect(yield* plan({}, { LIVE_MINDMAP_MODEL: "claude" })).toEqual({ kind: "single", model: defaultClaude });
    expect(yield* plan({}, {}, { default: "claude" })).toEqual({ kind: "single", model: defaultClaude });
  }));

  it.effect("名指ししたモデルは claude 以外でも single で、そのモデルを持つ", () => Effect.gen(function* () {
    const config = { models: { "local-llm": { route: "openai-compatible", model: "synthetic-model", url: "http://127.0.0.1:11434/v1" } } };
    expect(yield* plan({ model: "local-llm" }, {}, config)).toEqual({ kind: "single", model: compat });
    expect(yield* plan({}, {}, { ...config, default: "local-llm" })).toEqual({ kind: "single", model: compat });
  }));

  it.effect("設定で claude の中身を替えていたら、名指ししなくても single で、替えたモデルを持つ", () => Effect.gen(function* () {
    for (const override of [{ model: "claude-haiku-5-5" }, { model: "claude-sonnet-5-5", maxTokens: 100 }, { model: "claude-sonnet-5-5", images: true }, { model: "claude-sonnet-5-5", extraBody: { a: 1 } }]) {
      const result = yield* plan({}, {}, { models: { claude: { route: "claude", ...override } } });
      expect(result).toMatchObject({ kind: "single", model: { name: "claude", route: "claude", ...override } });
    }
  }));

  it.effect("判定が off なら single（--judge・LIVE_MINDMAP_JUDGE・設定の judge のどれでも）", () => Effect.gen(function* () {
    expect(yield* plan({ judge: "off" })).toEqual({ kind: "single", model: defaultClaude });
    expect(yield* plan({}, { LIVE_MINDMAP_JUDGE: "off" })).toEqual({ kind: "single", model: defaultClaude });
    expect(yield* plan({}, {}, { judge: "off" })).toEqual({ kind: "single", model: defaultClaude });
  }));

  it.effect("判定のモデルは --judge → LIVE_MINDMAP_JUDGE → 設定の judge → jev の順で選ばれる", () => Effect.gen(function* () {
    const config = { judge: "a", judges: {
      a: { route: "system-one", apiKeyEnv: "A_KEY" }, b: { route: "system-one", apiKeyEnv: "B_KEY" }, c: { route: "system-one", apiKeyEnv: "C_KEY" },
    } };
    expect(yield* plan({}, {}, config)).toMatchObject({ kind: "routed", judge: { name: "a" } });
    expect(yield* plan({}, { LIVE_MINDMAP_JUDGE: "b" }, config)).toMatchObject({ kind: "routed", judge: { name: "b" } });
    expect(yield* plan({ judge: "c" }, { LIVE_MINDMAP_JUDGE: "b" }, config)).toMatchObject({ kind: "routed", judge: { name: "c" } });
    expect(yield* plan({}, {}, { judges: config.judges })).toMatchObject({ kind: "routed", judge: { name: "jev" } });
  }));

  it.effect("clef は Cloudflare の 2 つの環境変数名と 2 秒の時間切れを持つ judge で routed になる", () => Effect.gen(function* () {
    expect(yield* plan({ judge: "clef-flash" })).toMatchObject({
      kind: "routed", judge: { name: "clef-flash", model: "clef-flash", apiKeyEnv: "CLOUDFLARE_API_TOKEN", accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", timeoutMs: 2000 },
    });
  }));

  it.effect("ローカルモードでは routed を作らない。判定を明示しなければ断らず、判定なしの single（apple）になる", () => Effect.gen(function* () {
    expect(yield* plan({ local: true })).toEqual({ kind: "single", model: apple });
    expect(yield* plan({ local: true }, { TYPESAFE_AI_API_KEY: "synthetic-key" })).toEqual({ kind: "single", model: apple });
    expect(yield* plan({ model: "apple" })).toEqual({ kind: "single", model: apple });
    expect(yield* plan({}, {}, { default: "apple" })).toEqual({ kind: "single", model: apple });
  }));

  it.effect("ローカルモードでクラウドの判定を明示したら ModelRefused で断る（--judge・LIVE_MINDMAP_JUDGE・設定の judge）", () => Effect.gen(function* () {
    refused(yield* resolve({ local: true, judge: "jev" }));
    refused(yield* resolve({ local: true }, { LIVE_MINDMAP_JUDGE: "jev" }));
    refused(yield* resolve({ local: true }, {}, { judge: "jev" }));
    refused(yield* resolve({ model: "apple", judge: "clef" }));
  }));

  it.effect("ローカルモードで off を明示しても断らない（single のまま）", () => Effect.gen(function* () {
    expect(yield* plan({ local: true, judge: "off" })).toEqual({ kind: "single", model: apple });
    expect(yield* plan({ local: true }, { LIVE_MINDMAP_JUDGE: "off" })).toEqual({ kind: "single", model: apple });
  }));

  it.effect("名指ししたときも判定の誤りは断る（知らない判定・judges の書き誤り）", () => Effect.gen(function* () {
    refused(yield* resolve({ model: "claude", judge: "missing" }));
    refused(yield* resolve({}, { LIVE_MINDMAP_MODEL: "claude" }, { judges: { bad: { route: "claude" } } }));
    refused(yield* resolve({ judge: "missing" }));
  }));

  it.effect("モデルの誤りも断る（知らないモデル）。モデルと判定の両方が誤りなら、モデルの断りが先に返る", () => Effect.gen(function* () {
    refused(yield* resolve({ model: "absent" }));
    const both = yield* resolve({ model: "absent", judge: "missing" });
    refused(both);
    expect(both._tag === "Failure" ? both.failure.message : "").toContain("absent");
  }));
});

describe("acceptPlan: server は送られてきた本文を検めるだけ", () => {
  it("model も judge も無ければ、組み込みの claude の single として受ける", () => {
    expect(acceptPlan({})).toEqual({ ok: true, plan: { kind: "single", model: defaultClaude } });
  });

  it("judge が無ければ、model を受けた single になる（compat・chatgpt・apple・claude）", () => {
    for (const model of [compat, chatgpt, apple, defaultClaude, { ...defaultClaude, model: "claude-haiku-5-5" }]) {
      expect(acceptPlan({ model })).toEqual({ ok: true, plan: { kind: "single", model } });
    }
  });

  it("judge があり、model が省略か組み込みの claude なら routed として受ける", () => {
    expect(acceptPlan({ judge: jev })).toEqual({ ok: true, plan: { kind: "routed", judge: jev } });
    expect(acceptPlan({ model: defaultClaude, judge: jev })).toEqual({ ok: true, plan: { kind: "routed", judge: jev } });
  });

  it("手で組んだローカルモードの routed（apple と judge）を断る", () => {
    const result = acceptPlan({ model: apple, judge: jev });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.lines.length).toBeGreaterThan(0);
  });

  it("judge と組み込み以外のモデルの組み合わせは、知らせずに single へ読み替えず断る", () => {
    for (const model of [compat, chatgpt, { ...defaultClaude, model: "claude-haiku-5-5" }, { ...defaultClaude, maxTokens: 10 }, { ...defaultClaude, name: "mine" }]) {
      expect(acceptPlan({ model, judge: jev }).ok).toBe(false);
    }
  });

  it("モデル自体が受けられない本文は judge の有無にかかわらず断る（ローカルモードの claude）", () => {
    expect(acceptPlan({ model: { ...defaultClaude, local: true } }).ok).toBe(false);
    expect(acceptPlan({ model: { ...defaultClaude, local: true }, judge: jev }).ok).toBe(false);
  });

  it("受けた routed の judge は、送られてきた値のまま持つ（accountIdEnv も落とさない）", () => {
    const clef: JudgeModel = { name: "clef", route: "system-one", apiKeyEnv: "CLOUDFLARE_API_TOKEN", accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", model: "clef", timeoutMs: 2000 };
    expect(acceptPlan({ judge: clef })).toEqual({ ok: true, plan: { kind: "routed", judge: clef } });
  });
});

describe("planBody / planModel: 計画と HTTP の本文の往復（本文の形は変えない）", () => {
  const plans: readonly UpdatePlan[] = [
    { kind: "single", model: defaultClaude }, { kind: "single", model: compat }, { kind: "single", model: chatgpt }, { kind: "single", model: apple },
    { kind: "routed", judge: jev },
  ];

  it("single の本文は model だけ。routed の本文は組み込みの claude の model と judge", () => {
    expect(planBody({ kind: "single", model: compat })).toEqual({ model: compat });
    expect(planBody({ kind: "routed", judge: jev })).toEqual({ model: defaultClaude, judge: jev });
    expect(planBody({ kind: "single", model: compat })).not.toHaveProperty("judge");
  });

  it("planModel は single ならそのモデル、routed なら組み込みの claude", () => {
    expect(planModel({ kind: "single", model: chatgpt })).toEqual(chatgpt);
    expect(planModel({ kind: "routed", judge: jev })).toEqual(defaultClaude);
  });

  it("acceptPlan(planBody(plan)) は plan に戻る", () => {
    for (const plan of plans) expect(acceptPlan(planBody(plan))).toEqual({ ok: true, plan });
  });
});

describe("needsTransferToken: 転送用トークンの規則は 1 つ", () => {
  it("single は openai-compatible と chatgpt のときだけ要る。claude と apple は要らない", () => {
    expect(needsTransferToken({ kind: "single", model: compat })).toBe(true);
    expect(needsTransferToken({ kind: "single", model: chatgpt })).toBe(true);
    expect(needsTransferToken({ kind: "single", model: defaultClaude })).toBe(false);
    expect(needsTransferToken({ kind: "single", model: { ...defaultClaude, model: "claude-haiku-5-5" } })).toBe(false);
    expect(needsTransferToken({ kind: "single", model: apple })).toBe(false);
  });

  it("routed は常に要る（判定は環境変数の鍵を本文で指定できる宛先へ送るため）", () => {
    expect(needsTransferToken({ kind: "routed", judge: jev })).toBe(true);
  });
});
