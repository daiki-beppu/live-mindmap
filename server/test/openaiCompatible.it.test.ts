import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, Layer, Queue, Result, Schema, Stream, type Cause } from "effect";
import { vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { JsonExport, type ExportNode } from "../src/core/index.ts";
import { prepareUpdaterLayer as prepare, type UpdaterUnavailable } from "../src/diffUpdater.ts";
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

const listener = vi.hoisted(() => ({ open: vi.fn() }));
const prepareUpdaterLayer: (model: ExecutableModel) => Effect.Effect<Layer.Layer<DiffUpdater, UpdaterUnavailable>, UpdaterUnavailable, HttpClient.HttpClient> = prepare;
vi.mock("../src/http.ts", async (original) => {
  const { fakeListener } = await import("./fakeListener.ts");
  const actual = await original<typeof import("../src/http.ts")>();
  return { ...actual, openListener: (...args: Parameters<typeof actual.openListener>) => {
    listener.open();
    return fakeListener().open(...args);
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
          済み: "なし",
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
const dependencies = (root: string) => {
  const stdout: string[] = [];
  const layer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"), LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_PORT: "0" })),
    Layer.succeed(Console.Console, { ...console, log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); } }),
  );
  return { stdout, layer };
};
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
    expect(readdirSync(join(root, "sessions"))).toHaveLength(1);
  }));

  it.live.each([undefined, "SYNTHETIC_TRANSFER_KEY"])("ライブ開始は未認可の読取・通信を防ぎ、認可後のモデル拒否と正常開始を保持する（apiKeyEnv=%s）", (apiKeyEnv) => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const http = yield* loopback(() => {});
    const launches: string[][] = [];
    const helpers = Layer.succeed(Helpers, Helpers.of({ apps: Effect.succeed([]), launch: (args) => Effect.gen(function* () {
      launches.push([...args]);
      const queue = yield* Queue.make<string, Cause.Done>();
      Queue.offerUnsafe(queue, JSON.stringify({ type: "remark", track: "相手", start: 0, end: 1, text: "採用の進め方を共有します。" }));
      const exited = yield* Deferred.make<HelperExitInfo>();
      const stop = Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, { code: null, signal: "SIGTERM" })));
      yield* Effect.addFinalizer(() => stop);
      return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed([]) };
    }) }));
    const snapshots: unknown[] = [];
    const keyReads: unknown[] = [];
    const provider = ConfigProvider.make((path) => {
      keyReads.push(path);
      return ConfigProvider.fromEnvRecord({ SYNTHETIC_TRANSFER_KEY: "synthetic-key" }).load(path);
    });
    const sinks = SessionSinks.layer({ prepareUpdater: prepareUpdaterLayer }).pipe(
      Layer.provide(Layer.merge(fakeExportServices(), NodeHttpClient.layerUndici)),
    );
    const server = yield* startedServer({ port: 0, sessionsDir: join(root, "sessions") }, {
      helpers, sessionSinks: sinks,
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
    expect(readdirSync(join(root, "sessions"))).toHaveLength(1);
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
});
