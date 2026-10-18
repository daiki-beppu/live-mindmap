import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Helpers } from "../src/helpers.ts";
import { serverPidPath, ServerProcess } from "../src/serverProcess.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { forbiddenHelperChecks } from "./fixtures/helperCheck.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { directory, serverStop, unusedPort, writePid } from "./fixtures/serverStop.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";

const serverLayers = {
  helpers: Layer.succeed(Helpers, Helpers.of({ ...forbiddenHelperChecks, apps: Effect.succeed([]), launch: () => Effect.die("このテストでは会議を開始しない") })),
  sessionSinks: SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) }).pipe(Layer.provide(fakeExportServices())),
  managedDeps: readyManagedDeps,
};

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
