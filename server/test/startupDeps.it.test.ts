import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeChildProcessSpawner, NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Queue, Ref, Stream, type Cause } from "effect";
import { vi } from "vitest";
import { planLayer } from "../src/updatePlan.ts";
import { Helpers, HelperLaunchFailure, type HelperExitInfo, type HelperCheck } from "../src/helpers.ts";
import { readyHelperItems } from "./fixtures/helperCheck.ts";
import { ManagedDeps, ManagedDepsFailed, type DepItem } from "../src/managedDeps.ts";
import { defaultClaude, type ExecutableModel } from "../src/modelSelection.ts";
import { readModelTransferToken, MODEL_TRANSFER_HEADER } from "../src/modelTransferToken.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { runCliEntry } from "./fixtures/cliEntry.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { temporaryDeps } from "./fixtures/managedDeps.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";

const refusal = "開始しません。足りないもの: claude（Claude Agent SDK、約 224MB）\n入れるには: pnpm cli install claude\n利用者に確認してから入れてください\n";
type Item = DepItem;

const controlledDeps = () => {
  const state = { claude: "ready" as Item["state"], chromium: "ready" as Item["state"], loadFails: false, wait: undefined as Promise<void> | undefined };
  const check = vi.fn((names: ReadonlyArray<string>) => Effect.gen(function* () {
    if (state.wait !== undefined) yield* Effect.promise(() => state.wait!);
    return names.map((name): Item => {
      if (name !== "claude" && name !== "chromium") throw new Error(`対象外の依存: ${name}`);
      return { name, need: "optional", state: state[name] };
    });
  }));
  const load = vi.fn((_name: string) => Effect.suspend(() => state.loadFails
    ? Effect.fail(new ManagedDepsFailed({ message: "合成 SDK の読込失敗" }))
    : Effect.succeed({ query: () => { throw new Error("このテストはモデルを呼びません"); } })));
  const install = vi.fn(() => Stream.die("開始前の確かめは導入しません"));
  const layer = Layer.succeed(ManagedDeps, ManagedDeps.of({ executable: () => Effect.die("実行ファイル取得は対象外"), check, install, update: () => Stream.die("更新は対象外"), load: load as unknown as ManagedDeps["Service"]["load"] }));
  return { state, check, load, install, layer };
};

const controlledHelpers = () => {
  const calls: string[][] = [];
  const control = { failRestarts: false, speechStatus: "installed" as HelperCheck["speechJa"]["status"] };
  const endings: Array<Effect.Effect<void>> = [];
  const launch = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const index = calls.length;
    calls.push([...args]);
    if (index > 0 && control.failRestarts) return yield* new HelperLaunchFailure({ stderrTail: ["合成の起動失敗"] });
    const queue = yield* Queue.make<string, Cause.Done>();
    const exited = yield* Deferred.make<HelperExitInfo>();
    const ended = yield* Ref.make(false);
    const finish = (info: HelperExitInfo) => Effect.gen(function* () {
      if (yield* Ref.getAndSet(ended, true)) return;
      yield* Queue.end(queue);
      yield* Deferred.succeed(exited, info);
    });
    endings.push(finish({ code: 1, signal: null }));
    const stop = finish({ code: null, signal: "SIGTERM" });
    yield* Effect.addFinalizer(() => stop);
    return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed([]), send: () => Effect.void };
  });
  const check = Effect.sync(() => ({ microphone: "authorized" as const, screenCapture: true,
    speechJa: { status: control.speechStatus, installedLocales: ["ja-JP"] },
  }));
  const installSpeechJa = Stream.fromEffect(Effect.sync(() => { control.speechStatus = "installed"; return "取得完了"; }));
  return { calls, control, endings, layer: Layer.succeed(Helpers, Helpers.of({ check, checkNoScreen: check, creationDate: () => Effect.succeed(null), installSpeechJa, apps: Effect.succeed([]), launch })) };
};

const resource = Effect.fnUntraced(function* (realPreparation: boolean, missingHelper = false) {
  const root = yield* temporaryDeps;
  const sessionsDir = join(root, "sessions");
  const deps = controlledDeps();
  const helpers = controlledHelpers();
  const sinks = SessionSinks.layer({ prepareUpdater: realPreparation ? planLayer : () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) })
    .pipe(Layer.provide(Layer.mergeAll(fakeExportServices(), deps.layer, unusedApple, NodeHttpClient.layerUndici)));
  const helpersLayer = missingHelper
    ? Helpers.layer({ command: join(root, "absent-helper"), args: [] }).pipe(Layer.provide(NodeChildProcessSpawner.layer), Layer.provide(NodeServices.layer))
    : helpers.layer;
  const server = yield* startedServer({ port: 0, sessionsDir }, { managedDeps: deps.layer, helpers: helpersLayer, sessionSinks: sinks });
  const request = (method: string, path: string, body?: object, headers?: Record<string, string>) => Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const status = Effect.gen(function* () {
    const response = yield* request("GET", "/session/status");
    return yield* Effect.tryPromise(() => response.json());
  });
  return { root, sessionsDir, deps, helpers, server, request, status };
});

const cli = (root: string, port: number, args: string[], model: string | undefined) => runCliEntry(args, Layer.mergeAll(
  forbiddenManagedDeps, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
  ConfigProvider.layer(ConfigProvider.fromEnvRecord({
    HOME: join(root, "home"), LIVE_MINDMAP_CONFIG: join(root, "config.json"), LIVE_MINDMAP_JUDGE: "off",
    ...(model === undefined ? {} : { LIVE_MINDMAP_MODEL: model }),
    LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_DEPS: join(root, "deps"), LIVE_MINDMAP_PORT: String(port),
  })),
));

const startBody = { app: "us.zoom.xos", audio: false, model: defaultClaude };
const stopIntake = Effect.fnUntraced(function* (r: Effect.Success<ReturnType<typeof resource>>) {
  r.helpers.control.failRestarts = true;
  yield* r.helpers.endings[0]!;
  yield* Effect.tryPromise(() => vi.waitFor(async () => {
    const status = await (await fetch(`http://127.0.0.1:${r.server.port}/session/status`)).json();
    expect(status).toMatchObject({ status: "stopped" });
  }));
});

describe("ライブの開始前の確かめ", () => {
  it.live("Issue #983: start --judge は知らない名前をサーバーへの要求より前に断り、鍵が無ければ server が 1 行知らせて判定なしで開始する", () => Effect.gen(function* () {
    // 鍵は layer を作る server のプロセスで確かめる。名指ししない start は routed になる
    vi.stubEnv("TYPESAFE_AI_API_KEY", "");
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const r = yield* resource(true);
    const args = ["start", "--app", "us.zoom.xos", "--no-audio"];
    const refused = yield* cli(r.root, r.server.port, [...args, "--judge", "missing"], "claude");
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("判定のモデル missing が設定にありません");
    expect(yield* r.status).toEqual({ status: "none" });
    expect(r.helpers.calls).toEqual([]);

    const noKey = yield* cli(r.root, r.server.port, [...args, "--judge", "jev"], undefined);
    expect(noKey.code).toBe(0);
    expect(noKey.stderr).toBe("判定のモデル jev の鍵がありません（環境変数 TYPESAFE_AI_API_KEY）。判定なしで始めます\n");
    expect(yield* r.status).toMatchObject({ status: "running" });
  }));

  it.live("710-2: speech-ja 不足は CLI start を副作用前に exit 3 で止め、導入後は同じサーバーで開始できる", () => Effect.gen(function* () {
    const r = yield* resource(false);
    r.helpers.control.speechStatus = "supported";
    const result = yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", "--no-audio"], "claude");
    expect(result).toEqual({ code: 3, stdout: "", stderr: "開始しません。足りないもの: speech-ja（日本語の音声認識モデル）\n入れるには: pnpm cli install speech-ja\n利用者に確認してから入れてください\n" });
    expect(yield* r.status).toEqual({ status: "none" });
    expect(existsSync(r.sessionsDir)).toBe(false);
    expect(r.helpers.calls).toEqual([]);
    expect(r.deps.load).not.toHaveBeenCalled();
    expect(r.deps.install).not.toHaveBeenCalled();
    expect((yield* cli(r.root, r.server.port, ["install", "speech-ja"], "claude")).code).toBe(0);
    expect((yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", "--no-audio"], "claude")).code).toBe(0);
    expect(yield* r.status).toMatchObject({ status: "running" });
    expect(r.helpers.calls).toHaveLength(1);
  }).pipe(Effect.scoped));
  it.live("710-2: speech-ja 不足の resume は同じセッションの停止状態・ログを保持し、不足解消後に回復する", () => Effect.gen(function* () {
    const r = yield* resource(false);
    const started = yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", "--no-audio"], "claude");
    expect(started.code).toBe(0);
    const dir = started.stdout.trim();
    yield* stopIntake(r);
    const before = yield* r.status;
    const logBefore = yield* Effect.tryPromise(() => readFile(join(dir, "log.jsonl"), "utf8"));
    const launches = r.helpers.calls.length;
    r.helpers.control.speechStatus = "supported";
    const checked = yield* cli(r.root, r.server.port, ["check", "--for", "resume"], "claude");
    expect(checked.code).toBe(3);
    expect(JSON.parse(checked.stdout).items.filter((item: { name: string }) => item.name === "speech-ja")).toEqual([
      { name: "speech-ja", need: "required", state: "missing", install: "pnpm cli install speech-ja" },
    ]);
    expect(yield* cli(r.root, r.server.port, ["resume"], "claude")).toEqual({ code: 3, stdout: "", stderr: "開始しません。足りないもの: speech-ja（日本語の音声認識モデル）\n入れるには: pnpm cli install speech-ja\n利用者に確認してから入れてください\n" });
    expect(yield* r.status).toEqual(before);
    expect(r.helpers.calls).toHaveLength(launches);
    expect(yield* Effect.tryPromise(() => readFile(join(dir, "log.jsonl"), "utf8"))).toBe(logBefore);
    const installation = yield* cli(r.root, r.server.port, ["install", "speech-ja"], "claude");
    expect(installation.code).toBe(1);
    expect(installation.stdout).toBe("");
    expect(r.helpers.control.speechStatus).toBe("supported");
    expect(yield* r.status).toEqual(before);
    r.helpers.control.speechStatus = "installed";
    r.helpers.control.failRestarts = false;
    expect((yield* cli(r.root, r.server.port, ["resume"], "claude")).code).toBe(0);
    expect(yield* r.status).toMatchObject({ status: "running", dir, restarts: 1 });
    expect(r.helpers.calls).toHaveLength(launches + 1);
    expect((yield* Effect.tryPromise(() => readFile(join(dir, "log.jsonl"), "utf8"))).startsWith(logBefore)).toBe(true);
  }).pipe(Effect.scoped));
  it.live("C3: CLI check と start はヘルパーの確認失敗を exit 3 にする", () => Effect.gen(function* () {
    const r = yield* resource(false, true);
    const checked = yield* cli(r.root, r.server.port, ["check"], "claude");
    expect(checked.code).toBe(3);
    expect(checked.stderr).toBe("");
    const report = JSON.parse(checked.stdout);
    expect(report.ready).toBe(false);
    expect(report.items.filter((item: { name: string }) => !["chromium", "claude"].includes(item.name))).toEqual([
      { name: "helper", need: "required", state: "missing", install: "swift build -c release --package-path helper" },
    ]);
    const started = yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", "--no-audio"], "claude");
    expect(started.code).toBe(3);
    expect(started.stdout).toBe("");
    expect(started.stderr.split("\n").filter((line) => line.startsWith("入れるには:"))).toEqual(["入れるには: swift build -c release --package-path helper"]);
    expect(yield* r.status).toEqual({ status: "none" });
    expect(existsSync(r.sessionsDir)).toBe(false);
    expect(r.deps.install).not.toHaveBeenCalled();
    expect(r.deps.load).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));
  it.live("HTTP の必須不足は副作用前に503で拒否し、同じサーバーで不足解消後に開始できる", () => Effect.gen(function* () {
    const r = yield* resource(false);
    r.deps.state.claude = "missing";
    const rejected = yield* r.request("POST", "/session/start", startBody);
    expect(rejected.status).toBe(503);
    expect(yield* r.status).toEqual({ status: "none" });
    expect(r.helpers.calls).toEqual([]);
    expect(r.deps.load).not.toHaveBeenCalled();
    expect(r.deps.install).not.toHaveBeenCalled();
    expect(existsSync(r.sessionsDir)).toBe(false);
    r.deps.state.claude = "ready";
    const accepted = yield* r.request("POST", "/session/start", startBody);
    expect(accepted.status).toBe(200);
    expect(r.helpers.calls).toHaveLength(1);
    expect(yield* r.status).toMatchObject({ status: "running" });
  }).pipe(Effect.scoped));

  it.live.each([false, true])("CLI start no-audio=%s は必須不足を3行の stderr と exit 3 で返す", (noAudio) => Effect.gen(function* () {
    const r = yield* resource(false);
    r.deps.state.claude = "missing";
    r.deps.state.chromium = "missing";
    const result = yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", ...(noAudio ? ["--no-audio"] : [])], "claude");
    expect(result).toEqual({ code: 3, stdout: "", stderr: refusal });
    expect(yield* r.status).toEqual({ status: "none" });
    expect(r.helpers.calls).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("check が ready でも SDK 読込失敗は start を exit 3 で止める", () => Effect.gen(function* () {
    const r = yield* resource(true);
    r.deps.state.loadFails = true;
    const result = yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", "--no-audio"], "claude");
    expect(result).toEqual({ code: 3, stdout: "", stderr: refusal });
    expect(r.deps.load).toHaveBeenCalledExactlyOnceWith("claude");
    expect(r.helpers.calls).toEqual([]);
    expect(yield* r.status).toEqual({ status: "none" });
  }).pipe(Effect.scoped));

  it.live("Chromium の不足は stderr に警告し、開始したフォルダを stdout に返す", () => Effect.gen(function* () {
    const r = yield* resource(false);
    r.deps.state.chromium = "missing";
    const result = yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", "--no-audio"], "claude");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("chromium");
    const dir = result.stdout.trim();
    expect(yield* r.status).toMatchObject({ status: "running", dir });
    expect(existsSync(join(dir, "log.jsonl"))).toBe(true);
    expect(r.helpers.calls).toHaveLength(1);
    expect(r.deps.install).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.live.each([
    { name: "claude", route: "openai-compatible", model: "synthetic", url: "http://127.0.0.1:1/v1", local: false },
    { name: "account", route: "chatgpt", model: "synthetic", local: false },
    { name: "apple", route: "apple", local: true },
  ] satisfies ExecutableModel[])("HTTP は $route で Claude の欠けを開始拒否にしない", (model) => Effect.gen(function* () {
    const r = yield* resource(false);
    r.deps.state.claude = "missing";
    const token = yield* readModelTransferToken(r.sessionsDir, r.server.port).pipe(Effect.provide(fakeExportServices()));
    const response = yield* r.request("POST", "/session/start", { ...startBody, model }, { [MODEL_TRANSFER_HEADER]: token! });
    expect(response.status).toBe(200);
    expect(yield* r.status).toMatchObject({ status: "running" });
    expect(r.deps.load).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));

  it.live("同じセッションの resume は開始モデルを使い、不足時の停止状態とログを保持して回復する", () => Effect.gen(function* () {
    const r = yield* resource(false);
    const started = yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", "--no-audio"], "claude");
    expect(started.code).toBe(0);
    const dir = started.stdout.trim();
    yield* stopIntake(r);
    const before = yield* r.status;
    const logBefore = yield* Effect.tryPromise(() => readFile(join(dir, "log.jsonl"), "utf8"));
    const launches = r.helpers.calls.length;
    r.deps.state.claude = "missing";
    yield* Effect.tryPromise(() => writeFile(join(r.root, "config.json"), JSON.stringify({ default: "compatible", models: { compatible: { route: "openai-compatible", model: "synthetic", url: "http://127.0.0.1:1/v1" } } })));
    const checked = yield* cli(r.root, r.server.port, ["check", "--for", "resume"], "compatible");
    expect.soft(checked.code).toBe(3);
    if (checked.code === 3) expect(JSON.parse(checked.stdout)).toMatchObject({ ready: false, items: expect.arrayContaining([{ name: "claude", need: "required", state: "missing", size: 224_000_000, install: "pnpm cli install claude" }]) });
    const rejected = yield* cli(r.root, r.server.port, ["resume"], "compatible");
    expect(rejected).toEqual({ code: 3, stdout: "", stderr: refusal });
    expect(yield* r.status).toEqual(before);
    expect(r.helpers.calls).toHaveLength(launches);
    expect(yield* Effect.tryPromise(() => readFile(join(dir, "log.jsonl"), "utf8"))).toBe(logBefore);
    r.deps.state.claude = "ready";
    r.deps.state.chromium = "missing";
    r.helpers.control.failRestarts = false;
    const resumed = yield* cli(r.root, r.server.port, ["resume"], "compatible");
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toBe("");
    expect(resumed.stderr).toContain("chromium");
    expect(yield* r.status).toMatchObject({ status: "running", dir, restarts: 1 });
    const logAfter = yield* Effect.tryPromise(() => readFile(join(dir, "log.jsonl"), "utf8"));
    expect(logAfter.startsWith(logBefore)).toBe(true);
    expect(logAfter.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "start")).toHaveLength(1);
  }).pipe(Effect.scoped));

  it.live("互換モデルで開始したセッションは resume 時の CLI が Claude でも Claude を必須にしない", () => Effect.gen(function* () {
    const r = yield* resource(false);
    yield* Effect.tryPromise(() => writeFile(join(r.root, "config.json"), JSON.stringify({ models: { remote: { route: "openai-compatible", model: "synthetic", url: "http://127.0.0.1:1/v1" } } })));
    expect((yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", "--no-audio"], "remote")).code).toBe(0);
    yield* stopIntake(r);
    r.helpers.control.failRestarts = false;
    r.deps.state.claude = "missing";
    expect((yield* cli(r.root, r.server.port, ["resume"], "claude")).code).toBe(0);
    expect(yield* r.status).toMatchObject({ status: "running", restarts: 1 });
  }).pipe(Effect.scoped));

  it.live("依存が欠けても stop は確認せず同じセッションを書き出す", () => Effect.gen(function* () {
    const r = yield* resource(false);
    const started = yield* cli(r.root, r.server.port, ["start", "--app", "us.zoom.xos", "--no-audio"], "claude");
    expect(started.code).toBe(0);
    const checks = r.deps.check.mock.calls.length;
    r.deps.state.claude = "missing";
    r.deps.state.chromium = "missing";
    const stopped = yield* cli(r.root, r.server.port, ["stop"], "claude");
    expect(stopped.code).toBe(0);
    expect(stopped.stdout.split("\n")).toContain(join(started.stdout.trim(), "map.json"));
    expect(r.deps.check).toHaveBeenCalledTimes(checks);
    expect(yield* r.status).toEqual({ status: "none" });
  }).pipe(Effect.scoped));

  it.live("resume の確認待ち中に stop したセッションでは確認後も helper を起動しない", () => Effect.gen(function* () {
    const r = yield* resource(false);
    expect((yield* r.request("POST", "/session/start", startBody)).status).toBe(200);
    yield* stopIntake(r);
    let release!: () => void;
    r.deps.state.wait = new Promise<void>((resolve) => { release = resolve; });
    const checks = r.deps.check.mock.calls.length;
    const launches = r.helpers.calls.length;
    r.helpers.control.failRestarts = false;
    const resuming = yield* Effect.forkChild(r.request("POST", "/session/resume"));
    try {
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(r.deps.check.mock.calls.length).toBeGreaterThan(checks)));
      expect((yield* r.request("POST", "/session/stop")).status).toBe(200);
    } finally {
      release();
      yield* Fiber.join(resuming);
    }
    expect((yield* Fiber.join(resuming)).status).toBeGreaterThanOrEqual(400);
    expect(r.helpers.calls).toHaveLength(launches);
    expect(yield* r.status).toEqual({ status: "none" });
  }).pipe(Effect.scoped));

  it.live("check --for start は JSON の形を保持し開始も SDK 読込も導入もしない", () => Effect.gen(function* () {
    const r = yield* resource(false);
    r.deps.state.claude = "missing";
    const checked = yield* cli(r.root, r.server.port, ["check", "--for", "start"], "claude");
    expect(checked.code).toBe(3);
    expect(checked.stderr).toBe("");
    expect(JSON.parse(checked.stdout)).toEqual({ ready: false, items: [
      { name: "chromium", need: "optional", state: "ready", size: 211_000_000, install: "pnpm cli install chromium" },
      { name: "claude", need: "required", state: "missing", size: 224_000_000, install: "pnpm cli install claude" },
      ...readyHelperItems,
    ] });
    expect(r.helpers.calls).toEqual([]);
    expect(r.deps.load).not.toHaveBeenCalled();
    expect(r.deps.install).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));
});
