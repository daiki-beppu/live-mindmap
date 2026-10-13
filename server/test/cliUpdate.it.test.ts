import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { forbiddenHelperChecks } from "./fixtures/helperCheck.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { StdoutIsTty } from "../src/consoleText.ts";
import { ManagedDeps, ManagedDepsFailed, type DepItem, type DepEvent } from "../src/managedDeps.ts";
import { Helpers } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { installed, temporaryDeps } from "./fixtures/managedDeps.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";

const serverWith = Effect.fnUntraced(function* (dir: string, deps: ManagedDeps["Service"]) {
  return yield* startedServer({ port: 0, sessionsDir: join(dir, "sessions") }, {
    helpers: Layer.succeed(Helpers, Helpers.of({ ...forbiddenHelperChecks, apps: Effect.die("apps は対象外"), launch: () => Effect.die("launch は対象外") })),
    sessionSinks: SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer(() => Effect.succeed({ ops: [] }))) }).pipe(Layer.provide(fakeExportServices())),
    managedDeps: Layer.succeed(ManagedDeps, deps),
  });
});

const cliProcess = (dir: string, port: number, names: string[]) => Effect.tryPromise(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
  execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), "update", ...names], {
    cwd: join(import.meta.dirname, "../.."),
    timeout: 15_000,
    env: { ...process.env, HOME: join(dir, "home"), LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_DEPS: join(dir, "deps"), LIVE_MINDMAP_SESSIONS: join(dir, "sessions"), LIVE_MINDMAP_CONFIG: join(dir, "absent.config.json"), LIVE_MINDMAP_MODEL: "", NO_COLOR: "1" },
  }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== "number")) return reject(error);
    resolve({ code: error ? error.code as number : 0, stdout, stderr });
  });
}));

const outdated = { ...installed, state: "outdated", version: "0.0.0" } as const;
const claudeMissing = { name: "claude", need: "optional", state: "missing" } as const;
const claudeOutdated = { ...claudeMissing, state: "outdated", version: "0.0.1" } as const;

const fakeDeps = (items: ReadonlyArray<DepItem>, events: Stream.Stream<DepEvent, ManagedDepsFailed> = Stream.succeed({ type: "result" as const, items: [installed] })) => {
  const check = vi.fn((names: ReadonlyArray<string>) => Effect.succeed(items.filter((item) => names.includes(item.name))));
  const update = vi.fn((_names: ReadonlyArray<string>) => events);
  const service = {
    executable: () => Effect.die("実行ファイル取得は対象外"),
    check, update,
    install: () => Stream.die("update は install の入口を使わない"),
    load: () => Effect.die("update は読込を行わない"),
  };
  return { service: ManagedDeps.of(service), check, update };
};

describe("711-4・711-5・711-6: CLI update", () => {
  it.live.each([
    '{"type":"progress","message":"ダウンロード"}\n',
    '{"type":"unexpected"}\n',
    'not-json\n',
  ])("不完全または不正な更新ストリーム %s を成功終了にしない", (body) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const requests: string[] = [];
    const server = yield* Effect.acquireRelease(Effect.tryPromise(() => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const server = createServer((request, response) => {
        const path = new URL(request.url!, "http://localhost").pathname;
        requests.push(`${request.method} ${path}`);
        if (path === "/deps/check") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([outdated]));
        } else if (path === "/update") {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.end(body);
        } else {
          response.writeHead(404);
          response.end();
        }
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    })), (server) => Effect.promise(() => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("TCP の待受けがありません");
    const result = yield* cliProcess(dir, address.port, ["chromium"]);
    expect(requests).toEqual(["GET /deps/check", "POST /update"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  }).pipe(Effect.scoped));
  it.live.each<{ names: string[]; items: ReadonlyArray<DepItem>; updated: string[] }>([
    { names: [], items: [outdated, claudeMissing], updated: ["chromium"] },
    { names: ["chromium"], items: [outdated, claudeOutdated], updated: ["chromium"] },
    { names: [], items: [outdated, claudeOutdated], updated: ["chromium", "claude"] },
    { names: ["chromium"], items: [installed, claudeOutdated], updated: [] },
  ])("指定 $names は版違い $updated だけをサーバーへ依頼する", ({ names, items, updated }) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const results = items.filter((item) => updated.includes(item.name)).map((item) => ({ name: item.name, need: "optional" as const, state: "ready" as const }));
    const deps = fakeDeps(items, Stream.succeed({ type: "result", items: results }));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, names);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(results);
    expect(deps.update.mock.calls).toEqual(updated.length === 0 ? [] : [[updated]]);
  }).pipe(Effect.scoped));

  it.live("未導入を明示指定したら案内と exit 1 を返し、一部だけ更新しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps([outdated, claudeMissing]);
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, ["chromium", "claude"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/未導入です。.*cli install claude.*で入れる/);
    expect(result.stdout).toBe("");
    expect(deps.check).toHaveBeenCalled();
    expect(deps.update).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.live("speech-ja 単独はサーバー不要で一行を出して exit 0", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const result = yield* cliProcess(dir, 0, ["speech-ja"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("OS が更新するので不要\n");
    expect(yield* Effect.tryPromise(() => readdir(dir))).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("speech-ja 混在では管理依存を更新し、speech-ja をサービスへ渡さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps([outdated]);
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, ["speech-ja", "chromium"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([installed]);
    expect(result.stderr.split("\n").filter((line) => line === "OS が更新するので不要")).toHaveLength(1);
    expect(deps.update.mock.calls).toEqual([[["chromium"]]]);
    expect(deps.check.mock.calls.flat(2)).not.toContain("speech-ja");
  }).pipe(Effect.scoped));

  it.live("進捗を stderr へ出し、完了まで stdout と終了を保留する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const release = yield* Deferred.make<void>();
    const deps = fakeDeps([outdated], Stream.concat(
      Stream.succeed({ type: "progress" as const, message: "ダウンロード" }),
      Stream.fromEffect(Deferred.await(release).pipe(Effect.as({ type: "result" as const, items: [installed] }))),
    ));
    const server = yield* serverWith(dir, deps.service);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let ended = false;
    const consoleService: Console.Console = { ...console, log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); }, error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); } };
    const layer = Layer.mergeAll(forbiddenManagedDeps, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
      Layer.succeed(Console.Console, consoleService), ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: join(dir, "home"), LIVE_MINDMAP_CONFIG: join(dir, "absent.config.json"), LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_SESSIONS: dir })));
    const fiber = yield* runCli(["update", "chromium"]).pipe(Effect.provide(layer), Effect.provideService(StdoutIsTty, false), Effect.tap(() => Effect.sync(() => { ended = true; })), Effect.forkChild);
    try {
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(stderr.join("")).toContain("ダウンロード\n")));
      expect(deps.update.mock.calls).toEqual([[["chromium"]]]);
      expect(stderr.join("")).toContain("時間がかかるので run_in_background で呼んでよい");
      expect(stdout).toEqual([]);
      expect(ended).toBe(false);
    } finally {
      yield* Deferred.succeed(release, undefined);
    }
    yield* Fiber.join(fiber);
    expect(JSON.parse(stdout.join(""))).toEqual([installed]);
    expect(ended).toBe(true);
  }).pipe(Effect.scoped));

  it.live("進捗後の更新失敗を exit 1 にし、成功 items を出さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps([outdated], Stream.concat(Stream.succeed({ type: "progress" as const, message: "ダウンロード" }), Stream.fail(new ManagedDepsFailed({ message: "更新に失敗しました" }))));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, ["chromium"]);
    expect(deps.update).toHaveBeenCalledExactlyOnceWith(["chromium"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ダウンロード\n");
    expect(result.stderr).toContain("更新に失敗しました\n");
    expect(result.stdout).toBe("");
  }).pipe(Effect.scoped));

  it.live("サーバー接続不能は指定文面と exit 1 を返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const result = yield* cliProcess(dir, 0, ["chromium"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("サーバーにつながりません（pnpm dev で起動）\n");
    expect(result.stdout).toBe("");
    expect(yield* Effect.tryPromise(() => readdir(dir))).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("POST /update は管理依存へ委譲し、不正 Origin と不正入力を処理前に拒否する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps([outdated]);
    const server = yield* serverWith(dir, deps.service);
    const request = (names: string[], origin: string) => Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/update`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ names }),
    }));
    const response = yield* request(["chromium"], "http://localhost");
    expect(response.status).toBe(200);
    expect(JSON.parse((yield* Effect.tryPromise(() => response.text())).trim())).toEqual({ type: "result", items: [installed] });
    expect(deps.update).toHaveBeenCalledExactlyOnceWith(["chromium"]);
    for (const input of [
      { names: ["chromium"], origin: "https://example.com", status: 403 },
      { names: ["speech-ja"], origin: "http://localhost", status: 400 },
      { names: ["unknown"], origin: "http://localhost", status: 400 },
      { names: [], origin: "http://localhost", status: 400 },
    ]) {
      const rejected = yield* request(input.names, input.origin);
      expect(rejected.status).toBe(input.status);
      expect(yield* Effect.tryPromise(() => rejected.json())).toMatchObject({ error: expect.any(String) });
      expect(deps.update).toHaveBeenCalledExactlyOnceWith(["chromium"]);
    }
  }).pipe(Effect.scoped));
});
