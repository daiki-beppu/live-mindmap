import { Config, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { ExecutableModel } from "./modelSelection.ts";
import { probeRequest, SYSTEM } from "./localPrompt.ts";
import type { Classify, LocalModel } from "./localDiffUpdater.ts";
import { KATAKANA_JSON_SCHEMA, KATAKANA_SYSTEM, KatakanaOutput, katakanaPrompt, toAnswers } from "./katakanaPrompt.ts";

class CompatibleFailed extends Schema.TaggedError<CompatibleFailed>()("CompatibleFailed", { message: Schema.String }) {}
class CompatibleUnavailable extends Schema.TaggedError<CompatibleUnavailable>()("CompatibleUnavailable", { message: Schema.String }) {}
const Completion = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })).check(Schema.isMinLength(1)),
});
const clean = (text: string) => text.replaceAll(/[\r\n]/g, " ");

export const prepareCompatible = Effect.fnUntraced(function* (model: Extract<ExecutableModel, { route: "openai-compatible" }>) {
  let key: string | undefined;
  if (model.apiKeyEnv !== undefined) {
    const value = yield* Config.option(Config.String(model.apiKeyEnv)).pipe(
      Effect.mapError(() => new CompatibleUnavailable({ message: `${clean(model.name)} の API キーを読めません: 環境変数 ${clean(model.apiKeyEnv!)}\n環境変数の設定を確かめてください` })),
    );
    if (Option.isNone(value) || value.value.trim() === "") return yield* new CompatibleUnavailable({
      message: `${clean(model.name)} の API キーがありません: 環境変数 ${clean(model.apiKeyEnv)} が空です\n環境変数を設定してから開始してください`,
    });
    key = value.value;
  }
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const url = `${model.url.replace(/\/$/, "")}/chat/completions`;
  const maxTokens = model.maxTokens ?? 600;
  // 1 回きりの要求を送り、応答の本文（JSON の文字列）を返す。system・prompt・JSON Schema だけが用途ごとに変わる
  const exchange = Effect.fnUntraced(function* (system: string, prompt: string, jsonSchema: object) {
    const body = {
      temperature: 0.2, ...model.extraBody,
      model: model.model, max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: { name: "diff", strict: true, schema: jsonSchema } },
    };
    const response = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.map((req) => key === undefined ? req : HttpClientRequest.setHeader(req, "authorization", `Bearer ${key}`)),
      Effect.flatMap(client.execute),
      Effect.mapError(() => new CompatibleUnavailable({ message: `${clean(model.name)} の宛先 ${clean(model.url)} につながりません\n実行環境（Ollama など）が起動しているか確かめてください` })),
    );
    if (response.status === 404) return yield* new CompatibleUnavailable({
      message: `${clean(model.name)} の宛先にモデル ${clean(model.model)} がありません\n実行環境にモデルを用意し、設定のモデル名を確かめてください`,
    });
    if (response.status < 200 || response.status >= 300) return yield* new CompatibleUnavailable({
      message: `${clean(model.name)} の宛先が HTTP ${response.status} を返しました\n実行環境の状態と認証設定を確かめてください`,
    });
    const completion = yield* HttpClientResponse.schemaBodyJson(Completion)(response).pipe(
      Effect.mapError(() => new CompatibleFailed({ message: "互換モデルの応答が不正です" })),
    );
    return completion.choices[0]!.message.content;
  }, Effect.scoped);
  const classify: Classify = (input) => exchange(SYSTEM, input.prompt, input.jsonSchema).pipe(
    Effect.flatMap((content) => Schema.decodeEffect(Schema.fromJsonString(input.schema), { onExcessProperty: "error" })(content).pipe(
      Effect.mapError(() => new CompatibleFailed({ message: "互換モデルの文分類が不正です" })),
    )),
  );
  // 開始検査も本番と同じ通信口・分類形式を使い、会議の状態には適用しない。読みの要求は足さない（開始時の通信の回数を変えない）。
  yield* classify(probeRequest());
  const katakana: LocalModel["katakana"] = (words) => exchange(KATAKANA_SYSTEM, katakanaPrompt(words), KATAKANA_JSON_SCHEMA).pipe(
    Effect.flatMap((content) => Schema.decodeEffect(Schema.fromJsonString(KatakanaOutput), { onExcessProperty: "error" })(content)),
    Effect.map(toAnswers),
    Effect.mapError((error) => error instanceof CompatibleUnavailable ? error : new CompatibleFailed({ message: "互換モデルの読みの応答が不正です" })),
  );
  return { classify, katakana } satisfies LocalModel;
});
