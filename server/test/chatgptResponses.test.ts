import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { assertStrictJsonSchema } from "./fixtures/strictJsonSchema.ts";
import { describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { applyOps, DiffUpdater, emptyMap, makeSession, type DiffInput, type LogEvent } from "../src/core/index.ts";
import { prepareUpdaterLayer } from "../src/diffUpdater.ts";
import { classificationRequest, SYSTEM } from "../src/localPrompt.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { CHATGPT_HOME, CHATGPT_MODEL, chatgptCredentials, classification, completedSse, encodedRequestBody, fakeChatgptFiles, fakeChatgptHttp, jsonRequestBody, sseEvent } from "./fixtures/chatgpt.ts";
import { collectLog } from "./fixtures/sessionLayers.ts";

const input: DiffInput = { map: emptyMap("定例"), recent: [], fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "面接官は3人です。求人票を直します！" }] };
const probe = classification([{ 種類: "なし" }]);
const open = Effect.fnUntraced(function* (extraBody: Record<string, unknown>) {
  const layer = yield* prepareUpdaterLayer({ ...CHATGPT_MODEL, extraBody });
  return Context.get(yield* Effect.provide(Effect.context<DiffUpdater>(), layer), DiffUpdater);
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>, files: ReturnType<typeof fakeChatgptFiles>, http: ReturnType<typeof fakeChatgptHttp>) => effect.pipe(
  Effect.provideService(FileSystem.FileSystem, files.fs), Effect.provideService(HttpClient.HttpClient, http.client),
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: CHATGPT_HOME }))), Effect.provide(unusedApple), Effect.provide(forbiddenManagedDeps),
);
const response = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

const responsesRequest = Schema.Struct({
  input: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
  text: Schema.Struct({ format: Schema.Struct({ schema: Schema.Struct({
    properties: Schema.Struct({ 文: Schema.Struct({ minItems: Schema.Number, maxItems: Schema.Number }) }),
  }) }) }),
});

describe("ChatGPT の文数上限と通常失敗後の状態", () => {
  it.effect("判断軸があると Responses で関係づけ更新を受け取り、軸を記載順で送る", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const criteria = ["採用のしやすさ", "運用負荷"];
    const ops = [{ op: "update", node: "n1", evidence: ["r1"], criteria: [] }];
    const http = fakeChatgptHttp((request, call) => {
      if (call === 1) return response(completedSse(probe));
      const body = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.Struct({ format: Schema.Struct({ schema: Schema.Unknown }) }) }))(jsonRequestBody(request));
      assertStrictJsonSchema(body.text.format.schema);
      return response(completedSse({ ops: ops.map((op) => ({ text: null, planStatus: null, assignee: null, assigneeSpeaker: null, ...op })), names: null }));
    });
    yield* provide(Effect.gen(function* () {
      const updater = yield* open({});
      expect((yield* updater.update({ ...input, criteria })).ops).toEqual(ops);
      const body = Schema.decodeUnknownSync(Schema.Struct({ input: Schema.Array(Schema.Struct({ content: Schema.String })) }))(jsonRequestBody(http.requests[1]!));
      const prompt = body.input[0]!.content;
      expect(prompt.indexOf(criteria[0]!)).toBeGreaterThanOrEqual(0);
      expect(prompt.indexOf(criteria[1]!)).toBeGreaterThan(prompt.indexOf(criteria[0]!));
    }), files, http);
  }));

  it.effect("長い1発言を3文以内の Responses 要求に分け、各文を一度ずつ送る", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const http = fakeChatgptHttp((request) => {
      const body = Schema.decodeUnknownSync(responsesRequest)(jsonRequestBody(request));
      return response(completedSse(classification(Array.from({ length: body.text.format.schema.properties.文.maxItems }, () => ({ 種類: "なし" })))));
    });
    yield* provide(Effect.gen(function* () {
      const updater = yield* open({});
      const sentences = ["第一文。", "第二文？", "第三文！", "第四文?", "第五文!", "第六文。", "第七文。"];
      const result = yield* updater.update({ ...input, fresh: [{ ...input.fresh[0]!, text: sentences.join("") }] });
      const bodies = http.requests.slice(1).map((request) => Schema.decodeUnknownSync(responsesRequest)(jsonRequestBody(request)));
      expect(bodies.map((body) => body.text.format.schema.properties.文)).toEqual([
        { minItems: 3, maxItems: 3 }, { minItems: 3, maxItems: 3 }, { minItems: 1, maxItems: 1 },
      ]);
      const batches = bodies.map((body) => body.input[0]!.content.split("\n")
        .filter((line) => /^\d+\. /.test(line)).map((line) => line.split(": ")[1]));
      expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
      expect(batches.flat()).toEqual(sentences);
      expect(result.processedRemarks).toBe(1);
    }), files, http);
  }));

  it.effect("3文に収まる発言の先頭部分だけを Responses に送り、その処理済み件数を返す", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const http = fakeChatgptHttp((request) => {
      const body = Schema.decodeUnknownSync(responsesRequest)(jsonRequestBody(request));
      return response(completedSse(classification(Array.from({ length: body.text.format.schema.properties.文.maxItems }, () => ({ 種類: "なし" })))));
    });
    yield* provide(Effect.gen(function* () {
      const updater = yield* open({});
      const result = yield* updater.update({ ...input, fresh: [
        { ...input.fresh[0]!, text: "第一文。第二文。" },
        { ...input.fresh[0]!, id: "r2", text: "第三文。" },
        { ...input.fresh[0]!, id: "r3", text: "第四文。" },
      ] });
      expect(http.requests).toHaveLength(2);
      const body = Schema.decodeUnknownSync(responsesRequest)(jsonRequestBody(http.requests[1]!));
      const lines = body.input[0]!.content.split("\n").filter((line) => /^\d+\. /.test(line));
      expect(lines.map((line) => line.split(": ")[1])).toEqual(["第一文。", "第二文。", "第三文。"]);
      expect(result.processedRemarks).toBe(2);
    }), files, http);
  }));

  it.effect("同じ Session の正常更新後に500が返っても restarting・stopped にならない", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const http = fakeChatgptHttp((_request, call) => call === 3
      ? new Response(JSON.stringify({ error: { code: "server_error" } }), { status: 500 })
      : response(completedSse(call === 1 ? probe : classification([{ 種類: "説明", text: "面接官は3人" }]))));
    yield* provide(Effect.gen(function* () {
      const layer = yield* prepareUpdaterLayer(CHATGPT_MODEL);
      const events: LogEvent[] = [];
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(layer, collectLog(events))));
      const first = { ...input.fresh[0]!, text: "面接官は3人です。" };
      yield* session.push(first);
      yield* session.idle;
      const initialDiffs = events.filter((event) => event.type === "diff");
      expect(initialDiffs).toHaveLength(1);
      expect(initialDiffs[0]!.ops.length).toBeGreaterThan(0);
      expect(yield* session.diffUpdate).toEqual({ status: "running" });
      yield* session.push({ ...first, id: "r2", text: "次の発言です。" });
      yield* session.idle;
      expect(http.requests).toHaveLength(3);
      const body = Schema.decodeUnknownSync(responsesRequest)(jsonRequestBody(http.requests[2]!));
      expect(body.input[0]!.content).toContain("次の発言です。");
      const diffs = events.filter((event) => event.type === "diff");
      expect(diffs).toHaveLength(2);
      expect(diffs[1]).toMatchObject({ ops: [], error: expect.stringContaining("500") });
      expect(yield* session.unreflectedRemarks).toEqual([]);
      expect(yield* session.diffUpdate).toEqual({ status: "running" });
      expect(events.filter((event) => event.type.startsWith("diff-update-"))).toEqual([]);
    }), files, http);
  }));
});

describe("ChatGPT Responses（C03）", () => {
  it.effect("strict な分類要求を Responses に送り、UTF-8・イベント境界をまたぐ SSE から操作へ届く", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const answer = classification([{ 種類: "説明", text: "面接官は3人" }, { 種類: "作業", text: "求人票を直す", 担当: "佐藤", 担当の話者: "", 期限: "来週" }]);
    const http = fakeChatgptHttp((_request, call) => {
      const bytes = new TextEncoder().encode(completedSse(call === 1 ? probe : answer));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    yield* provide(Effect.gen(function* () {
      const updater = yield* open({ tools: [{ type: "web_search" }], previous_response_id: "forbidden", store: true, stream: false, model: "wrong" });
      const result = yield* updater.update(input);
      expect(http.requests).toHaveLength(2);
      const request = http.requests[1]!;
      const expected = classificationRequest(input.map, input.recent, input.fresh.flatMap((r) => r.text.split(/(?<=[。！])/).filter(Boolean).map((text) => ({ remark: r, text }))));
      const body = jsonRequestBody(request);
      expect([request.method, request.url]).toEqual(["POST", "https://api.openai.com/v1/responses"]);
      expect(request.headers.authorization).toBe("Bearer synthetic-access");
      expect(body).toMatchObject({ model: CHATGPT_MODEL.model, store: false, stream: true, instructions: SYSTEM,
        text: { format: { type: "json_schema", strict: true, schema: expected.jsonSchema } } });
      expect(body.input).toEqual([{ role: "user", content: expected.prompt }]);
      for (const key of ["tools", "previous_response_id", "temperature", "max_tokens", "max_output_tokens", "messages"]) expect(Object.hasOwn(body, key)).toBe(false);
      const applied = applyOps(input.map, result.ops, new Set(["r1"]), { round: 1, at: 1 }, new Map());
      expect(applied.dropped).toEqual([]);
      expect(Object.values(applied.map.nodes).filter((n) => n.kind !== "会議").map((n) => [n.kind, n.text, n.evidence])).toEqual([
        ["議題", "採用", ["r1"]], ["要点", "面接官は3人", ["r1"]], ["TODO", "求人票を直す", ["r1"]],
      ]);
      expect(Object.values(applied.map.nodes).find((n) => n.kind === "TODO")).toMatchObject({ assignee: "佐藤", due: "来週" });
      expect(result.processedRemarks).toBe(1);
    }), files, http);
  }));

  // Issue #642: 英字の語のカタカナの読み（katakana）は、分類とは別の instructions・schema で 1 回きりの要求を送る
  it.effect("katakana は語を 1 回の要求にまとめ、読みの instructions・schema で送り、語ごとのカタカナを返す。分類の要求とは別の instructions と schema", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const http = fakeChatgptHttp((_request, call) => response(completedSse(call === 1 ? probe
      : { readings: [{ word: "Notion", katakana: "ノーション" }, { word: "Figma", katakana: "フィグマ" }] })));
    yield* provide(Effect.gen(function* () {
      const updater = yield* open({});
      const answer = yield* updater.katakana!(["Notion", "Figma"]);
      expect(answer).toEqual([{ surface: "Notion", katakana: "ノーション" }, { surface: "Figma", katakana: "フィグマ" }]);
      expect(http.requests).toHaveLength(2); // 開始時の接続確認 1 回 + 読みの要求 1 回
      const body = jsonRequestBody(http.requests[1]!);
      expect(body).toMatchObject({ model: CHATGPT_MODEL.model, store: false, stream: true, text: { format: { type: "json_schema", strict: true } } });
      expect(body.instructions).not.toBe(SYSTEM);
      expect(JSON.stringify(body.input)).toContain("Notion");
      expect(JSON.stringify(body.input)).toContain("Figma");
      expect(JSON.stringify((body.text as { format: { schema: unknown } }).format.schema)).toContain("readings");
    }), files, http);
  }));

  it.effect("katakana の要求が失敗（切断）したら失敗として返り、空の答えにはならない", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const http = fakeChatgptHttp((_request, call) => response(call === 1 ? completedSse(probe)
      : sseEvent({ type: "response.output_text.delta", delta: JSON.stringify({ readings: [{ word: "Notion", katakana: "ノーション" }] }) })));
    yield* provide(Effect.gen(function* () {
      const updater = yield* open({});
      expect(Result.isFailure(yield* Effect.result(updater.katakana!(["Notion"])))).toBe(true);
    }), files, http);
  }));

  it.effect.each([
    { name: "failed", terminal: sseEvent({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }) },
    { name: "incomplete", terminal: sseEvent({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }) },
    { name: "error", terminal: sseEvent({ type: "error", error: { code: "server_error" } }) },
    { name: "切断", terminal: "" },
  ])("生成済みの JSON があっても $name は操作として返さない", ({ terminal }) => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const http = fakeChatgptHttp((_request, call) => response(call === 1 ? completedSse(probe)
      : sseEvent({ type: "response.output_text.delta", delta: JSON.stringify(classification([{ 種類: "説明", text: "生成済み" }, { 種類: "なし" }])) }) + terminal));
    yield* provide(Effect.gen(function* () {
      const updater = yield* open({});
      expect(Result.isFailure(yield* Effect.result(updater.update(input)))).toBe(true);
      expect(http.requests).toHaveLength(2);
    }), files, http);
  }));

  it.effect.each([
    { condition: "未定義の種類", sentences: [{ 種類: "自由操作", text: "不正" }, { 種類: "なし" }] },
    { condition: "入力より少ない文", sentences: [{ 種類: "説明", text: "1文だけ" }] },
  ])("completed でも $condition は拒否する", ({ sentences }) => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const http = fakeChatgptHttp((_request, call) => response(completedSse(call === 1 ? probe : classification(sentences))));
    yield* provide(Effect.gen(function* () {
      const updater = yield* open({});
      expect(Result.isFailure(yield* Effect.result(updater.update(input)))).toBe(true);
      expect(http.requests).toHaveLength(2);
    }), files, http);
  }));
});

describe("資格情報の期限前更新（C02）", () => {
  it.live("同じ認証ファイルを使う独立した2つの準備処理は更新を直列化し、ローテーション後の値を再読込する", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 60_000));
    const forms: URLSearchParams[] = [];
    const http = fakeChatgptHttp((request) => {
      if (request.url.endsWith("/oauth/token")) {
        forms.push(new URLSearchParams(encodedRequestBody(request)));
        return Effect.sleep(10).pipe(Effect.as(new Response(JSON.stringify({
          access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600,
          scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
        }), { headers: { "content-type": "application/json" } })));
      }
      return response(completedSse(probe));
    });
    yield* provide(Effect.all([open({}), open({})], { concurrency: 2 }), files, http);
    expect(forms).toHaveLength(1);
    expect(forms[0]!.get("refresh_token")).toBe("synthetic-refresh");
    expect(http.requests.filter((r) => r.url.endsWith("/responses")).map((r) => r.headers.authorization)).toEqual(["Bearer rotated-access", "Bearer rotated-access"]);
    expect(JSON.parse(files.files.get(files.authPath)!.text)).toMatchObject({ access_token: "rotated-access", refresh_token: "rotated-refresh" });
  }));

  it.effect("同じ updater の旧トークン → 時間経過 → 更新・原子的保存 → 新トークンを連続観測する", () => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const files = fakeChatgptFiles(chatgptCredentials(now + 3_600_000));
    const forms: URLSearchParams[] = [];
    const http = fakeChatgptHttp((request) => {
      if (request.url.endsWith("/oauth/token")) {
        forms.push(new URLSearchParams(encodedRequestBody(request)));
        return new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, token_type: "Bearer", scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct" }), { headers: { "content-type": "application/json" } });
      }
      const body = jsonRequestBody(request) as { text: { format: { schema: { properties: { 文: { maxItems: number } } } } } };
      return response(completedSse(classification(Array.from({ length: body.text.format.schema.properties.文.maxItems }, () => ({ 種類: "なし" })))));
    });
    yield* provide(Effect.gen(function* () {
      const updater = yield* open({});
      yield* updater.update(input);
      expect(forms).toEqual([]);
      yield* TestClock.adjust(58 * 60_000);
      yield* updater.update(input);
      yield* updater.update(input);
      expect(forms).toHaveLength(1);
      expect(Object.fromEntries(forms[0]!)).toMatchObject({ grant_type: "refresh_token", client_id: "synthetic-client", refresh_token: "synthetic-refresh", resource: "https://api.openai.com/v1" });
      const requests = http.requests.filter((r) => r.url.endsWith("/responses"));
      expect(requests.map((r) => r.headers.authorization)).toEqual(["Bearer synthetic-access", "Bearer synthetic-access", "Bearer rotated-access", "Bearer rotated-access"]);
      const saved = files.files.get(files.authPath)!;
      expect(JSON.parse(saved.text)).toMatchObject({ access_token: "rotated-access", refresh_token: "rotated-refresh" });
      expect(saved.mode).toBe(0o600);
      expect(files.renames.filter((r) => r.to === files.authPath)).toEqual([expect.objectContaining({ mode: 0o600 })]);
      expect(files.writes.some((w) => w.path === files.authPath)).toBe(false);
      expect(files.writes.every((w) => w.mode === 0o600)).toBe(true);
    }), files, http);
  }));

  it.effect("更新の書戻しが失敗したら旧ファイルを保持し、推論を送らない", () => Effect.gen(function* () {
    const original = chatgptCredentials((yield* Clock.currentTimeMillis) + 60_000);
    const files = fakeChatgptFiles(original);
    files.control.failRename = true;
    const http = fakeChatgptHttp(() => new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, scope: original.scopes.join(" ") }), { headers: { "content-type": "application/json" } }));
    const result = yield* provide(Effect.result(open({})), files, http);
    expect(Result.isFailure(result)).toBe(true);
    expect(http.requests.map((r) => r.url)).toEqual(["https://auth.openai.com/api/accounts/oauth/token"]);
    expect(JSON.parse(files.files.get(files.authPath)!.text)).toEqual(original);
    expect([...files.files.keys()]).toEqual([files.authPath]);
  }));
});
