import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, Layer, Queue, Schema, Stream, type Cause } from "effect";
import { vi } from "vitest";
import { AppleIntelligence } from "../src/appleIntelligence.ts";
import { runCli } from "../src/cli.ts";
import { JsonExport } from "../src/core/index.ts";
import { prepareUpdaterLayer } from "../src/diffUpdater.ts";
import { UpdaterUnavailable } from "../src/updaterUnavailable.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { Helpers, type HelperExitInfo } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { EXPORT_FILE, LOG_FILE } from "../src/sessionFiles.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { fakeListener } from "./fakeListener.ts";

const listener = fakeListener();

vi.mock("../src/http.ts", async (original) => {
  return { ...await original<typeof import("../src/http.ts")>(), openListener: (port: number) => listener.open(port) };
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-apple-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);
const environment = (root: string, port: number) => ConfigProvider.layer(ConfigProvider.fromEnvRecord({
  HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"),
  LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_PORT: String(port),
}));
const appleProcess = Effect.fnUntraced(function* () {
  const state = { opened: 0, closed: 0, available: true };
  const requests: { url: string; alive: boolean }[] = [];
  const server: Server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { text += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url!, alive: state.opened > state.closed });
      const body = JSON.parse(text) as { response_format: { json_schema: { schema: { properties: { 文: { maxItems: number } } } } } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({
        議題: { id: "新しい議題", 題: "採用" },
        文: Array.from({ length: body.response_format.json_schema.schema.properties.文.maxItems }, () => ({ 種類: "説明", text: "面接官は3人" })),
        済み: "なし",
      }) } }] }));
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
  const url = `http://127.0.0.1:${address.port}/v1`;
  const layer = Layer.succeed(AppleIntelligence, AppleIntelligence.of({
    availability: Effect.sync(() => ({ osVersion: "27.0", availability: state.available
      ? { status: "available" as const }
      : { status: "unavailable" as const, reason: "modelNotReady" },
    })),
    launch: Effect.gen(function* () {
      if (!state.available) return yield* new UpdaterUnavailable({ message: "Apple Intelligence のモデルを準備中です\nしばらく待ってからやり直してください" });
      return yield* Effect.acquireRelease(
        Effect.sync(() => { state.opened++; return { url, pid: 4242 }; }),
        () => Effect.sync(() => { state.closed++; }),
      );
    }),
  }));
  return { state, requests, layer };
});
const audioHelper = () => {
  const launches: string[][] = [];
  const layer = Layer.succeed(Helpers, Helpers.of({ apps: Effect.succeed([]), launch: (args) => Effect.gen(function* () {
    launches.push([...args]);
    const queue = yield* Queue.make<string, Cause.Done>();
    Queue.offerUnsafe(queue, JSON.stringify({ type: "remark", track: "相手", start: 0, end: 1, text: "面接官は3人です。" }));
    const ended = yield* Deferred.make<HelperExitInfo>();
    const stop = Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(ended, { code: null, signal: "SIGTERM" })));
    yield* Effect.addFinalizer(() => stop);
    return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(ended), stderrTail: Effect.succeed([]) };
  }) }));
  return { layer, launches };
};
const verifyMap = (dir: string) => {
  const events = readFileSync(join(dir, LOG_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events[0]).toMatchObject({ type: "start", model: { name: "apple", route: "apple", local: true } });
  const map = Schema.decodeUnknownSync(JsonExport)(JSON.parse(readFileSync(join(dir, EXPORT_FILE), "utf8")));
  expect(map.root.children.length).toBeGreaterThan(0);
  expect(readFileSync(join(dir, "map.md"), "utf8")).toContain("面接官は3人");
};

describe("apple を使う開始・再生の配線", () => {
  it.live("play --model apple は内蔵の推論先で複数回更新し、Apple の開始ログとマップを書き出して子を閉じる", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const process = yield* appleProcess();
    const stdout: string[] = [];
    listener.modes.length = 0;
    const layer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, process.layer, fakeExportServices(), fakeScreenJpeg().layer,
      environment(root, 0), Layer.succeed(Console.Console, { ...console, log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); } }));
    yield* runCli(["play", join(import.meta.dirname, "fixtures/short.transcript.json"), "--model", "apple"]).pipe(Effect.provide(layer));
    verifyMap(dirname(stdout.join("\n").trim().split("\n")[0]!));
    expect(process.state).toMatchObject({ opened: 1, closed: 1 });
    expect(process.requests.length).toBeGreaterThan(1);
    expect(process.requests.every((request) => request.url === "/v1/chat/completions" && request.alive)).toBe(true);
    expect(listener.modes).toEqual([{ type: "session-mode", local: true }, { type: "session-mode", local: false }]);
  }));

  it.live("HTTP の Apple 開始は現在の利用可否を確かめ、拒否後の正常開始では終了の更新まで子を保つ", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const process = yield* appleProcess();
    const helper = audioHelper();
    const sinks = SessionSinks.layer({ prepareUpdater: prepareUpdaterLayer }).pipe(
      Layer.provide(Layer.mergeAll(fakeExportServices(), NodeHttpClient.layerUndici, process.layer)),
    );
    const server = yield* startedServer({ port: 0, sessionsDir: join(root, "sessions") }, { helpers: helper.layer, sessionSinks: sinks, managedDeps: forbiddenManagedDeps });
    const start = () => Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/session/start`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: "us.zoom.xos", audio: false, screen: false, model: { name: "apple", route: "apple", local: true } }),
    }));
    process.state.available = false;
    const denied = yield* start();
    expect(denied.status).toBe(503);
    const refusal = (yield* Effect.tryPromise(() => denied.json())) as { error: string };
    expect(refusal.error.split("\n")).toHaveLength(2);
    expect(refusal.error).toContain("準備中");
    expect(helper.launches).toEqual([]);
    expect(existsSync(join(root, "sessions"))).toBe(false);
    expect(process.requests).toEqual([]);
    process.state.available = true;
    const stdout: string[] = [];
    yield* runCli(["start", "--app", "us.zoom.xos", "--no-audio", "--model", "apple"]).pipe(Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, process.layer, fakeExportServices(), fakeScreenJpeg().layer, environment(root, server.port),
        Layer.succeed(Console.Console, { ...console, log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); } })),
    ));
    expect(helper.launches).toHaveLength(1);
    expect(process.state).toMatchObject({ opened: 1, closed: 0 });
    const stop = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/session/stop`, { method: "POST" }));
    expect(stop.status).toBe(200);
    const directories = readdirSync(join(root, "sessions"));
    expect(directories).toHaveLength(1);
    expect(stdout.join("\n").trim()).toBe(join(root, "sessions", directories[0]!));
    verifyMap(join(root, "sessions", directories[0]!));
    expect(process.requests.length).toBeGreaterThan(1);
    expect(process.requests.every((request) => request.alive)).toBe(true);
    expect(process.state).toMatchObject({ opened: 1, closed: 1 });
  }));

  it.live("eval --model apple は再生の Scope で子を所有し、最後の更新と書き出しの後に閉じる", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const process = yield* appleProcess();
    const stdout: string[] = [];
    const layer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, process.layer, fakeExportServices(), fakeScreenJpeg().layer,
      environment(root, 0), Layer.succeed(Console.Console, { ...console, log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); } }));
    yield* runCli(["play", join(import.meta.dirname, "fixtures/short.transcript.json"), "--model", "apple"]).pipe(Effect.provide(layer));
    const source = dirname(stdout.join("\n").trim().split("\n")[0]!);
    expect(process.state).toMatchObject({ opened: 1, closed: 1 });
    const previousRequests = process.requests.length;
    stdout.length = 0;
    yield* runCli(["eval", source, "--model", "apple"]).pipe(Effect.provide(layer));
    expect(stdout.join("\n")).toContain("| ラン | 会議 |");
    expect(process.state).toMatchObject({ opened: 2, closed: 2 });
    expect(process.requests.length).toBeGreaterThan(previousRequests);
    expect(process.requests.slice(previousRequests).every((request) => request.alive)).toBe(true);
    const replayed = readdirSync(join(root, "sessions")).map((dir) => join(root, "sessions", dir)).filter((dir) => dir !== source);
    expect(replayed).toHaveLength(1);
    verifyMap(replayed[0]!);
  }));
});
