import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Context, Effect, FileSystem, Layer, Result } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { applyOps, DiffUpdater, emptyMap, type DiffInput, type Op, type Remark } from "../src/core/index.ts";
import { prepareUpdaterLayer as prepare, type UpdaterUnavailable } from "../src/diffUpdater.ts";

const model = { name: "compatible", route: "openai-compatible" as const, model: "synthetic-model", url: "http://test.invalid/v1", local: false as const };
type CompatibleModel = typeof model & { apiKeyEnv?: string; maxTokens?: number; extraBody?: Record<string, unknown> };
// 計画の「選択済みモデル→開始前準備→実行Layer」を使う。関数名は後続実装の境界名に合わせられる。
const prepareUpdaterLayer: (selected: CompatibleModel) => Effect.Effect<Layer.Layer<DiffUpdater, UpdaterUnavailable>, UpdaterUnavailable, HttpClient.HttpClient> = (selected) => prepare(selected).pipe(Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})));
const remark = (text: string, id = "r1"): Remark => ({ id, track: "相手", start: 0, end: 10, text });
const input = (text: string): DiffInput => ({ map: emptyMap("定例"), recent: [], fresh: [remark(text)] });
type Classification = { 議題: { id: string; 題: string }; 文: readonly object[]; 済み: string };
const classified = (sentences: readonly object[]): Classification => ({ 議題: { id: "新しい議題", 題: "採用" }, 文: sentences, 済み: "なし" });
const none = classified([{ 種類: "なし" }]);
type SchemaNode = { enum?: string[]; properties?: Record<string, SchemaNode>; items?: SchemaNode; anyOf?: SchemaNode[]; minItems?: number; maxItems?: number };
type Body = {
  model: string; max_tokens: number; temperature?: number; chat_template_kwargs?: object;
  messages: { role: string; content: string }[];
  response_format: { type: string; json_schema: { strict: boolean; schema: SchemaNode } };
};
const requestBody = (request: HttpClientRequest.HttpClientRequest): Body => {
  if (request.body._tag === "Uint8Array") return JSON.parse(new TextDecoder().decode(request.body.body));
  if (request.body._tag === "Raw" && typeof request.body.body === "string") return JSON.parse(request.body.body);
  throw new Error("偽HttpClientがJSON bodyを読み取れません");
};

const fakeClient = (answer: (body: Body, call: number) => unknown, status: number | ((call: number) => number) = 200) => {
  const requests: { request: HttpClientRequest.HttpClientRequest; body: Body }[] = [];
  const client = HttpClient.make((request) => Effect.sync(() => {
    const body = requestBody(request);
    requests.push({ request, body });
    const response = answer(body, requests.length);
    const code = typeof status === "number" ? status : status(requests.length);
    return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(code >= 400 ? response : {
      choices: [{ message: { role: "assistant", content: JSON.stringify(response) } }],
    }), { status: code, headers: { "content-type": "application/json" } }));
  }));
  return { client, requests };
};
const open = Effect.fnUntraced(function* (selected: CompatibleModel) {
  const layer = yield* prepareUpdaterLayer(selected);
  const context = yield* Effect.provide(Effect.context<DiffUpdater>(), layer);
  return Context.get(context, DiffUpdater);
});

describe("OpenAI互換の要求とv5変換（C02・C03）", () => {
  it.effect("設定URL・モデル・認証・出力上限・追加bodyを送り、同じ発言の複数文から操作を生成する", () => Effect.gen(function* () {
    const fake = fakeClient((_body, call) => call === 1 ? none : classified([
      { 種類: "説明", text: "面接官は3人" }, { 種類: "作業", text: "求人票を直す", 担当: "佐藤", 期限: "来週" },
    ]));
    const updater = yield* open({ ...model, apiKeyEnv: "SYNTHETIC_MODEL_KEY", maxTokens: 777,
      extraBody: { temperature: 0.1, chat_template_kwargs: { enable_thinking: false }, model: "wrong", max_tokens: 1, messages: [], response_format: {} },
    }).pipe(Effect.provideService(HttpClient.HttpClient, fake.client), Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SYNTHETIC_MODEL_KEY: "synthetic-key" }))));
    const result = yield* updater.update(input("面接官は3人です。求人票を直します！"));
    expect(fake.requests).toHaveLength(2);
    const { request, body } = fake.requests[1]!;
    expect([request.method, request.url]).toEqual(["POST", "http://test.invalid/v1/chat/completions"]);
    expect(request.headers.authorization).toBe("Bearer synthetic-key");
    expect(body).toMatchObject({ model: "synthetic-model", max_tokens: 777, temperature: 0.1, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(body.response_format.json_schema.schema.properties!.文).toMatchObject({ minItems: 2, maxItems: 2 });
    expect(result).toMatchObject({ processedRemarks: 1 });
    const applied = applyOps(emptyMap("定例"), result.ops, new Set(["r1"]), { round: 1, at: 10 });
    expect(applied.dropped).toEqual([]);
    expect(Object.values(applied.map.nodes).filter((n) => n.kind !== "会議").map((n) => [n.kind, n.text, n.evidence])).toEqual([
      ["議題", "採用", ["r1"]], ["要点", "面接官は3人", ["r1"]], ["TODO", "求人票を直す", ["r1"]],
    ]);
    expect(Object.values(applied.map.nodes).find((n) => n.kind === "TODO")).toMatchObject({ assignee: "佐藤", due: "来週" });
  }));

  for (const [kind, nodeKind] of [["説明", "要点"], ["問い", "論点"], ["提案", "案"], ["懸念", "課題"]] as const) {
    it.effect(`${kind}を${nodeKind}として議題の下に置く`, () => Effect.gen(function* () {
      const fake = fakeClient((_body, call) => call === 1 ? none : classified([{ 種類: kind, text: "文の要約" }]));
      const updater = yield* open(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
      const result = yield* updater.update(input("分類する文です。"));
      const applied = applyOps(emptyMap("定例"), result.ops, new Set(["r1"]), { round: 1, at: 10 });
      expect(applied.dropped).toEqual([]);
      const nodes = Object.values(applied.map.nodes);
      const topic = nodes.find((n) => n.kind === "議題")!;
      expect(nodes.find((n) => n.text === "文の要約")).toMatchObject({ kind: nodeKind, parent: topic.id, evidence: ["r1"] });
    }));
  }

  it.effect("合意は新しい論点の下の決定にし、なしはノードを作らない", () => Effect.gen(function* () {
    const fake = fakeClient((_body, call) => call === 1 ? none : classified([
      { 種類: "なし" }, { 種類: "合意", 論点: "新しい論点", 論点の文: "面接は何回か", text: "2回にする" },
    ]));
    const updater = yield* open(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
    const result = yield* updater.update(input("はい。2回にしましょう。"));
    const applied = applyOps(emptyMap("定例"), result.ops, new Set(["r1"]), { round: 1, at: 10 });
    expect(applied.dropped).toEqual([]);
    const nodes = Object.values(applied.map.nodes);
    expect(nodes.filter((n) => n.kind !== "会議")).toHaveLength(3);
    expect(nodes.find((n) => n.kind === "決定")).toMatchObject({ parent: nodes.find((n) => n.kind === "論点")!.id, text: "2回にする", evidence: ["r1"] });
  }));

  it.effect("話し中の議題と論点だけを送信・列挙し、既存論点への合意とcloseを変換する", () => Effect.gen(function* () {
    const map = applyOps(emptyMap("定例"), [
      { op: "add", ref: "a", parent: "root", kind: "議題", text: "進行中議題", evidence: ["old"] },
      { op: "add", ref: "b", parent: "a", kind: "論点", text: "進行中論点", evidence: ["old"] },
      { op: "add", ref: "c", parent: "a", kind: "要点", text: "非表示の要点", evidence: ["old"] },
      { op: "add", ref: "d", parent: "root", kind: "議題", text: "終了議題", evidence: ["old"] },
      { op: "add", ref: "e", parent: "d", kind: "論点", text: "終了議題の論点", evidence: ["old"] },
      { op: "add", ref: "f", parent: "root", kind: "議題", text: "閉じる議題", evidence: ["old"] },
    ], new Set(["old"]), { round: 1, at: 1 }).map;
    map.nodes.n4!.talkStatus = "済み";
    const fake = fakeClient((_body, call) => call === 1 ? none : {
      議題: { id: "n1", 題: "" }, 文: [{ 種類: "合意", 論点: "n2", 論点の文: "", text: "2回にする" }], 済み: "n6",
    });
    const updater = yield* open(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
    const result = yield* updater.update({ ...input("2回にしましょう。"), map });
    const body = fake.requests[1]!.body;
    const schema = body.response_format.json_schema.schema.properties!;
    expect(schema.議題!.properties!.id!.enum).toEqual(["n1", "n6", "新しい議題"]);
    const agreement = schema.文!.items!.anyOf!.find((v) => v.properties!.種類!.enum!.includes("合意"))!;
    expect(agreement.properties!.論点!.enum).toEqual(["n2", "新しい論点"]);
    expect(schema.済み!.enum).toEqual(["なし", "n1", "n2", "n6"]);
    const prompt = body.messages.find((m) => m.role === "user")!.content;
    expect(prompt).toContain("進行中議題");
    expect(prompt).toContain("進行中論点");
    for (const text of ["非表示の要点", "終了議題", "終了議題の論点"]) expect(prompt).not.toContain(text);
    expect(result.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "add", kind: "決定", parent: "n2", evidence: ["r1"] }), { op: "close", node: "n6" },
    ]));
  }));

  it.effect("同じupdaterを続けて使っても履歴messagesを継続しない", () => Effect.gen(function* () {
    const fake = fakeClient(() => none);
    const updater = yield* open(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
    const first = yield* updater.update(input("前回だけの入力文。"));
    expect(first.ops).toEqual([]);
    yield* updater.update(input("今回だけの入力文。"));
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[1]!.body.max_tokens).toBe(600);
    expect(fake.requests[1]!.request.headers.authorization).toBeUndefined();
    expect(fake.requests[1]!.body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const latest = fake.requests[2]!.body.messages;
    expect(latest.map((m) => m.role)).toEqual(["system", "user"]);
    expect(latest[1]!.content).toContain("今回だけの入力文。");
    expect(latest[1]!.content).not.toContain("前回だけの入力文。");
  }));

  it.effect("invCapLocalForm: 長い1発言を上限内の要求に分け、全ての文を一度ずつ反映する", () => Effect.gen(function* () {
    const fake = fakeClient((body, call) => call === 1 ? none : classified(Array.from(
      { length: body.response_format.json_schema.schema.properties!.文!.maxItems! },
      (_, n) => ({ 種類: "説明", text: `要約${call}-${n}` }),
    )));
    const updater = yield* open(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
    const sentences = ["第一文。", "第二文？", "第三文！", "第四文?", "第五文!", "第六文。", "第七文。"];
    const result = yield* updater.update(input(sentences.join("")));
    const requests = fake.requests.slice(1).map((r) => r.body);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.map((b) => b.response_format.json_schema.schema.properties!.文!.maxItems)).toEqual([3, 3, 1]);
    for (const sentence of sentences) expect(requests.filter((b) => b.messages.some((m) => m.content.includes(sentence)))).toHaveLength(1);
    const additions = result.ops.filter((o): o is Extract<Op, { op: "add" }> => o.op === "add");
    expect(additions.filter((o) => o.kind === "要点")).toHaveLength(7);
    expect(new Set(additions.map((o) => o.ref)).size).toBe(additions.length);
    expect(additions.every((o) => o.evidence.length === 1 && o.evidence[0] === "r1")).toBe(true);
    expect(result).toMatchObject({ processedRemarks: 1 });
  }));

  it.effect("invCapLocalForm: 3文に収まる発言の先頭部分だけを反映した数として返す", () => Effect.gen(function* () {
    const fake = fakeClient((body) => classified(Array.from({ length: body.response_format.json_schema.schema.properties!.文!.maxItems! }, () => ({ 種類: "なし" }))));
    const updater = yield* open(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
    const result = yield* updater.update({ map: emptyMap("定例"), recent: [], fresh: [remark("第一文。第二文。"), remark("第三文。", "r2"), remark("第四文。", "r3")] });
    expect(result).toMatchObject({ processedRemarks: 2 });
    expect(fake.requests).toHaveLength(2);
    const body = fake.requests[1]!.body;
    expect(body.response_format.json_schema.schema.properties!.文).toMatchObject({ minItems: 3, maxItems: 3 });
    expect(body.messages[1]!.content).toContain("第三文。");
    expect(body.messages[1]!.content).not.toContain("第四文。");
  }));

  for (const [name, response] of [
    ["分類件数不足", classified([])], ["分類件数過剰", classified([{ 種類: "なし" }, { 種類: "なし" }])],
    ["未知の議題ID", { ...classified([{ 種類: "説明", text: "要約" }]), 議題: { id: "unknown", 題: "" } }],
    ["未知の論点ID", classified([{ 種類: "合意", 論点: "unknown", 論点の文: "", text: "合意" }])],
    ["未知の種類", classified([{ 種類: "自由操作", text: "要約" }])],
    ["41字の要約", classified([{ 種類: "説明", text: "あ".repeat(41) }])],
    ["必要な要約の欠落", classified([{ 種類: "説明" }])],
    ["分類の外形がnull", null],
  ] as const) {
    it.effect(`不正応答（${name}）は操作として返さず失敗する`, () => Effect.gen(function* () {
      const fake = fakeClient((_body, call) => call === 1 ? none : response);
      const updater = yield* open(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
      const result = yield* Effect.result(updater.update(input("分類する一文。")));
      expect(Result.isFailure(result)).toBe(true);
      expect(fake.requests).toHaveLength(2);
    }));
  }

  it.effect("40字の要約は反映できる", () => Effect.gen(function* () {
    const text = "あ".repeat(40);
    const fake = fakeClient((_body, call) => call === 1 ? none : classified([{ 種類: "説明", text }]));
    const updater = yield* open(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
    const result = yield* updater.update(input("分類する一文。"));
    expect(result.ops).toContainEqual(expect.objectContaining({ op: "add", kind: "要点", text }));
  }));

  it.effect("C05: 長い発言の分割要求が途中で失敗しても途中の操作を返さず再試行しない", () => Effect.gen(function* () {
    const fake = fakeClient((body, call) => call === 3 ? { error: { message: "synthetic failure" } } : classified(
      Array.from({ length: body.response_format.json_schema.schema.properties!.文!.maxItems! }, () => ({ 種類: "説明", text: "要約" })),
    ), (call) => call === 3 ? 500 : 200);
    const updater = yield* open(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client));
    const result = yield* Effect.result(updater.update(input("第一文。第二文。第三文。第四文。")));
    expect(Result.isFailure(result)).toBe(true);
    expect(fake.requests).toHaveLength(3);
  }));
});

describe("開始前の2行拒否（C06・C07・C08）", () => {
  it.effect("接続不能を理由と次の操作の2行で返す", () => Effect.gen(function* () {
    let attempts = 0;
    const client = HttpClient.make((request) => {
      attempts++;
      return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause: new Error("synthetic connection refused") }) }));
    });
    const failure = yield* Effect.flip(prepareUpdaterLayer(model).pipe(Effect.provideService(HttpClient.HttpClient, client)));
    const lines = failure.message.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(model.name);
    expect(lines[0]).toContain(model.url);
    expect(lines[0]).toMatch(/つなが|接続/);
    expect(lines[1]!.trim()).not.toBe("");
    expect(attempts).toBe(1);
  }));

  it.effect("404のモデル不存在を接続不能と区別する", () => Effect.gen(function* () {
    const fake = fakeClient(() => ({ error: { message: "model not found", code: "model_not_found" } }), 404);
    const failure = yield* Effect.flip(prepareUpdaterLayer(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client)));
    const lines = failure.message.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(model.model);
    expect(lines[0]).toMatch(/モデル.*(ありません|存在|見つか)/);
    expect(lines[1]!.trim()).not.toBe("");
    expect(fake.requests).toHaveLength(1);
  }));

  it.effect("500の失敗をモデル不存在に読み替えない", () => Effect.gen(function* () {
    const fake = fakeClient(() => ({ error: { message: "synthetic internal failure" } }), 500);
    const failure = yield* Effect.flip(prepareUpdaterLayer(model).pipe(Effect.provideService(HttpClient.HttpClient, fake.client)));
    expect(failure.message).not.toMatch(/モデル.*(ありません|存在しません|見つかりません)/);
    expect(fake.requests).toHaveLength(1);
  }));

  for (const env of [{}, { SYNTHETIC_MODEL_KEY: "" }]) {
    it.effect(`キー環境変数が${Object.keys(env).length ? "空文字" : "未設定"}なら通信前に拒否する`, () => Effect.gen(function* () {
      const fake = fakeClient(() => none);
      const failure = yield* Effect.flip(prepareUpdaterLayer({ ...model, apiKeyEnv: "SYNTHETIC_MODEL_KEY" }).pipe(
        Effect.provideService(HttpClient.HttpClient, fake.client), Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
      ));
      const lines = failure.message.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("SYNTHETIC_MODEL_KEY");
      expect(lines[0]).toMatch(/API.*キー/);
      expect(lines[1]!.trim()).not.toBe("");
      expect(fake.requests).toEqual([]);
    }));
  }
});
