import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse, type HttpClientRequest } from "effect/http";
import type { JudgeModel } from "../src/judgeSelection.ts";
import { makeSystemOne } from "../src/systemOne.ts";

// 判定の口（System One API の形）。偽の HttpClient で、送るものと応答の写し方と「判定できなかった」を固定する。
// 応答の JSON の形（answers.<名前>.noul）は二次資料による想定。実 API の形が違えば、ここと systemOne.ts を合わせて直す。

const judge: JudgeModel = { name: "jev", route: "system-one", apiKeyEnv: "TYPESAFE_AI_API_KEY", timeoutMs: 1000 };
const questions = { route: { type: "noul", instructions: "含まれるか" } } as const;
const state = "# 新しい発言\n来週までにやります";

type Sent = { request: HttpClientRequest.HttpClientRequest; body: { model?: string; state?: string; questions?: unknown } };
const bodyOf = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag === "Uint8Array") return JSON.parse(new TextDecoder().decode(request.body.body));
  if (request.body._tag === "Raw" && typeof request.body.body === "string") return JSON.parse(request.body.body);
  throw new Error("偽HttpClientがJSON bodyを読み取れません");
};
const respond = (request: HttpClientRequest.HttpClientRequest, payload: unknown, status = 200) =>
  HttpClientResponse.fromWeb(request, new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }));

const fakeClient = (answer: (sent: Sent) => HttpClientResponse.HttpClientResponse | Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>) => {
  const requests: Sent[] = [];
  const client = HttpClient.make((request) => {
    const sent = { request, body: bodyOf(request) };
    requests.push(sent);
    const out = answer(sent);
    return Effect.isEffect(out) ? out : Effect.succeed(out);
  });
  return { client, requests };
};
const ok = (noul: unknown, extra: object = {}) => (sent: Sent) =>
  respond(sent.request, { answers: { route: { type: "noul", noul } }, ...extra });

const ask = (judgeModel: JudgeModel, client: HttpClient.HttpClient, key = "synthetic-key") =>
  Effect.gen(function* () {
    const asking = yield* makeSystemOne(judgeModel, key).pipe(Effect.provideService(HttpClient.HttpClient, client));
    return yield* asking(state, questions);
  });

describe("判定の口: 送るもの", () => {
  it.effect("既定の宛先・モデル名で、鍵・state・質問の束をそのまま POST する", () => Effect.gen(function* () {
    const fake = fakeClient(ok(0.5));
    yield* ask(judge, fake.client);
    expect(fake.requests).toHaveLength(1);
    const { request, body } = fake.requests[0]!;
    expect([request.method, request.url]).toEqual(["POST", "https://api.typesafe.ai/v1/systemone"]);
    expect(request.headers.authorization).toBe("Bearer synthetic-key");
    expect(body).toEqual({ model: "jev-latest", state, questions });
  }));

  it.effect("設定の宛先とモデル名で上書きする", () => Effect.gen(function* () {
    const fake = fakeClient(ok(0.5));
    yield* ask({ ...judge, url: "http://test.invalid/systemone", model: "jev-custom" }, fake.client, "other-key");
    const { request, body } = fake.requests[0]!;
    expect(request.url).toBe("http://test.invalid/systemone");
    expect(request.headers.authorization).toBe("Bearer other-key");
    expect(body.model).toBe("jev-custom");
  }));
});

describe("判定の口: 応答の写し方", () => {
  it.effect("noul の確率 p を yes=p・no=1-p の分布に写し、p>=0.5 なら yes を選ぶ", () => Effect.gen(function* () {
    const fake = fakeClient(ok(0.8));
    const outcome = yield* ask(judge, fake.client);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const answer = outcome.answers.route!;
    expect(answer.distribution.yes).toBeCloseTo(0.8);
    expect(answer.distribution.no).toBeCloseTo(0.2);
    expect(answer.chosen).toBe("yes");
    expect(answer.confidence).toBeCloseTo(0.8);
  }));

  it.effect("p が 0.5 未満なら no を選び、確からしさは選んだ側（1-p）になる。yes の確率は分布に残る", () => Effect.gen(function* () {
    const fake = fakeClient(ok(0.1));
    const outcome = yield* ask(judge, fake.client);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const answer = outcome.answers.route!;
    expect(answer.distribution.yes).toBeCloseTo(0.1);
    expect(answer.chosen).toBe("no");
    expect(answer.confidence).toBeCloseTo(0.9);
  }));

  it.effect("端の値 0 と 1 も受け入れる", () => Effect.gen(function* () {
    for (const p of [0, 1]) {
      const outcome = yield* ask(judge, fakeClient(ok(p)).client);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.answers.route!.distribution.yes).toBeCloseTo(p);
    }
  }));

  it.effect("応答の usage（数値の record）を結果に載せる。usage が無い応答も失敗にしない", () => Effect.gen(function* () {
    const withUsage = yield* ask(judge, fakeClient(ok(0.4, { usage: { input_tokens: 12, output_tokens: 3 } })).client);
    expect(withUsage.ok && withUsage.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    const without = yield* ask(judge, fakeClient(ok(0.4)).client);
    expect(without.ok).toBe(true);
  }));
});

describe("判定の口: 判定できなかった（例外にしない）", () => {
  const failed = (label: string, answer: Parameters<typeof fakeClient>[0]) =>
    it.effect(`${label}は ok:false と理由になり、Effect は失敗しない`, () => Effect.gen(function* () {
      const outcome = yield* ask(judge, fakeClient(answer).client);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason.trim()).not.toBe("");
    }));

  failed("HTTP 500", (sent) => respond(sent.request, { error: "boom" }, 500));
  failed("HTTP 401", (sent) => respond(sent.request, { error: "unauthorized" }, 401));
  failed("接続の失敗", (sent) => Effect.fail(new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request: sent.request, description: "connection refused" }),
  })));
  failed("JSON でない応答", (sent) => respond(sent.request, "<html>not json</html>"));
  failed("answers が無い応答", (sent) => respond(sent.request, { result: "x" }));
  failed("質問名の答えが欠けた応答", (sent) => respond(sent.request, { answers: {} }));
  failed("noul が無い答え", (sent) => respond(sent.request, { answers: { route: { type: "noul" } } }));
  failed("noul が数値でない答え", (sent) => respond(sent.request, { answers: { route: { type: "noul", noul: "0.9" } } }));
  failed("noul が 1 を超える答え", (sent) => respond(sent.request, { answers: { route: { type: "noul", noul: 1.5 } } }));
  failed("noul が負の答え", (sent) => respond(sent.request, { answers: { route: { type: "noul", noul: -0.1 } } }));

  it.effect("timeoutMs を超えて応答が来ないと ok:false（時間切れ）になる", () => Effect.gen(function* () {
    const fake = fakeClient(() => Effect.never);
    const fiber = yield* Effect.forkChild(ask({ ...judge, timeoutMs: 700 }, fake.client));
    yield* TestClock.adjust(699);
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(2);
    const outcome = yield* Fiber.join(fiber);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason.trim()).not.toBe("");
  }));
});
