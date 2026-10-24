import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { JudgeModel } from "./judgeSelection.ts";

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const SYSTEM_ONE_MODEL = "jev-latest";
const workersAiUrl = (accountId: string, model: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`;

export type JudgeQuestion = { readonly type: "noul"; readonly instructions: string };
export type JudgeAnswer = {
  readonly distribution: { readonly yes: number; readonly no: number };
  readonly chosen: "yes" | "no";
  readonly confidence: number;
};
export type JudgeOutcome =
  | { readonly ok: true; readonly answers: Readonly<Record<string, JudgeAnswer>>; readonly usage?: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly reason: string };
export type JudgeAsk = (state: string, questions: Readonly<Record<string, JudgeQuestion>>) => Effect.Effect<JudgeOutcome>;

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const SystemOneBody = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ noul: Probability })),
  usage: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
});
// Workers AI の REST は結果を result に包んで返す。包まれていない形（TypeSafe）と同じ変換に通す。
const SystemOneResponse = Schema.Union([SystemOneBody, Schema.Struct({ result: SystemOneBody })]);

const clean = (text: string) => text.replaceAll(/[\r\n]/g, " ");

export const makeSystemOne = Effect.fnUntraced(function* (judge: JudgeModel, credentials: { readonly apiKey: string; readonly accountId?: string }) {
  const { apiKey, accountId } = credentials;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const model = judge.model ?? SYSTEM_ONE_MODEL;
  const url = judge.url ?? (accountId === undefined ? SYSTEM_ONE_URL : workersAiUrl(accountId, model));
  const ask: JudgeAsk = (state: string, questions: Readonly<Record<string, JudgeQuestion>>) => HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
    HttpClientRequest.bodyJson({ model, state, questions }),
    Effect.flatMap(client.execute),
    Effect.mapError(() => "判定の宛先につながりません"),
    Effect.filterOrFail((response) => response.status >= 200 && response.status < 300,
      (response) => `判定の宛先が HTTP ${response.status} を返しました`),
    Effect.flatMap((response) => HttpClientResponse.schemaBodyJson(SystemOneResponse)(response).pipe(
      Effect.mapError(() => "判定の応答の形が不正です"),
    )),
    Effect.flatMap((response) => {
      const body = "result" in response ? response.result : response;
      const answers: Record<string, JudgeAnswer> = {};
      for (const name of Object.keys(questions)) {
        const answer = Object.hasOwn(body.answers, name) ? body.answers[name] : undefined;
        if (answer === undefined) return Effect.fail(`判定の応答に質問 ${clean(name)} の答えがありません`);
        const p = answer.noul;
        answers[name] = { distribution: { yes: p, no: 1 - p }, chosen: p >= 0.5 ? "yes" : "no", confidence: Math.max(p, 1 - p) };
      }
      return Effect.succeed<JudgeOutcome>({ ok: true, answers, ...(body.usage ? { usage: body.usage } : {}) });
    }),
    Effect.scoped,
    Effect.timeoutOption(judge.timeoutMs),
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(`判定が ${judge.timeoutMs}ms で時間切れになりました`), onSome: Effect.succeed })),
    Effect.catch((reason: string) => Effect.succeed<JudgeOutcome>({ ok: false, reason })),
  );
  return ask;
});
