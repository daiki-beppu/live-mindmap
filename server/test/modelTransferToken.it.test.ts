import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { Helpers } from "../src/helpers.ts";
import { modelTransferTokenPath } from "../src/modelTransferToken.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";

const directory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-transfer-token-"))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);
const layers = {
  helpers: Layer.succeed(Helpers, Helpers.of({ apps: Effect.succeed([]), launch: () => Effect.die("このテストでは会議を開始しない") })),
  sessionSinks: SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer(() => Effect.succeed({ ops: [] }))) }).pipe(Layer.provide(fakeExportServices())),
  managedDeps: forbiddenManagedDeps,
};

describe("モデル転送トークンのサーバー Scope", () => {
  it.live("実ポート別のファイルを起動通知前に0700/0600で公開し、終了時に削除する", () => Effect.gen(function* () {
    const root = yield* directory;
    const sessionsDir = join(root, "sessions");
    const published: string[] = [];
    const server = yield* startedServer({ port: 0, sessionsDir, onListening: (port) => {
      const path = modelTransferTokenPath(sessionsDir, port);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      published.push(readFileSync(path, "utf8"));
    } }, layers);
    const second = yield* startedServer({ port: 0, sessionsDir }, layers);
    const path = modelTransferTokenPath(sessionsDir, server.port);
    const secondPath = modelTransferTokenPath(sessionsDir, second.port);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(secondPath, "utf8")).not.toBe(published[0]);
    expect(existsSync(sessionsDir)).toBe(false);
    yield* server.close;
    expect(existsSync(path)).toBe(false);
    expect(existsSync(secondPath)).toBe(true);
    yield* second.close;
    expect(existsSync(secondPath)).toBe(false);
  }));

  it.live("別の起動が所有する値で置換されたファイルは終了時に削除しない", () => Effect.gen(function* () {
    const root = yield* directory;
    const sessionsDir = join(root, "sessions");
    const server = yield* startedServer({ port: 0, sessionsDir }, layers);
    const path = modelTransferTokenPath(sessionsDir, server.port);
    writeFileSync(path, "another-startup-token");
    yield* server.close;
    expect(readFileSync(path, "utf8")).toBe("another-startup-token");
  }));

  it.live("公開失敗では起動成功を通知せず、原因を取り除けば起動できる", () => Effect.gen(function* () {
    const root = yield* directory;
    const sessionsDir = join(root, "sessions");
    const blocked = dirname(modelTransferTokenPath(sessionsDir, 0));
    writeFileSync(blocked, "not a directory");
    const notifications: number[] = [];
    const options = { port: 0, sessionsDir, onListening: (port: number) => { notifications.push(port); } };
    const failed = yield* Effect.result(Effect.scoped(startedServer(options, layers)));
    expect(Result.isFailure(failed)).toBe(true);
    expect(notifications).toEqual([]);
    unlinkSync(blocked);
    const server = yield* startedServer(options, layers);
    expect(notifications).toEqual([server.port]);
    expect(existsSync(modelTransferTokenPath(sessionsDir, server.port))).toBe(true);
    yield* server.close;
  }));
});
