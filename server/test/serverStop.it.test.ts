import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Console, Effect, Exit, Layer } from "effect";
import { runCli } from "../src/cli.ts";
import { Helpers } from "../src/helpers.ts";
import { serverPidPath, ServerProcess } from "../src/serverProcess.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { forbiddenHelperChecks } from "./fixtures/helperCheck.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";

const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-server-stop-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

const serverLayers = {
  helpers: Layer.succeed(Helpers, Helpers.of({ ...forbiddenHelperChecks, apps: Effect.succeed([]), launch: () => Effect.die("このテストでは会議を開始しない") })),
  sessionSinks: SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) }).pipe(Layer.provide(fakeExportServices())),
  managedDeps: readyManagedDeps,
};

// cli server stop を同じプロセスで走らせ、標準出力・標準エラー・失敗したかを返す
const serverStop = (sessionsDir: string, port: number) => Effect.gen(function* () {
  const out: string[] = [];
  const err: string[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { out.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { err.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(forbiddenManagedDeps, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
    Layer.succeed(Console.Console, consoleService),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_SESSIONS: sessionsDir })));
  const exit = yield* Effect.exit(runCli(["server", "stop"]).pipe(Effect.provide(layer)));
  const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
  return { out: out.join(""), failed: Exit.isFailure(exit), message: failure instanceof Error ? failure.message : String(failure) };
});

// 何も待ち受けていないポート（いったん待ち受けて閉じる）
const unusedPort = Effect.tryPromise(() => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("TCP の待受けがありません")));
  });
}));

// サーバーではない、生きている子プロセス（記録の PID が使い回された状態の再現）。テストの終わりに PID を名指しで止める
const bystander = Effect.acquireRelease(
  Effect.sync(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })),
  (child) => Effect.promise(() => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("close", () => resolve());
    child.kill("SIGKILL");
  })),
);

const writePid = (sessionsDir: string, port: number, pid: number) => Effect.promise(async () => {
  const path = serverPidPath(sessionsDir, port);
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`);
  return path;
});

describe("サーバーの PID の記録", () => {
  it.live("待ち受けたポートごとに自分の PID を書き、終了時に消す。別の起動が書き換えた記録は消さない", () => Effect.gen(function* () {
    const sessionsDir = join(yield* directory, "sessions");
    const server = yield* startedServer({ port: 0, sessionsDir }, serverLayers);
    const second = yield* startedServer({ port: 0, sessionsDir }, serverLayers);
    const path = serverPidPath(sessionsDir, server.port);
    expect(readFileSync(path, "utf8")).toBe(`${process.pid}\n`);
    yield* server.close;
    expect(existsSync(path)).toBe(false);
    const secondPath = serverPidPath(sessionsDir, second.port);
    writeFileSync(secondPath, "999999\n");
    yield* second.close;
    expect(readFileSync(secondPath, "utf8")).toBe("999999\n");
  }).pipe(Effect.scoped));
});

describe("cli server stop", () => {
  it.live("応答したサーバーが名乗った PID に SIGTERM を送り、終わるのを待って止めたことを出す", () => Effect.gen(function* () {
    const sessionsDir = join(yield* directory, "sessions");
    const server = yield* startedServer({ port: 0, sessionsDir }, serverLayers);
    const signalled: number[] = [];
    let alive = true;
    const result = yield* serverStop(sessionsDir, server.port).pipe(Effect.provideService(ServerProcess, {
      alive: () => Effect.sync(() => alive),
      terminate: (pid) => Effect.sync(() => { signalled.push(pid); }).pipe(Effect.andThen(server.close), Effect.andThen(Effect.sync(() => { alive = false; }))),
    }));
    expect(result.failed).toBe(false);
    expect(signalled).toEqual([process.pid]);
    expect(result.out).toBe(`サーバーを止めました（ポート ${server.port}、pid ${process.pid}）\n`);
    expect(existsSync(serverPidPath(sessionsDir, server.port))).toBe(false);
  }).pipe(Effect.scoped));

  it.live("セッションが進行中なら断り、シグナルを送らない", () => Effect.gen(function* () {
    const sessionsDir = join(yield* directory, "sessions");
    const server = yield* Effect.acquireRelease(Effect.tryPromise(() => new Promise<Server>((resolve, reject) => {
      const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(request.url === "/server" ? { pid: 424242 } : { status: "running", dir: "/tmp/x" }));
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    })), (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("TCP の待受けがありません");
    const signalled: number[] = [];
    const result = yield* serverStop(sessionsDir, address.port).pipe(Effect.provideService(ServerProcess, {
      alive: () => Effect.succeed(true),
      terminate: (pid) => Effect.sync(() => { signalled.push(pid); }),
    }));
    expect(result.failed).toBe(true);
    expect(result.message).toContain("セッションが進行中です。先に cli stop で書き出してから");
    expect(signalled).toEqual([]);
  }).pipe(Effect.scoped));

  // 2026-10-13 に pkill で関係の無いプロセスまで止めた。記録の PID が別のプロセスに使い回されていても、応答の無いポートの記録だけでは送らない
  it.live("応答が無く、記録の PID のプロセスが生きているなら、本物の ServerProcess でもシグナルを送らずに断り、記録を残す", () => Effect.gen(function* () {
    const sessionsDir = join(yield* directory, "sessions");
    const port = yield* unusedPort;
    const child = yield* bystander;
    const pid = child.pid!;
    const path = yield* writePid(sessionsDir, port, pid);
    const result = yield* serverStop(sessionsDir, port);
    expect(result.failed).toBe(true);
    expect(result.message).toContain(`記録の pid ${pid} が live-mindmap のサーバーか確かめてから`);
    // 送っていない: 少し待っても生きている
    yield* Effect.sleep(200);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(existsSync(path)).toBe(true);
  }).pipe(Effect.scoped));

  it.live("応答が無く、記録の PID のプロセスがもう無いなら、古い記録を消して動いていないと出す", () => Effect.gen(function* () {
    const sessionsDir = join(yield* directory, "sessions");
    const port = yield* unusedPort;
    const path = yield* writePid(sessionsDir, port, 424242);
    const result = yield* serverStop(sessionsDir, port).pipe(Effect.provideService(ServerProcess, {
      alive: () => Effect.succeed(false),
      terminate: () => Effect.die("シグナルは送らない"),
    }));
    expect(result.failed).toBe(false);
    expect(result.out).toBe(`ポート ${port} のサーバーは動いていません\n`);
    expect(existsSync(path)).toBe(false);
  }).pipe(Effect.scoped));
});
