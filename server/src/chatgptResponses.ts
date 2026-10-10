import { Effect, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { DiffUpdatePaused, emptyMap } from "./core/index.ts";
import { accessToken, ChatgptEndpoints } from "./chatgptAuth.ts";
import { authPath, chatgptRefusal, ChatgptUnavailable } from "./chatgptAuthStore.ts";
import { classificationRequest, SYSTEM } from "./localPrompt.ts";
import type { Classify } from "./localDiffUpdater.ts";
import type { ExecutableModel } from "./modelSelection.ts";

const Event = Schema.Struct({ type: Schema.String, delta: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(Schema.Struct({ status: Schema.optionalKey(Schema.String) })) });
const UsageLimit = Schema.Struct({ error: Schema.Struct({ code: Schema.Literal("subscription_sharing_usage_limit_exceeded") }) });

const readSse = Effect.fnUntraced(function* (stream: Stream.Stream<Uint8Array, import("effect/http").HttpClientError.HttpClientError>) {
  let text = "", data: string[] = [];
  let completed = false;
  const event = Effect.fnUntraced(function* () {
    if (data.length === 0) return;
    const raw = data.join("\n");
    data = [];
    if (raw === "[DONE]") return;
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Event))(raw);
    switch (value.type) {
      case "response.output_text.delta":
        if (completed || value.delta === undefined) return yield* chatgptRefusal("ChatGPT の応答が不正です");
        text += value.delta;
        break;
      case "response.completed":
        if (completed || value.response?.status !== "completed") return yield* chatgptRefusal("ChatGPT の応答が未完了です");
        completed = true;
        break;
      case "response.failed": case "response.incomplete": case "error":
        return yield* chatgptRefusal("ChatGPT の応答が失敗しました");
    }
  });
  yield* stream.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach((line) => {
    if (line === "") return event();
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    return Effect.void;
  }));
  if (!completed || data.length > 0) return yield* chatgptRefusal("ChatGPT の応答が完了する前に接続が終了しました");
  return text;
});

export const prepareChatgpt = Effect.fnUntraced(function* (model: Extract<ExecutableModel, { route: "chatgpt" }>) {
  const path = yield* authPath;
  const endpoints = yield* ChatgptEndpoints;
  const services = yield* Effect.context<import("effect").FileSystem.FileSystem | HttpClient.HttpClient>();
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const request = Effect.fnUntraced(function* (input: ReturnType<typeof classificationRequest>) {
    const token = yield* accessToken(path).pipe(Effect.provideContext(services), Effect.provideService(ChatgptEndpoints, endpoints));
    const response = yield* HttpClientRequest.post(endpoints.responses).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      HttpClientRequest.bodyJson({ model: model.model, instructions: SYSTEM,
        input: [{ role: "user", content: input.prompt }], store: false, stream: true,
        text: { format: { type: "json_schema", name: "diff", strict: true, schema: input.jsonSchema } },
      }), Effect.flatMap(client.execute),
    );
    if (response.status === 401) return yield* chatgptRefusal("ChatGPT のトークンが期限切れか、利用できません");
    if (response.status === 403) return yield* chatgptRefusal("ChatGPT の対象プラン（Plus・Pro）ではないか、プラン利用が許可されていません");
    if (response.status === 429) {
      const limit = yield* response.text.pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(UsageLimit))),
        Effect.result,
      );
      if (limit._tag === "Success") return yield* new DiffUpdatePaused({ reason: "ChatGPT の利用上限", message: "ChatGPT の利用上限" });
    }
    if (response.status < 200 || response.status >= 300) return yield* chatgptRefusal(`ChatGPT が HTTP ${response.status} を返しました`);
    const text = yield* readSse(response.stream);
    return yield* Schema.decodeEffect(Schema.fromJsonString(input.schema), { onExcessProperty: "error" })(text);
  }, Effect.scoped, Effect.timeout("5 minutes"), Effect.mapError((error) => error instanceof ChatgptUnavailable || error instanceof DiffUpdatePaused ? error : chatgptRefusal("ChatGPT の応答を取得・検証できません")));
  yield* request(classificationRequest(emptyMap("接続確認"), [], [{ remark: "probe", text: "接続を確認します。" }]));
  const classify: Classify = request;
  return classify;
}, Effect.mapError((error) => error instanceof ChatgptUnavailable ? error : chatgptRefusal("ChatGPT の資格情報を読み込めません")));
