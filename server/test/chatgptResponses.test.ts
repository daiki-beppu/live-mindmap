import { describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Context, Effect, FileSystem, Result } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { applyOps, DiffUpdater, emptyMap, type DiffInput } from "../src/core/index.ts";
import { prepareUpdaterLayer } from "../src/diffUpdater.ts";
import { classificationRequest, SYSTEM } from "../src/localPrompt.ts";
import { CHATGPT_HOME, CHATGPT_MODEL, chatgptCredentials, classification, completedSse, encodedRequestBody, fakeChatgptFiles, fakeChatgptHttp, jsonRequestBody, sseEvent } from "./fixtures/chatgpt.ts";

const input: DiffInput = { map: emptyMap("定例"), recent: [], fresh: [{ id: "r1", track: "相手", start: 0, end: 1, text: "面接官は3人です。求人票を直します！" }] };
const probe = classification([{ 種類: "なし" }]);
const open = Effect.fnUntraced(function* (extraBody: Record<string, unknown>) {
  const layer = yield* prepareUpdaterLayer({ ...CHATGPT_MODEL, extraBody });
  return Context.get(yield* Effect.provide(Effect.context<DiffUpdater>(), layer), DiffUpdater);
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>, files: ReturnType<typeof fakeChatgptFiles>, http: ReturnType<typeof fakeChatgptHttp>) => effect.pipe(
  Effect.provideService(FileSystem.FileSystem, files.fs), Effect.provideService(HttpClient.HttpClient, http.client),
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: CHATGPT_HOME }))),
);
const response = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

describe("ChatGPT Responses（C03）", () => {
  it.effect("strict な分類要求を Responses に送り、UTF-8・イベント境界をまたぐ SSE から操作へ届く", () => Effect.gen(function* () {
    const files = fakeChatgptFiles(chatgptCredentials((yield* Clock.currentTimeMillis) + 3_600_000));
    const answer = classification([{ 種類: "説明", text: "面接官は3人" }, { 種類: "作業", text: "求人票を直す", 担当: "佐藤", 期限: "来週" }]);
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
      const expected = classificationRequest(input.map, input.recent, input.fresh.flatMap((r) => r.text.split(/(?<=[。！])/).filter(Boolean).map((text) => ({ remark: r.id, text }))));
      const body = jsonRequestBody(request);
      expect([request.method, request.url]).toEqual(["POST", "https://api.openai.com/v1/responses"]);
      expect(request.headers.authorization).toBe("Bearer synthetic-access");
      expect(body).toMatchObject({ model: CHATGPT_MODEL.model, store: false, stream: true, instructions: SYSTEM,
        text: { format: { type: "json_schema", strict: true, schema: expected.jsonSchema } } });
      expect(body.input).toEqual([{ role: "user", content: expected.prompt }]);
      for (const key of ["tools", "previous_response_id", "temperature", "max_tokens", "max_output_tokens", "messages"]) expect(Object.hasOwn(body, key)).toBe(false);
      const applied = applyOps(input.map, result.ops, new Set(["r1"]), { round: 1, at: 1 });
      expect(applied.dropped).toEqual([]);
      expect(Object.values(applied.map.nodes).filter((n) => n.kind !== "会議").map((n) => [n.kind, n.text, n.evidence])).toEqual([
        ["議題", "採用", ["r1"]], ["要点", "面接官は3人", ["r1"]], ["TODO", "求人票を直す", ["r1"]],
      ]);
      expect(Object.values(applied.map.nodes).find((n) => n.kind === "TODO")).toMatchObject({ assignee: "佐藤", due: "来週" });
      expect(result.processedRemarks).toBe(1);
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
