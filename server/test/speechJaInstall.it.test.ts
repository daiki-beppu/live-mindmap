import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Stream } from "effect";
import { vi } from "vitest";
import { Helpers, HelperCheckFailure, type HelperCheck } from "../src/helpers.ts";
import * as HelperServices from "../src/helpers.ts";
import { ManagedDeps, type DepItem } from "../src/managedDeps.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { temporaryDeps } from "./fixtures/managedDeps.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";

const speechItem = { name: "speech-ja", need: "required", state: "ready", install: "pnpm cli install speech-ja" };
const claudeItem: DepItem = { name: "claude", need: "required", state: "ready" };

const resource = Effect.fnUntraced(function* () {
  const root = yield* temporaryDeps;
  const release = yield* Deferred.make<void>();
  const state = { status: "supported" as HelperCheck["speechJa"]["status"], fail: false, checkFails: false, markInstalled: true, installs: 0, closed: 0 };
  const managedRequests: ReadonlyArray<string>[] = [];
  const checked = Effect.suspend(() => state.checkFails
    ? Effect.fail(new HelperCheckFailure({ message: "合成のモデル確認失敗" }))
    : Effect.succeed({ microphone: "authorized" as const, screenCapture: true, speechJa: { status: state.status, installedLocales: ["ja-JP"] } }));
  const installSpeechJa = Stream.concat(
    Stream.fromEffect(Effect.sync(() => { state.installs++; return "日本語モデルを取得中"; })),
    Stream.fromEffect(Effect.gen(function* () {
      yield* Deferred.await(release);
      if (state.fail) return yield* new HelperServices.HelperInstallFailure({ message: "合成の取得失敗" });
      if (state.markInstalled) state.status = "installed";
      return "日本語モデルの取得完了";
    })),
  ).pipe(Stream.ensuring(Effect.sync(() => { state.closed++; })));
  const deps = ManagedDeps.of({
    executable: () => Effect.die("実行ファイル取得は対象外"),
    check: (names) => Effect.sync(() => names.map((name): DepItem => {
      if (name !== "claude" && name !== "chromium") throw new Error("speech-ja は ManagedDeps の対象ではありません");
      return { name, need: "optional", state: "ready" };
    })),
    load: () => Effect.die("導入テストは SDK を読み込まない"),
    update: () => Stream.die("更新は対象外"),
    install: (names: ReadonlyArray<string>) => Stream.fromEffect(Effect.sync(() => {
      managedRequests.push(names);
      return { type: "result" as const, items: names.map((name): DepItem => {
        if (name !== "claude" && name !== "chromium") throw new Error("対象外の導入依存");
        return { ...claudeItem, name };
      }) };
    })),
  });
  const helpers = { check: checked, checkNoScreen: checked, creationDate: () => Effect.succeed(null), installSpeechJa,
    apps: Effect.die("導入は会議アプリを取得しない"), launch: () => Effect.die("導入はセッションを開始しない"),
  };
  const server = yield* startedServer({ port: 0, sessionsDir: join(root, "sessions") }, {
    helpers: Layer.succeed(Helpers, Helpers.of(helpers)), managedDeps: Layer.succeed(ManagedDeps, deps),
    sessionSinks: SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer(() => Effect.succeed({ ops: [] }))) }).pipe(Layer.provide(fakeExportServices())),
  });
  const env = { ...process.env, HOME: join(root, "home"), LIVE_MINDMAP_PORT: String(server.port), LIVE_MINDMAP_DEPS: join(root, "deps"),
    LIVE_MINDMAP_SESSIONS: join(root, "sessions"), LIVE_MINDMAP_CONFIG: join(root, "absent.json"), LIVE_MINDMAP_MODEL: "claude", NO_COLOR: "1" };
  const cli = (args: string[]) => Effect.tryPromise(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [join(import.meta.dirname, "../src/cli.ts"), ...args], { env, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) return reject(error);
      resolve({ code: error ? error.code as number : 0, stdout, stderr });
    });
  }));
  return { root, state, managedRequests, server, release, cli, env };
});

describe("speech-ja のサーバー経由の導入", () => {
  it.live("710-4: 同じサーバーで missing → install → ready を観測し、次の check も現在のヘルパー状態を読む", () => Effect.gen(function* () {
    const r = yield* resource();
    const before = yield* r.cli(["check"]);
    expect(before.code).toBe(3);
    expect(JSON.parse(before.stdout).items.filter((item: { name: string }) => item.name === "speech-ja")).toEqual([{ ...speechItem, state: "missing" }]);
    yield* Deferred.succeed(r.release, undefined);
    const installed = yield* r.cli(["install", "speech-ja"]);
    expect(installed.code).toBe(0);
    expect(JSON.parse(installed.stdout)).toEqual([speechItem]);
    expect(installed.stderr).toContain("日本語モデルを取得中\n");
    expect(installed.stderr).toContain("日本語モデルの取得完了\n");
    expect(r.state.installs).toBe(1);
    expect(r.managedRequests).toEqual([]);
    expect(existsSync(join(r.root, "deps"))).toBe(false);
    const after = yield* r.cli(["check"]);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({ ready: true, items: expect.arrayContaining([speechItem]) });
    r.state.status = "supported";
    const changed = yield* r.cli(["check"]);
    expect(changed.code).toBe(3);
    expect(JSON.parse(changed.stdout)).toMatchObject({ ready: false, items: expect.arrayContaining([{ ...speechItem, state: "missing" }]) });
  }).pipe(Effect.scoped));

  it.live("710-4: 混在要求は Claude だけ ManagedDeps に渡し、導入対象だけをまとめて返す", () => Effect.gen(function* () {
    const r = yield* resource();
    yield* Deferred.succeed(r.release, undefined);
    const result = yield* r.cli(["install", "claude", "speech-ja"]);
    expect(result.code).toBe(0);
    expect(r.managedRequests).toEqual([["claude"]]);
    const items = JSON.parse(result.stdout);
    expect(items).toHaveLength(2);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "claude", state: "ready" }), speechItem]));
    expect(r.state.installs).toBe(1);
  }).pipe(Effect.scoped));

  it.live("710-4: プロセス入口は取得中の stderr を流し、stdout と終了を保留し、競合は待たず exit 1 で拒否する", () => Effect.gen(function* () {
    const r = yield* resource();
    const child = yield* Effect.acquireRelease(Effect.sync(() => spawn(process.execPath,
      [join(import.meta.dirname, "../src/cli.ts"), "install", "speech-ja"], { env: r.env, stdio: ["ignore", "pipe", "pipe"] })),
      (process) => Effect.promise(async () => {
        if (process.exitCode !== null || process.signalCode !== null) return;
        await new Promise<void>((resolve) => { process.once("close", () => resolve()); process.kill("SIGKILL"); });
      }));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    try {
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(stderr).toContain("日本語モデルを取得中\n")));
      expect(stdout).toBe("");
      expect(child.exitCode).toBeNull();
      expect(r.state.installs).toBe(1);
      const competitor = yield* r.cli(["install", "speech-ja"]);
      expect(competitor.code).toBe(1);
      expect(competitor.stdout).toBe("");
      expect(competitor.stderr).toContain("導入中です");
      expect(r.state.installs).toBe(1);
    } finally {
      yield* Deferred.succeed(r.release, undefined);
    }
    expect(yield* Effect.tryPromise(() => exited)).toBe(0);
    expect(JSON.parse(stdout)).toEqual([speechItem]);
    expect((yield* r.cli(["install", "speech-ja"])).code).toBe(0);
    expect(r.state.installs).toBe(2);
  }).pipe(Effect.scoped));

  it.live("710-4: 取得失敗は理由と exit 1 を返し、同じサーバーで再試行できる", () => Effect.gen(function* () {
    const r = yield* resource();
    r.state.fail = true;
    yield* Deferred.succeed(r.release, undefined);
    const failed = yield* r.cli(["install", "speech-ja"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("合成の取得失敗");
    expect(r.state.installs).toBe(1);
    r.state.fail = false;
    expect((yield* r.cli(["install", "speech-ja"])).code).toBe(0);
    expect(r.state.installs).toBe(2);
  }).pipe(Effect.scoped));

  it.live("710-4: 導入接続の中断は Helpers の後片付け後に排他を解放し、同じサーバーで再試行できる", () => Effect.gen(function* () {
    const r = yield* resource();
    const controller = new AbortController();
    try {
      const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${r.server.port}/deps/install`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ names: ["speech-ja"] }), signal: controller.signal,
      }));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = yield* Effect.tryPromise(() => reader.read());
      expect(new TextDecoder().decode(first.value)).toContain("日本語モデルを取得中");
      expect(r.state.installs).toBe(1);
      controller.abort();
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(r.state.closed).toBe(1)));
      yield* Deferred.succeed(r.release, undefined);
      expect((yield* r.cli(["install", "speech-ja"])).code).toBe(0);
      expect(r.state.installs).toBe(2);
    } finally {
      controller.abort();
      yield* Deferred.succeed(r.release, undefined);
    }
  }).pipe(Effect.scoped));

  it.live.each(["checkFails", "markInstalled"] as const)("710-4: 取得後の確認が不成立（%s）なら成功 items を出さない", (field) => Effect.gen(function* () {
    const r = yield* resource();
    if (field === "checkFails") r.state.checkFails = true;
    else r.state.markInstalled = false;
    yield* Deferred.succeed(r.release, undefined);
    const result = yield* r.cli(["install", "speech-ja"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(r.state.installs).toBe(1);
  }).pipe(Effect.scoped));
});
