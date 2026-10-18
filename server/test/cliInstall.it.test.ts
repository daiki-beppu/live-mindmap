import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { forbiddenHelperChecks } from "./fixtures/helperCheck.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { execFile } from "node:child_process";
import { chmod, copyFile, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, Fiber, Layer, Result, Stream } from "effect";
import { vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { StdoutIsTty } from "../src/consoleText.ts";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import { Helpers } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { installed, temporaryDeps, fakeNpm, managedLayer, install } from "./fixtures/managedDeps.ts";
import { depsDirConfig } from "../src/config.ts";
import { realLayers } from "../src/server.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { archive, CONTENT } from "./fixtures/cloudflared.ts";

const serverWith = Effect.fnUntraced(function* (dir: string, deps: ManagedDeps["Service"]) {
  return yield* startedServer({ port: 0, sessionsDir: join(dir, "sessions") }, {
    helpers: Layer.succeed(Helpers, Helpers.of({ ...forbiddenHelperChecks, apps: Effect.die("apps は対象外"), launch: () => Effect.die("launch は対象外") })),
    sessionSinks: SessionSinks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) }).pipe(Layer.provide(fakeExportServices())),
    managedDeps: Layer.succeed(ManagedDeps, deps),
  });
});

const cliProcess = (dir: string, port: number, name: string) => Effect.tryPromise(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
  execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), "install", name], {
    cwd: join(import.meta.dirname, "../.."),
    timeout: 15_000,
    env: { ...process.env, LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_DEPS: join(dir, "deps"), LIVE_MINDMAP_SESSIONS: join(dir, "sessions"), LIVE_MINDMAP_CONFIG: join(dir, "absent.config.json"), LIVE_MINDMAP_JUDGE: "off", LIVE_MINDMAP_MODEL: "", NO_COLOR: "1" },
  }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== "number")) return reject(error);
    resolve({ code: error ? error.code as number : 0, stdout, stderr });
  });
}));

describe("CLI install とサーバー", () => {
  it.live.each(["missing binary", "non-executable binary", "hash mismatch"] as const)("ARCH-001: %s を不足として返し、同じサービスで CLI 再導入できる", (condition) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const fixture = yield* archive(dir);
    let downloads = 0;
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const item = { name: "cloudflared", need: "optional", state: "ready" } as const;
      const server = yield* serverWith(dir, deps);
      const first = yield* cliProcess(dir, server.port, "cloudflared");
      expect(first.code, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual([item]);
      expect(downloads).toBe(1);
      expect(yield* deps.check(["cloudflared"])).toEqual([item]);
      const binary = yield* deps.executable("cloudflared");
      expect(yield* Effect.tryPromise(() => readFile(binary, "utf8"))).toBe(CONTENT);
      const current = join(root, "cloudflared/current");
      const target = yield* Effect.tryPromise(() => readlink(current));
      const ready = yield* Effect.tryPromise(() => readFile(join(current, ".ready.json"), "utf8"));
      expect(JSON.parse(ready).version).toBe("2026.9.2");
      const unchanged = yield* cliProcess(dir, server.port, "cloudflared");
      expect(unchanged.code, unchanged.stderr).toBe(0);
      expect(JSON.parse(unchanged.stdout)).toEqual([]);
      expect(downloads).toBe(1);
      yield* Effect.tryPromise(async () => {
        if (condition === "missing binary") await rm(binary);
        else if (condition === "non-executable binary") await chmod(binary, 0o644);
        else await writeFile(binary, "#!/bin/sh\nexit 17\n");
      });
      expect(yield* Effect.tryPromise(() => readlink(current))).toBe(target);
      expect(yield* Effect.tryPromise(() => readFile(join(current, ".ready.json"), "utf8"))).toBe(ready);
      const rejected = yield* Effect.result(deps.executable("cloudflared"));
      expect(Result.isFailure(rejected)).toBe(true);
      if (Result.isFailure(rejected)) expect(rejected.failure).toBeInstanceOf(ManagedDepsFailed);
      const missing = [{ ...item, state: "missing" }];
      expect(yield* deps.check(["cloudflared"])).toEqual(missing);
      const checked = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/deps/check?names=cloudflared`));
      expect(checked.status).toBe(200);
      expect(yield* Effect.tryPromise(() => checked.json())).toEqual(missing);
      const repaired = yield* cliProcess(dir, server.port, "cloudflared");
      expect(repaired.code, repaired.stderr).toBe(0);
      expect(JSON.parse(repaired.stdout)).toEqual([item]);
      expect(downloads).toBe(2);
      expect(yield* deps.check(["cloudflared"])).toEqual([item]);
      const restored = yield* deps.executable("cloudflared");
      expect(yield* Effect.tryPromise(() => readFile(restored, "utf8"))).toBe(CONTENT);
      expect((yield* Effect.tryPromise(() => stat(restored))).mode & 0o777).toBe(0o755);
    }).pipe(Effect.provide(ManagedDeps.layer({ root, cloudflared: {
      resolve: Effect.succeed(fixture.artifact),
      download: (_url: string, destination: string) => Effect.tryPromise(async () => {
        downloads++;
        await copyFile(fixture.path, destination);
      }),
    } }).pipe(Layer.provide(NodeServices.layer))));
  }).pipe(Effect.scoped));
  it.live("環境設定から realLayers に渡した管理ルートを状態確認 API が使う", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const configured = join(dir, "configured-deps");
    const npm = yield* fakeNpm(dir);
    yield* install().pipe(Effect.provide(managedLayer(configured, npm)));
    const depsDir = yield* depsDirConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({
      LIVE_MINDMAP_DEPS: configured, LIVE_MINDMAP_SESSIONS: join(dir, "sessions"),
    })));
    const options = { port: 0, sessionsDir: join(dir, "sessions"), depsDir, helper: { command: process.execPath, args: [] },
      prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) };
    const server = yield* startedServer(options, realLayers(options, fakeExportServices()));
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/deps/check?names=chromium`));
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toEqual([installed]);
  }).pipe(Effect.scoped));
  it.live("標準出力が端末（人が読む）なら、エージェント向けの run_in_background の文を出さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const server = yield* serverWith(dir, ManagedDeps.of({
      executable: () => Effect.die("実行ファイル取得は対象外"),
      load: () => Effect.die("撮影は対象外"),
      check: () => Effect.succeed([installed]),
      update: () => Stream.die("更新は対象外"),
      install: () => Stream.succeed({ type: "result" as const, items: [installed] }),
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const consoleService: Console.Console = { ...console, log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); }, error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); } };
    const deps = Layer.mergeAll(forbiddenManagedDeps, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer, Layer.succeed(Console.Console, consoleService),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_SESSIONS: dir })));
    yield* runCli(["install", "chromium"]).pipe(Effect.provide(deps), Effect.provideService(StdoutIsTty, true));
    expect(JSON.parse(stdout.join(""))).toEqual([installed]);
    expect(stderr.join("")).not.toContain("run_in_background");
  }).pipe(Effect.scoped));
  it.live("偽 ManagedDeps の段階を完了前に stderr へ出し、完了まで stdout と終了を保留する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const release = yield* Deferred.make<void>();
    const requests: ReadonlyArray<string>[] = [];
    const server = yield* serverWith(dir, ManagedDeps.of({
      executable: () => Effect.die("実行ファイル取得は対象外"),
      load: () => Effect.die("撮影は対象外"),
      check: () => Effect.succeed([installed]),
      update: () => Stream.die("更新は対象外"), install: (names: ReadonlyArray<string>) => Stream.concat(
        Stream.fromEffect(Effect.sync(() => { requests.push(names); return { type: "progress" as const, message: "ダウンロード" }; })),
        Stream.fromEffect(Deferred.await(release).pipe(Effect.as({ type: "result" as const, items: [installed] }))),
      ),
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    let ended = false;
    const consoleService: Console.Console = { ...console, log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); }, error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); } };
    const deps = Layer.mergeAll(forbiddenManagedDeps, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer, Layer.succeed(Console.Console, consoleService),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_SESSIONS: dir })));
    const fiber = yield* runCli(["install", "chromium"]).pipe(Effect.provide(deps), Effect.provideService(StdoutIsTty, false), Effect.tap(() => Effect.sync(() => { ended = true; })), Effect.forkChild);
    try {
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(stderr.join("")).toContain("ダウンロード\n")));
      expect(requests).toEqual([["chromium"]]);
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

  it.live("プロセス入口から偽 ManagedDeps に届き、items と exit 0 を返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const requests: ReadonlyArray<string>[] = [];
    const server = yield* serverWith(dir, ManagedDeps.of({
      executable: () => Effect.die("実行ファイル取得は対象外"),
      load: () => Effect.die("撮影は対象外"),
      check: () => Effect.succeed([installed]),
      update: () => Stream.die("更新は対象外"), install: (names: ReadonlyArray<string>) => Stream.concat(
        Stream.fromEffect(Effect.sync(() => { requests.push(names); return { type: "progress" as const, message: "ダウンロード" }; })),
        Stream.succeed({ type: "result" as const, items: [installed] }),
      ),
    }));
    const result = yield* cliProcess(dir, server.port, "chromium");
    expect(result.code).toBe(0);
    expect(requests).toEqual([["chromium"]]);
    expect(JSON.parse(result.stdout)).toEqual([installed]);
    expect(result.stderr).toContain("ダウンロード\n");
  }).pipe(Effect.scoped));

  it.live("進捗後の ManagedDepsFailed が実 HTTP を経て指定文面と exit 1 を返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const requests: ReadonlyArray<string>[] = [];
    const server = yield* serverWith(dir, ManagedDeps.of({
      executable: () => Effect.die("実行ファイル取得は対象外"),
      load: () => Effect.die("撮影は対象外"),
      check: () => Effect.succeed([installed]),
      update: () => Stream.die("更新は対象外"), install: (names: ReadonlyArray<string>) => Stream.concat(
        Stream.fromEffect(Effect.sync(() => { requests.push(names); return { type: "progress" as const, message: "ダウンロード" }; })),
        Stream.fail(new ManagedDepsFailed({ message: "導入に失敗しました: 最終行" })),
      ),
    }));
    const result = yield* cliProcess(dir, server.port, "chromium");
    expect(requests).toEqual([["chromium"]]);
    expect(result.stderr).toContain("ダウンロード\n");
    expect(result.stderr).toContain("導入に失敗しました: 最終行\n");
    expect(result.stdout).toBe("");
    expect(result.code).toBe(1);
  }).pipe(Effect.scoped));

  it.live("サーバー接続不能では指定文面と exit 1 を返し、管理導入へフォールバックしない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const result = yield* cliProcess(dir, 0, "chromium");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("サーバーにつながりません（pnpm dev で起動）\n");
    expect(yield* Effect.tryPromise(() => readdir(dir))).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("状態確認 API は偽サービスへ委譲し、導入 API は不正 Origin と不正入力を処理前に拒否する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const calls: ReadonlyArray<string>[] = [];
    const server = yield* serverWith(dir, ManagedDeps.of({
      executable: () => Effect.die("実行ファイル取得は対象外"),
      load: () => Effect.die("撮影は対象外"),
      check: (names: ReadonlyArray<string>) => Effect.sync(() => { calls.push(names); return [installed]; }),
      update: () => Stream.die("更新は対象外"), install: (names: ReadonlyArray<string>) => Stream.fromEffect(Effect.sync(() => { calls.push(names); return { type: "result" as const, items: [installed] }; })),
    }));
    const url = `http://127.0.0.1:${server.port}`;
    const checked = yield* Effect.tryPromise(() => fetch(`${url}/deps/check?names=chromium`));
    expect(checked.status).toBe(200);
    expect(yield* Effect.tryPromise(() => checked.json())).toEqual([installed]);
    expect(calls).toEqual([["chromium"]]);
    const speechCheck = yield* Effect.tryPromise(() => fetch(`${url}/deps/check?names=speech-ja`));
    expect(speechCheck.status).toBe(400);
    expect(calls).toEqual([["chromium"]]);
    const forbidden = yield* Effect.tryPromise(() => fetch(`${url}/deps/check?names=chromium`, { headers: { origin: "https://example.com" } }));
    expect(forbidden.status).toBe(403);
    expect(calls).toEqual([["chromium"]]);
    for (const request of [
      { body: { names: ["chromium"] }, origin: "https://example.com", status: 403 },
      { body: { names: ["unknown"] }, origin: "http://localhost", status: 400 },
      { body: { names: [] }, origin: "http://localhost", status: 400 },
    ]) {
      const response = yield* Effect.tryPromise(() => fetch(`${url}/deps/install`, { method: "POST", headers: { "content-type": "application/json", origin: request.origin }, body: JSON.stringify(request.body) }));
      expect(response.status).toBe(request.status);
      expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({ error: expect.any(String) });
      expect(calls).toEqual([["chromium"]]);
    }
    const response = yield* Effect.tryPromise(() => fetch(`${url}/deps/install`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ names: ["chromium"] }) }));
    expect(response.status).toBe(200);
    expect(JSON.parse((yield* Effect.tryPromise(() => response.text())).trim())).toEqual({ type: "result", items: [installed] });
    expect(calls).toEqual([["chromium"], ["chromium"]]);
  }).pipe(Effect.scoped));
});
