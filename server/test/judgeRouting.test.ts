import { defaultClaude, type ExecutableModel } from "../src/modelSelection.ts";
import { it as effectIt } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Stream } from "effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { expect, vi } from "vitest";
import { planLayer, type UpdatePlan } from "../src/updatePlan.ts";
import { DiffUpdater, emptyMap } from "../src/core/index.ts";
import { ManagedDeps } from "../src/managedDeps.ts";
import type { AgentSdk } from "../src/claude.ts";
import type { JudgeModel } from "../src/judgeSelection.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: () => { throw new Error("通常依存の SDK を呼びました"); } }));

const judge: JudgeModel = { name: "jev", route: "system-one", apiKeyEnv: "TYPESAFE_AI_API_KEY", url: "http://judge.invalid/systemone", timeoutMs: 1000 };
type Claude = Extract<ExecutableModel, { route: "claude" }>;

const fakeSdk = () => {
  const models: string[] = [];
  const prompts: { model: string; text: string }[] = [];
  const options: { model: string; effort: unknown }[] = [];
  const query = vi.fn((params: { prompt: AsyncIterable<unknown>; options: { model: string; effort?: unknown } }) => {
    models.push(params.options.model);
    options.push({ model: params.options.model, effort: params.options.effort });
    const gen = (async function* () {
      for await (const message of params.prompt) {
        const content = (message as { message: { content: unknown } }).message.content;
        prompts.push({ model: params.options.model, text: typeof content === "string" ? content : JSON.stringify(content) });
        yield { type: "result", subtype: "success", structured_output: { ops: [{ op: "noop", reason: "偽の応答" }] },
          usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } };
      }
    })();
    return Object.assign(gen, { close: () => {} });
  }) as unknown as AgentSdk["Service"]["query"];
  const deps = Layer.succeed(ManagedDeps, ManagedDeps.of({
    executable: () => Effect.die("実行ファイル取得は対象外"),
    check: () => Effect.die("状態確認は対象外"), update: () => Stream.die("更新は対象外"), install: () => Stream.die("導入は対象外"),
    load: (() => Effect.succeed({ query })) as unknown as ManagedDeps["Service"]["load"],
  }));
  return { models, prompts, options, deps };
};

const fakeJudgeHttp = (script: number | readonly number[]) => {
  let n = 0;
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const client = HttpClient.make((request) => Effect.sync(() => {
    requests.push(request);
    const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : { questions: { route: {} } };
    const name = Object.keys(body.questions)[0]!;
    return HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ answers: { [name]: { type: "noul", noul: typeof script === "number" ? script : script[n++]! } } }), { status: 200, headers: { "content-type": "application/json" } }));
  }));
  return { requests, client };
};

const single = (model: ExecutableModel): UpdatePlan => ({ kind: "single", model });
const routed = (judgeModel: JudgeModel): UpdatePlan => ({ kind: "routed", judge: judgeModel });
const keyNotice = (name: string, vars: string) => `判定のモデル ${name} の鍵がありません（環境変数 ${vars}）。判定なしで始めます`;

const run = Effect.fnUntraced(function* (plan: UpdatePlan, p: number, env: Record<string, string> = { TYPESAFE_AI_API_KEY: "synthetic-key" }) {
  const sdk = fakeSdk();
  const http = fakeJudgeHttp(p);
  const { layer, notice } = yield* planLayer(plan).pipe(Effect.provide(Layer.mergeAll(
    sdk.deps, unusedApple, Layer.succeed(HttpClient.HttpClient, http.client),
    Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
  )));
  const result = yield* Effect.gen(function* () {
    const updater = yield* DiffUpdater;
    return yield* updater.update({ map: emptyMap("定例"), recent: [], fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "来週までにやります" }] });
  }).pipe(Effect.provide(layer));
  return { result, notice, models: sdk.models, judgeCalls: http.requests };
});

effectIt.effect("routed で、確からしさが 0.3 以上なら Sonnet 5.5 の query で差分更新する", () => Effect.gen(function* () {
  const { models, judgeCalls, result, notice } = yield* run(routed(judge), 0.9);
  expect(judgeCalls).toHaveLength(1);
  expect(judgeCalls[0]!.url).toBe("http://judge.invalid/systemone");
  expect(models).toEqual(["claude-sonnet-5-5"]);
  expect(result.judge).toMatchObject({ model: "claude-sonnet-5-5", confidence: 0.9 });
  expect(notice).toBeUndefined();
}).pipe(Effect.scoped));

effectIt.effect("確からしさが 0.3 未満なら Haiku 5.5 の query で差分更新し、Sonnet の query は開かない", () => Effect.gen(function* () {
  const { models, judgeCalls, result, notice } = yield* run(routed(judge), 0.1);
  expect(judgeCalls).toHaveLength(1);
  expect(models).toEqual(["claude-haiku-5-5"]);
  expect(result.judge).toMatchObject({ model: "claude-haiku-5-5", confidence: 0.1 });
  expect(notice).toBeUndefined();
}).pipe(Effect.scoped));

const untouched = (title: string, plan: UpdatePlan, expectedModel: string, expectedNotice: string | undefined, env?: Record<string, string>) =>
  effectIt.effect(title, () => Effect.gen(function* () {
    const { models, judgeCalls, result, notice } = yield* run(plan, 0.1, env);
    expect(judgeCalls).toHaveLength(0);
    expect(models).toEqual([expectedModel]);
    expect(result).not.toHaveProperty("judge");
    expect(notice).toBe(expectedNotice);
    if (notice !== undefined) expect(notice).not.toMatch(/[\r\n]/);
  }).pipe(Effect.scoped));

untouched("single(claude) では鍵があっても判定を呼ばず、知らせも返さず Sonnet 5.5 だけを使う", single(defaultClaude), "claude-sonnet-5-5", undefined);
untouched("routed で鍵が空なら判定を呼ばず、断りもせず、1 行の知らせとともに Sonnet 5.5 だけを使う", routed(judge), "claude-sonnet-5-5", keyNotice("jev", "TYPESAFE_AI_API_KEY"), { TYPESAFE_AI_API_KEY: "" });
untouched("routed で鍵が空白だけでも同じ知らせとともに Sonnet 5.5 だけを使う", routed(judge), "claude-sonnet-5-5", keyNotice("jev", "TYPESAFE_AI_API_KEY"), { TYPESAFE_AI_API_KEY: "  " });
untouched("routed で鍵の環境変数が無いときも判定を呼ばず、1 行の知らせとともに Sonnet 5.5 だけを使う", routed(judge), "claude-sonnet-5-5", keyNotice("jev", "TYPESAFE_AI_API_KEY"), {});

const userChosen: readonly [string, Claude][] = [
  ["設定で models.claude を Haiku に替えたモデル", { ...defaultClaude, model: "claude-haiku-5-5" }],
  ["設定で models.claude を別の Claude に替えたモデル", { ...defaultClaude, model: "claude-opus-5" }],
  ["別名のモデル（route は claude）", { name: "fast", route: "claude", model: "claude-haiku-5-5", local: false }],
  ["別名でモデルが Sonnet のモデル", { name: "mine", route: "claude", model: "claude-sonnet-5-5", local: false }],
];
for (const [label, model] of userChosen) {
  untouched(`single で利用者が選んだモデル（${label}）では判定を呼ばず、知らせも返さず、選んだモデルだけを使う`, single(model), model.model, undefined);
}

effectIt.effect("振り分けの 2 本の query は、それぞれ自分の前回送ったマップからの変更だけを受け取る", () => Effect.gen(function* () {
  const sdk = fakeSdk();
  const http = fakeJudgeHttp([0.9, 0.1, 0.9, 0.1]);
  const { layer } = yield* planLayer(routed(judge)).pipe(Effect.provide(Layer.mergeAll(
    sdk.deps, unusedApple, Layer.succeed(HttpClient.HttpClient, http.client),
    Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TYPESAFE_AI_API_KEY: "synthetic-key" })),
  )));
  const withPoints = (...texts: string[]) => {
    const map = emptyMap("定例");
    return {
      ...map,
      nodes: { ...map.nodes, ...Object.fromEntries(texts.map((text, i) => [`p${i}`, { id: `p${i}`, parent: "root", kind: "論点", text, evidence: [] }])) },
      order: [...map.order, ...texts.map((_, i) => `p${i}`)],
    } as ReturnType<typeof emptyMap>;
  };
  const maps = [withPoints("AAA"), withPoints("AAA", "BBB"), withPoints("AAA", "BBB", "CCC"), withPoints("AAA", "BBB", "CCC", "DDD")];
  yield* Effect.gen(function* () {
    const updater = yield* DiffUpdater;
    for (const [i, map] of maps.entries()) {
      yield* updater.update({ map, recent: [], fresh: [{ id: `r${i}`, track: "相手", start: i, end: i + 1, text: `発言${i}` }] });
    }
  }).pipe(Effect.provide(layer));
  expect(sdk.prompts.map((p) => p.model)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  const section = (text: string) => text.split("## 直前の発言")[0]!.split("## 前回からのマップの変更")[1] ?? "";
  const [s1, h1, s2, h2] = sdk.prompts.map((p) => p.text) as [string, string, string, string];
  expect(s1).toContain("## 現在のマップ");
  expect(h1).toContain("## 現在のマップ");
  expect(s2).toContain("## 前回からのマップの変更");
  expect(section(s2)).toContain("BBB");
  expect(section(s2)).toContain("CCC");
  expect(section(s2)).not.toContain("AAA");
  expect(h2).toContain("## 前回からのマップの変更");
  expect(section(h2)).toContain("CCC");
  expect(section(h2)).toContain("DDD");
  expect(section(h2)).not.toContain("BBB");
}).pipe(Effect.scoped));

effectIt.effect("振り分けの Haiku の query は effort low、Sonnet の query は effort medium で開く", () => Effect.gen(function* () {
  const sdk = fakeSdk();
  const http = fakeJudgeHttp([0.9, 0.1]);
  const { layer } = yield* planLayer(routed(judge)).pipe(Effect.provide(Layer.mergeAll(
    sdk.deps, unusedApple, Layer.succeed(HttpClient.HttpClient, http.client),
    Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TYPESAFE_AI_API_KEY: "synthetic-key" })),
  )));
  yield* Effect.gen(function* () {
    const updater = yield* DiffUpdater;
    for (const i of [0, 1]) {
      yield* updater.update({ map: emptyMap("定例"), recent: [], fresh: [{ id: `r${i}`, track: "相手", start: i, end: i + 1, text: `発言${i}` }] });
    }
  }).pipe(Effect.provide(layer));
  const [sonnet, haiku] = sdk.options as [(typeof sdk.options)[number], (typeof sdk.options)[number]];
  expect(sonnet).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium" });
  expect(haiku).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
}).pipe(Effect.scoped));

const clefJudge: JudgeModel = { name: "clef-flash", route: "system-one", apiKeyEnv: "CLOUDFLARE_API_TOKEN", accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", model: "clef-flash", timeoutMs: 2000 };

effectIt.effect("Cloudflare の鍵が 2 つそろっていると、Workers AI の宛先・Bearer・モデル名で判定を呼ぶ", () => Effect.gen(function* () {
  const { models, judgeCalls, result, notice } = yield* run(routed(clefJudge), 0.1, { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acct-123" });
  expect(judgeCalls).toHaveLength(1);
  expect(judgeCalls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/cloudflare/clef-flash");
  expect(judgeCalls[0]!.headers.authorization).toBe("Bearer cf-token");
  expect(models).toEqual(["claude-haiku-5-5"]);
  expect(result.judge).toMatchObject({ model: "claude-haiku-5-5", confidence: 0.1 });
  expect(notice).toBeUndefined();
}).pipe(Effect.scoped));

untouched("Cloudflare のアカウント ID だけが無いと判定を呼ばず、欠けた名前の知らせとともに Sonnet 5.5 だけを使う", routed(clefJudge), "claude-sonnet-5-5", keyNotice("clef-flash", "CLOUDFLARE_ACCOUNT_ID"), { CLOUDFLARE_API_TOKEN: "cf-token" });
untouched("Cloudflare のトークンだけが無いと判定を呼ばず、欠けた名前の知らせとともに Sonnet 5.5 だけを使う", routed(clefJudge), "claude-sonnet-5-5", keyNotice("clef-flash", "CLOUDFLARE_API_TOKEN"), { CLOUDFLARE_ACCOUNT_ID: "acct-123" });
untouched("Cloudflare のアカウント ID が空なら判定を呼ばず、欠けた名前の知らせとともに Sonnet 5.5 だけを使う", routed(clefJudge), "claude-sonnet-5-5", keyNotice("clef-flash", "CLOUDFLARE_ACCOUNT_ID"), { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "" });
