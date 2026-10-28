import { StartupChecks } from "../src/startupChecks.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { NodeHttpClient } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { vi } from "vitest";
import { ManagedDeps, ManagedDepsFailed, type DepEvent } from "../src/managedDeps.ts";
import { Helpers, type HelperLaunchOptions, type HelperExitInfo } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { planLayer } from "../src/updatePlan.ts";
import { realLayers, type ServerOptions } from "../src/server.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { helperChecks } from "./fixtures/helperCheck.ts";
import { managedLayer, temporaryDeps } from "./fixtures/managedDeps.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";

const sdkSource = (control: string) => `
import { appendFileSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const entity = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const query = ({ prompt }) => Object.assign((async function* () {
  for await (const message of prompt) {
    if (message.type !== 'user') throw new Error('expected SDKUserMessage');
    appendFileSync(${JSON.stringify(join(control, "sdk-calls.jsonl"))}, JSON.stringify({ entity: basename(entity), present: existsSync(entity) }) + '\\n');
    yield { type: 'result', subtype: 'success', structured_output: { ops: [{ op: 'noop', reason: 'synthetic response' }] } };
  }
})(), { close: () => {} });
`;

const oldSdk = async (root: string, control: string) => {
  const name = "0.0.0-00000000-0000-4000-8000-000000000001";
  const dir = join(root, "claude", name);
  const pkg = join(dir, "node_modules/@anthropic-ai/claude-agent-sdk");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(dir, "package.json"), '{"private":true,"type":"module"}');
  await writeFile(join(dir, ".ready.json"), JSON.stringify({ version: "0.0.0", installedAt: "2026-01-01T00:00:00Z", hashes: {} }));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0", type: "module", exports: { ".": "./sdk.mjs" } }));
  await writeFile(join(pkg, "sdk.mjs"), sdkSource(control));
  await symlink(name, join(root, "claude/current"));
  return await realpath(dir);
};

const fakeInstaller = Effect.fnUntraced(function* (dir: string) {
  const script = join(dir, "sdk-npm.cjs");
  yield* Effect.tryPromise(() => writeFile(script, `
const fs = require('node:fs');
const path = require('node:path');
const name = '@anthropic-ai/claude-agent-sdk';
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies[name];
const pkg = path.join('node_modules', name);
fs.mkdirSync(pkg, {recursive: true});
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name, version, type: 'module', exports: {'.': './sdk.mjs'}}));
fs.writeFileSync(path.join(pkg, 'sdk.mjs'), ${JSON.stringify(sdkSource(dir))});
const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
const binaryName = name + '-' + process.platform + '-' + process.arch + (musl ? '-musl' : '');
const binary = path.join('node_modules', binaryName);
fs.mkdirSync(binary, {recursive: true});
fs.writeFileSync(path.join(binary, 'package.json'), JSON.stringify({name: binaryName, version}));
fs.writeFileSync(path.join(binary, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'synthetic binary', {mode: 0o755});
`));
  return { command: process.execPath, args: [script] };
});

const helperLayer = (launches: HelperLaunchOptions[], beforeLaunch: Effect.Effect<void>) => Layer.succeed(Helpers, Helpers.of({
  ...helperChecks(),
  apps: Effect.succeed([]),
  launch: (args) => Effect.gen(function* () {
    launches.push(args);
    yield* beforeLaunch;
    const queue = yield* Queue.unbounded<string, Cause.Done>();
    const exit = yield* Deferred.make<HelperExitInfo>();
    yield* Queue.offer(queue, JSON.stringify({ type: "speaker-off", start: 0, reason: "モデルなし" })); // 相手の発言は話者の確定を待つので、話者分離を使えない helper にして待たせない（Issue #1021）
    yield* Queue.offer(queue, JSON.stringify({ type: "remark", track: "相手", start: 0, end: 1, text: "合成の発言" }));
    const stop = Effect.andThen(Queue.end(queue), Deferred.succeed(exit, { code: 0, signal: null })).pipe(Effect.asVoid);
    yield* Effect.addFinalizer(() => stop);
    return { events: Stream.fromQueue(queue), stop, exit: Deferred.await(exit), stderrTail: Effect.succeed([]), send: () => Effect.void };
  }),
}));

const request = (port: number, path: string, body: unknown) => Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const start = (port: number) => request(port, "/session/start", { app: "synthetic.app", audio: false, screen: false });
const stop = (port: number) => request(port, "/session/stop", {});
const status = (port: number) => Effect.tryPromise(async () => (await fetch(`http://127.0.0.1:${port}/session/status`)).json());
const accepted = (response: Response) => Effect.gen(function* () {
  expect(response.status).toBe(200);
  return yield* Effect.tryPromise(() => response.json());
});
const rejected = (response: Response) => Effect.gen(function* () {
  const body = yield* Effect.tryPromise(() => response.text());
  if (response.ok) {
    const events = body.trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.some((event) => event.type === "result")).toBe(false);
  } else {
    expect(JSON.parse(body)).toMatchObject({ error: expect.any(String) });
  }
});

const sessionServer = Effect.fnUntraced(function* (dir: string, deps: ManagedDeps["Service"], launches: HelperLaunchOptions[], beforeLaunch: Effect.Effect<void>) {
  return yield* startedServer({ port: 0, sessionsDir: join(dir, "sessions") }, {
    managedDeps: Layer.succeed(ManagedDeps, deps),
    helpers: helperLayer(launches, beforeLaunch),
    sessionSinks: SessionSinks.layer.pipe(Layer.provide(fakeExportServices())), startupChecks: StartupChecks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) }).pipe(Layer.provide(fakeExportServices())),
  });
});
const fakeDeps = (source: Stream.Stream<DepEvent, ManagedDepsFailed>, calls: string[]) => ManagedDeps.of({
  executable: () => Effect.die("実行ファイル取得は対象外"),
  check: () => Effect.succeed([{ name: "claude", need: "optional", state: "ready" }]),
  load: () => Effect.die("偽 updater は SDK を読まない"),
  install: () => Stream.concat(Stream.fromEffect(Effect.sync(() => { calls.push("install"); return { type: "progress" as const, message: "started" }; })), source),
  update: () => Stream.concat(Stream.fromEffect(Effect.sync(() => { calls.push("update"); return { type: "progress" as const, message: "started" }; })), source),
});
const result = { type: "result", items: [{ name: "claude", need: "optional", state: "ready" }] } as const;

describe("712: セッションと管理実体の寿命", () => {
  it.live("同じサーバーの更新後のセッションは新 SDK を使い、旧 SDK は次の実サーバー起動で消える", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const old = yield* Effect.tryPromise(() => oldSdk(root, dir));
    const npm = yield* fakeInstaller(dir);
    const launches: HelperLaunchOptions[] = [];
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const server = yield* startedServer({ port: 0, sessionsDir: join(dir, "sessions") }, {
        managedDeps: Layer.succeed(ManagedDeps, deps),
        helpers: helperLayer(launches, Effect.void),
        sessionSinks: SessionSinks.layer.pipe(Layer.provide(Layer.mergeAll(fakeExportServices(), Layer.succeed(ManagedDeps, deps), unusedApple, NodeHttpClient.layerUndici))), startupChecks: StartupChecks.layer({ prepareUpdater: planLayer }).pipe(Layer.provide(Layer.mergeAll(fakeExportServices(), Layer.succeed(ManagedDeps, deps), unusedApple, NodeHttpClient.layerUndici))),
      });
      const first = yield* accepted(yield* start(server.port));
      yield* accepted(yield* stop(server.port));
      const calls = () => readFile(join(dir, "sdk-calls.jsonl"), "utf8").then((text) => text.trim().split("\n").map((line) => JSON.parse(line) as { entity: string; present: boolean }));
      expect(yield* Effect.tryPromise(calls)).toEqual([{ entity: basename(old), present: true }]);
      const update = yield* request(server.port, "/update", { names: ["claude"] });
      expect(update.status).toBe(200);
      const events = (yield* Effect.tryPromise(() => update.text())).trim().split("\n").map((line) => JSON.parse(line));
      expect(events.at(-1)).toEqual(result);
      const current = yield* Effect.tryPromise(() => realpath(join(root, "claude/current")));
      expect(current).not.toBe(old);
      const second = yield* accepted(yield* start(server.port));
      expect(yield* status(server.port)).toMatchObject({ status: "running", dir: second.dir });
      yield* accepted(yield* stop(server.port));
      expect(yield* Effect.tryPromise(calls)).toEqual([{ entity: basename(old), present: true }, { entity: basename(current), present: true }]);
      expect(existsSync(old)).toBe(true);
      expect(existsSync(current)).toBe(true);
      expect(existsSync(join(first.dir, "map.json"))).toBe(true);
      yield* server.close;
      const options: ServerOptions = { port: 0, sessionsDir: join(dir, "sessions"), depsDir: root, helper: { command: process.execPath, args: [] }, prepareUpdater: planLayer };
      const restarted = yield* startedServer(options, realLayers(options, fakeExportServices()));
      expect(yield* status(restarted.port)).toEqual({ status: "none" });
      expect.soft(existsSync(current)).toBe(true);
      expect.soft(existsSync(join(first.dir, "map.json"))).toBe(true);
      expect(existsSync(old)).toBe(false);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live.each(["/deps/install", "/update"])("会議成立後の %s は導入を開始せず、停止後には同じ入口が動く", (path) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const calls: string[] = [];
    const launches: HelperLaunchOptions[] = [];
    const server = yield* sessionServer(dir, fakeDeps(Stream.succeed(result), calls), launches, Effect.void);
    yield* accepted(yield* start(server.port));
    expect(yield* status(server.port)).toMatchObject({ status: "running" });
    const denied = yield* request(server.port, path, { names: ["claude"] });
    expect.soft(calls).toEqual([]);
    yield* rejected(denied);
    yield* accepted(yield* stop(server.port));
    const allowed = yield* request(server.port, path, { names: ["claude"] });
    expect(allowed.status).toBe(200);
    expect(JSON.parse((yield* Effect.tryPromise(() => allowed.text())).trim().split("\n").at(-1)!)).toEqual(result);
    expect(calls).toEqual([path === "/update" ? "update" : "install"]);
  }).pipe(Effect.scoped));

  it.live("stop の書き出し待ち中も導入を開始しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const calls: string[] = [];
    const launches: HelperLaunchOptions[] = [];
    const server = yield* startedServer({ port: 0, sessionsDir: join(dir, "sessions") }, {
      managedDeps: Layer.succeed(ManagedDeps, fakeDeps(Stream.succeed(result), calls)),
      helpers: helperLayer(launches, Effect.void),
      sessionSinks: SessionSinks.layer.pipe(Layer.provide(fakeExportServices({ capture: () => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)) }))), startupChecks: StartupChecks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) }).pipe(Layer.provide(fakeExportServices({ capture: () => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)) }))),
    });
    yield* accepted(yield* start(server.port));
    const stopping = yield* stop(server.port).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    try {
      expect(yield* status(server.port)).toEqual({ status: "none" });
      for (const path of ["/deps/install", "/update"]) yield* rejected(yield* request(server.port, path, { names: ["claude"] }));
      expect(calls).toEqual([]);
    } finally {
      yield* Deferred.succeed(release, undefined);
    }
    yield* accepted(yield* Fiber.join(stopping));
  }).pipe(Effect.scoped));

  it.live("start の接続待ち中も導入を拒否する（公開 status が none でも導入しない）", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const release = yield* Deferred.make<void>();
    const launches: HelperLaunchOptions[] = [];
    const calls: string[] = [];
    const server = yield* sessionServer(dir, fakeDeps(Stream.succeed(result), calls), launches, Deferred.await(release));
    const starting = yield* start(server.port).pipe(Effect.forkChild);
    try {
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(launches).toHaveLength(1)));
      expect(yield* status(server.port)).toEqual({ status: "none" });
      for (const path of ["/deps/install", "/update"]) {
        const response = yield* request(server.port, path, { names: ["claude"] });
        yield* rejected(response);
      }
      expect(calls).toEqual([]);
    } finally {
      yield* Deferred.succeed(release, undefined);
    }
    yield* accepted(yield* Fiber.join(starting));
    yield* accepted(yield* stop(server.port));
  }).pipe(Effect.scoped));

  it.live.each(["success", "failure", "disconnect"] as const)("導入ストリームの %s まで新規 start を拒否し、後片付け後は開始できる", (ending) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const cleaned = yield* Deferred.make<void>();
    const calls: string[] = [];
    const launches: HelperLaunchOptions[] = [];
    const source = Stream.unwrap(Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.void, () => Deferred.succeed(cleaned, undefined));
      yield* Deferred.succeed(entered, undefined);
      return Stream.fromEffect(Deferred.await(release).pipe(Effect.flatMap(() => ending === "failure" ? Effect.fail(new ManagedDepsFailed({ message: "synthetic install failed" })) : Effect.succeed(result))));
    }));
    const server = yield* sessionServer(dir, fakeDeps(source, calls), launches, Effect.void);
    const controller = new AbortController();
    const installing = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/deps/install`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"names":["claude"]}', signal: controller.signal }));
    yield* Deferred.await(entered);
    try {
      const blocked = yield* start(server.port);
      yield* rejected(blocked);
      expect(launches).toEqual([]);
      expect(calls).toEqual(["install"]);
    } finally {
      if (ending === "disconnect") controller.abort();
      else yield* Deferred.succeed(release, undefined);
    }
    if (ending !== "disconnect") {
      const events = (yield* Effect.tryPromise(() => installing.text())).trim().split("\n").map((line) => JSON.parse(line));
      expect(events.at(-1)?.type).toBe(ending === "failure" ? "error" : "result");
    }
    yield* Deferred.await(cleaned);
    yield* accepted(yield* start(server.port));
    expect(launches).toHaveLength(1);
    yield* accepted(yield* stop(server.port));
  }).pipe(Effect.scoped));
});
