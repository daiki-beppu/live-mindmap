import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { readyHelperChecks } from "./fixtures/helperCheck.ts";
import type { AppleIntelligence } from "../src/appleIntelligence.ts";
import type { Scope } from "effect";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, FileSystem, Layer, Queue, Result, Schema, Stream, type Cause } from "effect";
import { vi } from "vitest";
import { reportFailure, runCli, teardown } from "../src/cli.ts";
import { JsonExport, type ExportNode } from "../src/core/index.ts";
import { planLayer, type UpdatePlan } from "../src/updatePlan.ts";
import type { UpdaterUnavailable } from "../src/updaterUnavailable.ts";
import { DiffUpdater } from "../src/core/index.ts";
import type { ExecutableModel } from "../src/modelSelection.ts";
import { HttpClient } from "effect/http";
import { Helpers, type HelperExitInfo } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { EXPORT_FILE, LOG_FILE } from "../src/sessionFiles.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { MODEL_TRANSFER_HEADER, modelTransferTokenPath } from "../src/modelTransferToken.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";

const listener = vi.hoisted(() => ({ open: vi.fn() }));
const prepareUpdaterLayer: (plan: UpdatePlan) => Effect.Effect<{ layer: Layer.Layer<DiffUpdater, UpdaterUnavailable> }, UpdaterUnavailable, HttpClient.HttpClient | FileSystem.FileSystem | AppleIntelligence | Scope.Scope> = (plan) => planLayer(plan).pipe(Effect.provide(forbiddenManagedDeps));
vi.mock("../src/http.ts", async (original) => {
  const { fakeListener } = await import("./fakeListener.ts");
  const actual = await original<typeof import("../src/http.ts")>();
  return { ...actual, openListener: (port: number) => {
    listener.open();
    return fakeListener().open(port);
  } };
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-compatible-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);
type Body = { model: string; messages: { role: string; content: string }[]; response_format: { json_schema: { schema: { properties: { 文: { maxItems: number } } } } } };
const loopback = Effect.fnUntraced(function* (afterRequest: (call: number) => void) {
  const requests: { path: string; body: Body; authorization: string | undefined; transferToken: string | string[] | undefined }[] = [];
  const server: Server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { text += chunk; });
    req.on("end", () => {
      const body: Body = JSON.parse(text);
      requests.push({ path: req.url!, body, authorization: req.headers.authorization, transferToken: req.headers[MODEL_TRANSFER_HEADER] });
      afterRequest(requests.length);
      const missing = body.model === "missing-model";
      res.writeHead(missing ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(missing ? { error: { code: "model_not_found", message: "model not found" } } : {
        choices: [{ message: { role: "assistant", content: JSON.stringify({
          議題: { id: "新しい議題", 題: "採用" },
          文: Array.from({ length: body.response_format.json_schema.schema.properties.文.maxItems }, () => ({ 種類: "説明", text: "採用の進め方" })),
          済み: "なし", 名前: [],
        }) } }],
      }));
    });
  });
  yield* Effect.acquireRelease(
    Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    })),
    () => Effect.promise(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ループバックのポートを取得できません");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
});
const dependencies = (root: string, port = 0) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const layer = Layer.mergeAll(readyManagedDeps, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"), LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_PORT: String(port) })),
    Layer.succeed(Console.Console, {
      ...console,
      log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
      error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
    }),
  );
  return { stdout, stderr, layer };
};
// 入口（cli.ts の import.meta.main）と同じ順に、実行 → 失敗の表示（reportFailure）→ 終了コード（teardown）を通す。process.exitCode は呼び出し前の値に戻す
const runEntry = Effect.fnUntraced(function* (root: string, port: number, argv: string[]) {
  const deps = dependencies(root, port);
  const exit = yield* runCli(argv).pipe(Effect.tapCause(reportFailure), Effect.provide(deps.layer), Effect.exit);
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    teardown(exit, () => { throw new Error("自然終了する必要があります"); });
    return { code: Number(process.exitCode ?? 0), stdout: deps.stdout.join(""), stderr: deps.stderr.join("") };
  } finally {
    process.exitCode = saved;
  }
});
// CLI の HTTP クライアントの相手（常駐サーバー）の代わりに、依頼ごとに handler で応える
const listening = Effect.fnUntraced(function* (handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  yield* Effect.acquireRelease(
    Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    })),
    () => Effect.promise(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ポートを取得できません");
  return address.port;
});
const fixture = join(import.meta.dirname, "fixtures/short.transcript.json");

describe("互換モデルの実行配線（C01・invRefusedIsInert）", () => {
  it.live("play --modelでループバックHTTPからマップ・根拠・ログ・書き出しまで届く", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    let changed = false;
    const http = yield* loopback((call) => {
      if (call !== 2) return;
      writeFileSync(join(root, "config.json"), JSON.stringify({ models: { compatible: { route: "openai-compatible", model: "replacement-model", url: "http://127.0.0.1:1/v1" } } }));
      changed = true;
    });
    writeFileSync(join(root, "config.json"), JSON.stringify({ models: { compatible: { route: "openai-compatible", model: "synthetic-model", url: http.url } } }));
    const deps = dependencies(root);
    yield* runCli(["play", fixture, "--model", "compatible"]).pipe(Effect.provide(deps.layer));
    const dir = dirname(deps.stdout.join("").trim().split("\n")[0]!);
    const exported = Schema.decodeUnknownSync(JsonExport)(JSON.parse(readFileSync(join(dir, EXPORT_FILE), "utf8")));
    const log = readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(log[0]).toMatchObject({ type: "start", model: { name: "compatible", route: "openai-compatible", local: false } });
    expect(http.requests.length).toBeGreaterThan(1);
    expect(changed).toBe(true);
    expect(http.requests.every((r) => r.path === "/v1/chat/completions" && r.body.model === "synthetic-model")).toBe(true);
    expect(exported.root.children.length).toBeGreaterThan(0);
    const nodes = (node: ExportNode): ExportNode[] => [node, ...node.children.flatMap(nodes)];
    expect([...new Set(nodes(exported.root).flatMap((n) => n.evidence.map((r) => r.id)))].sort()).toEqual(["r1", "r2", "r3"]);
    expect(log.filter((e) => e.type === "diff").flatMap((e) => e.dropped)).toEqual([]);
    expect(log.filter((e) => e.type === "diff").every((e) => e.error === undefined)).toBe(true);
    expect(readFileSync(join(dir, "map.md"), "utf8")).toContain("採用の進め方");
    expect(JSON.parse(readFileSync(join(dir, "map.json"), "utf8"))).toEqual(exported);
  }));

  it.live("playのモデル不存在は待受け・フォルダ生成前に2行で拒否し、同じ入口の正常再生は成功する", () => Effect.gen(function* () {
    listener.open.mockClear();
    const root = yield* temporaryDirectory;
    const http = yield* loopback(() => {});
    const writeConfig = (model: string) => writeFileSync(join(root, "config.json"), JSON.stringify({ models: { compatible: { route: "openai-compatible", model, url: http.url } } }));
    writeConfig("missing-model");
    const deps = dependencies(root);
    const result = yield* Effect.result(runCli(["play", fixture, "--model", "compatible"]).pipe(Effect.provide(deps.layer)));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("モデル不存在を拒否しませんでした");
    const message = String(result.failure);
    expect(message).toContain("missing-model");
    expect(message.split("\n")).toHaveLength(2);
    expect(http.requests).toHaveLength(1);
    expect(listener.open).not.toHaveBeenCalled();
    expect(existsSync(join(root, "sessions"))).toBe(false);
    writeConfig("synthetic-model");
    yield* runCli(["play", fixture, "--model", "compatible"]).pipe(Effect.provide(deps.layer));
    expect(listener.open).toHaveBeenCalledOnce();
    expect(readdirSync(join(root, "sessions"), { withFileTypes: true }).filter((entry) => entry.isDirectory())).toHaveLength(1); // 語彙の溜まりのファイルは数えない
  }));

  it.live.each([undefined, "SYNTHETIC_TRANSFER_KEY"])("ライブ開始は未認可の読取・通信を防ぎ、認可後のモデル拒否と正常開始を保持する（apiKeyEnv=%s）", (apiKeyEnv) => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const http = yield* loopback(() => {});
    const launches: string[][] = [];
    const helpers = Layer.succeed(Helpers, Helpers.of({ ...readyHelperChecks, apps: Effect.succeed([]), launch: (args) => Effect.gen(function* () {
      launches.push([...args]);
      const queue = yield* Queue.make<string, Cause.Done>();
      Queue.offerUnsafe(queue, JSON.stringify({ type: "speaker-off", start: 0, reason: "モデルなし" })); // 相手の発言は話者の確定を待つので、話者分離を使えない helper にして待たせない（Issue #1021）
      Queue.offerUnsafe(queue, JSON.stringify({ type: "remark", track: "相手", start: 0, end: 1, text: "採用の進め方を共有します。" }));
      const exited = yield* Deferred.make<HelperExitInfo>();
      const stop = Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, { code: null, signal: "SIGTERM" })));
      yield* Effect.addFinalizer(() => stop);
      return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed([]), send: () => Effect.void };
    }) }));
    const snapshots: unknown[] = [];
    const keyReads: unknown[] = [];
    const provider = ConfigProvider.make((path) => {
      keyReads.push(path);
      return ConfigProvider.fromEnvRecord({ SYNTHETIC_TRANSFER_KEY: "synthetic-key" }).load(path);
    });
    const sinks = SessionSinks.layer({ prepareUpdater: prepareUpdaterLayer }).pipe(
      Layer.provide(Layer.mergeAll(fakeExportServices(), NodeHttpClient.layerUndici, unusedApple)),
    );
    const server = yield* startedServer({ port: 0, sessionsDir: join(root, "sessions") }, {
      helpers, sessionSinks: sinks, managedDeps: readyManagedDeps,
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider));
    const token = readFileSync(modelTransferTokenPath(join(root, "sessions"), server.port), "utf8");
    const { WebSocket } = yield* Effect.promise(() => import("ws"));
    const ws = yield* Effect.acquireRelease(
      Effect.tryPromise(() => new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        socket.on("message", (raw) => { const frame = JSON.parse(raw.toString()); if (Array.isArray(frame.nodes)) snapshots.push(frame); });
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      })), (socket) => Effect.sync(() => socket.terminate()),
    );
    const post = (model: string, headers: Record<string, string>) => Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/session/start`, {
      method: "POST", headers: { "content-type": "text/plain", ...headers },
      body: JSON.stringify({ app: "us.zoom.xos", audio: false, screen: false, model: { name: "compatible", route: "openai-compatible", model, url: http.url, local: false, apiKeyEnv } }),
    }));
    const mismatched = `${token[0] === "0" ? "1" : "0"}${token.slice(1)}`;
    for (const origin of [undefined, "http://localhost:9999"]) {
      const readsBefore = keyReads.length;
      const requestsBefore = http.requests.length;
      for (const received of [undefined, "", mismatched]) {
        const denied = yield* post("missing-model", { ...(origin ? { origin } : {}), ...(received === undefined ? {} : { [MODEL_TRANSFER_HEADER]: received }) });
        expect(denied.status).toBe(403);
        expect(yield* Effect.tryPromise(() => denied.json())).toEqual({ error: "互換モデルの転送を認可できません\n同じ保存先設定の CLI から start を実行してください" });
        expect(keyReads).toHaveLength(readsBefore);
        expect(http.requests).toHaveLength(requestsBefore);
        expect(launches).toEqual([]);
        expect(existsSync(join(root, "sessions"))).toBe(false);
        expect(snapshots).toEqual([]);
      }
      const response = yield* post("missing-model", { ...(origin ? { origin } : {}), [MODEL_TRANSFER_HEADER]: token });
      expect(response.status).toBe(503);
      const refused = yield* Effect.tryPromise(() => response.json());
      expect(refused.error).toContain("missing-model");
      expect(refused.error.split("\n")).toHaveLength(2);
      expect(http.requests).toHaveLength(requestsBefore + 1);
      expect(keyReads).toHaveLength(readsBefore + (apiKeyEnv === undefined ? 0 : 1));
      expect(launches).toEqual([]);
      expect(existsSync(join(root, "sessions"))).toBe(false);
      expect(snapshots).toEqual([]);
    }
    const authorized = { [MODEL_TRANSFER_HEADER]: token, origin: "http://localhost:9999" };
    const allowed = yield* post("synthetic-model", authorized);
    expect(allowed.status).toBe(200);
    expect(launches).toHaveLength(1);
    expect(readdirSync(join(root, "sessions"), { withFileTypes: true }).filter((entry) => entry.isDirectory())).toHaveLength(1); // 語彙の溜まりのファイルは数えない
    yield* Effect.promise(() => new Promise<void>((resolve, reject) => {
      if (snapshots.length) return resolve();
      const timeout = setTimeout(() => reject(new Error("正常開始の初期マップが届きません")), 2000);
      const onMessage = () => {
        if (!snapshots.length) return;
        clearTimeout(timeout);
        ws.off("message", onMessage);
        resolve();
      };
      ws.on("message", onMessage);
    }));
    expect(snapshots).toHaveLength(1);
    const stopped = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/session/stop`, { method: "POST" }));
    expect(stopped.status).toBe(200);
    expect(http.requests).toHaveLength(4); // Origin別の拒否2件、正常開始の検査、flushの本番更新
    expect(http.requests.map((r) => r.authorization)).toEqual(Array(4).fill(apiKeyEnv === undefined ? undefined : "Bearer synthetic-key"));
    expect(http.requests.map((r) => r.transferToken)).toEqual([undefined, undefined, undefined, undefined]);
    const dir = join(root, "sessions", readdirSync(join(root, "sessions"))[0]!);
    const diffs = readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "diff");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ processedRemarks: 1, dropped: [] });
    expect(diffs[0].error).toBeUndefined();
    expect(readFileSync(join(dir, "map.md"), "utf8")).toContain("採用の進め方");
    yield* server.close;
  }));

  it.live("start の HTTP 拒否2行を stderr に保持して exit 1、200 の正常応答では dir を表示して exit 0", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    let status = 503;
    const error = "モデルを開始できません\n実行環境を確認してください";
    const port = yield* listening((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status === 503 ? { error } : { dir: "/synthetic/session" }));
      });
    });
    const argv = ["start", "--app", "us.zoom.xos", "--model", "claude"];
    expect(yield* runEntry(root, port, argv)).toEqual({ code: 1, stdout: "", stderr: `${error}\n` });
    status = 200;
    expect(yield* runEntry(root, port, argv)).toEqual({ code: 0, stdout: "/synthetic/session\n", stderr: "" });
  }));

  it.live("実 CLI start がトークンを取得し、指定宛先・認証・追加 body・モデルを会議終了まで保持する", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const requests: { path: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
    const port = yield* listening((req, res) => {
      let text = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => { text += chunk; });
      req.on("end", () => {
        requests.push({ path: req.url!, authorization: req.headers.authorization, body: JSON.parse(text) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ 議題: { id: "新しい議題", 題: "採用" }, 文: [{ 種類: "説明", text: "採用の進め方" }], 済み: "なし", 名前: [] }) } }] }));
      });
    });
    // 発言は、設定を書き換えた後に流す。差分更新は発言が届いたらすぐ呼ぶので、先に流すと書き換えより前に呼ばれてしまう
    let sayRemark: (() => void) | undefined;
    const helpers = Layer.succeed(Helpers, Helpers.of({ ...readyHelperChecks, apps: Effect.succeed([]), launch: () => Effect.gen(function* () {
      const queue = yield* Queue.make<string, Cause.Done>();
      // 相手の発言は話者の確定を待つので、話者分離を使えない helper にして待たせない（Issue #1021）
      sayRemark = () => {
        Queue.offerUnsafe(queue, JSON.stringify({ type: "speaker-off", start: 0, reason: "モデルなし" }));
        Queue.offerUnsafe(queue, JSON.stringify({ type: "remark", track: "相手", start: 0, end: 1, text: "採用の進め方を共有します。" }));
      };
      const exited = yield* Deferred.make<HelperExitInfo>();
      const stop = Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, { code: null, signal: "SIGTERM" })));
      yield* Effect.addFinalizer(() => stop);
      return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed([]), send: () => Effect.void };
    }) }));
    const server = yield* startedServer({ port: 0, sessionsDir: join(root, "sessions") }, {
      helpers,
      sessionSinks: SessionSinks.layer({ prepareUpdater: planLayer }).pipe(Layer.provide(Layer.mergeAll(forbiddenManagedDeps, fakeExportServices(), NodeHttpClient.layerUndici, unusedApple))),
      managedDeps: readyManagedDeps,
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ SYNTHETIC_PROCESS_KEY: "synthetic-key" })));
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ models: { compatible: { route: "openai-compatible", model: "synthetic-model", url: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "SYNTHETIC_PROCESS_KEY", maxTokens: 321, extraBody: { seed: 17 } } } }));
    const started = yield* runEntry(root, server.port, ["start", "--app", "us.zoom.xos", "--no-audio", "--no-screen", "--model", "compatible"]);
    expect(started.code).toBe(0);
    expect(started.stderr).toBe("");
    expect(requests).toHaveLength(1);
    writeFileSync(config, JSON.stringify({ models: { compatible: { route: "openai-compatible", model: "replacement", url: "http://127.0.0.1:1/v1" } } }));
    sayRemark!();
    for (let i = 0; i < 500 && requests.length < 2; i++) yield* Effect.sleep(10);
    const stopped = yield* runEntry(root, server.port, ["stop"]);
    expect(stopped.code).toBe(0);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer synthetic-key", body: { model: "synthetic-model", max_tokens: 321, seed: 17 } });
    }
    expect(readFileSync(join(started.stdout.trim(), "map.md"), "utf8")).toContain("採用の進め方");
    yield* server.close;
  }));
});
