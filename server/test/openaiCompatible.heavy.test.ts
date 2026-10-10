import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpClient } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Layer, Queue, Stream, type Cause } from "effect";
import { prepareUpdaterLayer } from "../src/diffUpdater.ts";
import { Helpers, type HelperExitInfo } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";

const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-compatible-process-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);
const runProcess = (root: string, port: number, argv: string[]) => Effect.tryPromise(() =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["LIVE_MINDMAP_MODEL", "SYNTHETIC_PROCESS_KEY"].includes(name)));
    execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...argv], {
      encoding: "utf8", timeout: 10_000,
      env: { ...env, HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"), LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_PORT: String(port), NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) return reject(error);
      resolve({ code: error ? error.code as number : 0, stdout, stderr });
    });
  }),
);
const loopback = Effect.fnUntraced(function* (handler: (req: IncomingMessage, res: ServerResponse) => void) {
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

describe("互換モデルと拒否表示の CLI プロセス入口", () => {
  it.live("play のキー未設定は理由・次の操作を stderr の2行に表示し exit 1", () => Effect.gen(function* () {
    const root = yield* directory;
    writeFileSync(join(root, "config.json"), JSON.stringify({ models: { compatible: { route: "openai-compatible", model: "synthetic-model", url: "http://127.0.0.1:1/v1", apiKeyEnv: "SYNTHETIC_PROCESS_KEY" } } }));
    const result = yield* runProcess(root, 0, ["play", join(import.meta.dirname, "fixtures/short.transcript.json"), "--model", "compatible"]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "compatible の API キーがありません: 環境変数 SYNTHETIC_PROCESS_KEY が空です\n環境変数を設定してから開始してください\n" });
  }));

  it.live("start の HTTP 拒否2行を stderr に保持し、200 の正常応答では dir を表示する", () => Effect.gen(function* () {
    const root = yield* directory;
    let status = 503;
    const error = "モデルを開始できません\n実行環境を確認してください";
    const port = yield* loopback((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status === 503 ? { error } : { dir: "/synthetic/session" }));
      });
    });
    const argv = ["start", "--app", "us.zoom.xos", "--model", "claude"];
    expect(yield* runProcess(root, port, argv)).toEqual({ code: 1, stdout: "", stderr: `${error}\n` });
    status = 200;
    expect(yield* runProcess(root, port, argv)).toEqual({ code: 0, stdout: "/synthetic/session\n", stderr: "" });
  }));

  it.live("実 CLI start がトークンを取得し、指定宛先・認証・追加 body・モデルを会議終了まで保持する", () => Effect.gen(function* () {
    const root = yield* directory;
    const requests: { path: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
    const port = yield* loopback((req, res) => {
      let text = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => { text += chunk; });
      req.on("end", () => {
        requests.push({ path: req.url!, authorization: req.headers.authorization, body: JSON.parse(text) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ 議題: { id: "新しい議題", 題: "採用" }, 文: [{ 種類: "説明", text: "採用の進め方" }], 済み: "なし" }) } }] }));
      });
    });
    const helpers = Layer.succeed(Helpers, Helpers.of({ apps: Effect.succeed([]), launch: () => Effect.gen(function* () {
      const queue = yield* Queue.make<string, Cause.Done>();
      Queue.offerUnsafe(queue, JSON.stringify({ type: "remark", track: "相手", start: 0, end: 1, text: "採用の進め方を共有します。" }));
      const exited = yield* Deferred.make<HelperExitInfo>();
      const stop = Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, { code: null, signal: "SIGTERM" })));
      yield* Effect.addFinalizer(() => stop);
      return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed([]) };
    }) }));
    const server = yield* startedServer({ port: 0, sessionsDir: join(root, "sessions") }, {
      helpers,
      sessionSinks: SessionSinks.layer({ prepareUpdater: prepareUpdaterLayer }).pipe(Layer.provide(Layer.merge(fakeExportServices(), NodeHttpClient.layerUndici))),
      managedDeps: forbiddenManagedDeps,
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ SYNTHETIC_PROCESS_KEY: "synthetic-key" })));
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ models: { compatible: { route: "openai-compatible", model: "synthetic-model", url: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "SYNTHETIC_PROCESS_KEY", maxTokens: 321, extraBody: { seed: 17 } } } }));
    const started = yield* runProcess(root, server.port, ["start", "--app", "us.zoom.xos", "--no-audio", "--no-screen", "--model", "compatible"]);
    expect(started.code).toBe(0);
    expect(started.stderr).toBe("");
    expect(requests).toHaveLength(1);
    writeFileSync(config, JSON.stringify({ models: { compatible: { route: "openai-compatible", model: "replacement", url: "http://127.0.0.1:1/v1" } } }));
    const stopped = yield* runProcess(root, server.port, ["stop"]);
    expect(stopped.code).toBe(0);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer synthetic-key", body: { model: "synthetic-model", max_tokens: 321, seed: 17 } });
    }
    expect(readFileSync(join(started.stdout.trim(), "map.md"), "utf8")).toContain("採用の進め方");
    yield* server.close;
  }));
});
