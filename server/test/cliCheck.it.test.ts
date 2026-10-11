import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { vi } from "vitest";
import { Helpers } from "../src/helpers.ts";
import { readyHelperChecks, readyHelperItems } from "./fixtures/helperCheck.ts";
import { ManagedDeps, ManagedDepsFailed, type DepItem } from "../src/managedDeps.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { temporaryDeps } from "./fixtures/managedDeps.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";

type CheckItem = DepItem;
const states = ["ready", "missing", "outdated", "absent"] as const;
const chromium = (need: CheckItem["need"], state: CheckItem["state"]): CheckItem => ({ name: "chromium", need, state });
const claudeMissing = { name: "claude", need: "required", state: "missing" } as const;
const responseFor = (ready: boolean, item: CheckItem) => ({ ready, items: [{ ...item, size: item.name === "claude" ? 224_000_000 : 211_000_000, install: `pnpm cli install ${item.name}` }, ...readyHelperItems] });

const fakeDeps = (result: Effect.Effect<ReadonlyArray<CheckItem>, ManagedDepsFailed>) => {
  const check = vi.fn((_names: ReadonlyArray<string>) => result);
  const install = vi.fn((_names: ReadonlyArray<string>) => Stream.die("check は導入しない"));
  const load = vi.fn((_name: string) => Effect.die("check は読み込まない"));
  return { service: ManagedDeps.of({ executable: () => Effect.die("実行ファイル取得は対象外"), check, install, update: () => Stream.die("更新は対象外"), load }), check, install };
};

const serverWith = Effect.fnUntraced(function* (dir: string, deps: ManagedDeps["Service"]) {
  const launch = vi.fn(() => Effect.die("check はセッションを開始しない"));
  const server = yield* startedServer({ port: 0, sessionsDir: join(dir, "sessions") }, {
    helpers: Layer.succeed(Helpers, Helpers.of({ ...readyHelperChecks, apps: Effect.die("apps は対象外"), launch })),
    sessionSinks: SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer(() => Effect.succeed({ ops: [] }))) }).pipe(Layer.provide(fakeExportServices())),
    managedDeps: Layer.succeed(ManagedDeps, deps),
  });
  return { ...server, launch };
});

const cliProcess = (dir: string, port: number, rootScript: boolean, model: string | null = "claude") => Effect.tryPromise(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
  const env = { ...process.env, HOME: join(dir, "home"), LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_DEPS: join(dir, "deps"), LIVE_MINDMAP_SESSIONS: join(dir, "sessions"), LIVE_MINDMAP_CONFIG: join(dir, "absent.config.json"), LIVE_MINDMAP_MODEL: model ?? "", NO_COLOR: "1" };
  if (model === null) delete (env as NodeJS.ProcessEnv).LIVE_MINDMAP_MODEL;
  execFile(rootScript ? "pnpm" : process.execPath, rootScript ? ["cli", "check"] : [join(import.meta.dirname, "../src/cli.ts"), "check"], {
    cwd: join(import.meta.dirname, "../.."),
    timeout: 15_000,
    env,
  }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== "number")) return reject(error);
    resolve({ code: error ? error.code as number : 0, stdout, stderr });
  });
}));

describe("開始せずに確かめる CLI check", () => {
  it.live("HTTP は不正なモデル経路を状態確認前に拒否する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps(Effect.succeed([claudeMissing]));
    const server = yield* serverWith(dir, deps.service);
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check?route=invalid`));
    expect(response.status).toBe(400);
    expect(deps.check).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));
  it.live("モデル判定を渡さない HTTP check は既定の Claude を必須として返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps(Effect.succeed([chromium("optional", "missing"), claudeMissing]));
    const server = yield* serverWith(dir, deps.service);
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check`));
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toEqual({ ready: false, items: [
      { name: "chromium", need: "optional", state: "missing", size: 211_000_000, install: "pnpm cli install chromium" },
      { name: "claude", need: "required", state: "missing", size: 224_000_000, install: "pnpm cli install claude" },
      ...readyHelperItems,
    ] });
  }).pipe(Effect.scoped));

  it.live.each([
    { selected: null, default: "apple", need: "optional", code: 0 },
    { selected: "remote", default: "apple", need: "required", code: 3 },
  ] as const)("設定 default=$default と環境モデル $selected を開始時と同じ優先順位で使う", ({ selected, default: defaultModel, need, code }) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    yield* Effect.tryPromise(() => writeFile(join(dir, "absent.config.json"), JSON.stringify({ default: defaultModel, models: { remote: { route: "claude", model: "synthetic-model" } } })));
    const deps = fakeDeps(Effect.succeed([chromium("optional", "missing"), claudeMissing]));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, false, selected);
    expect(result.code).toBe(code);
    const report = JSON.parse(result.stdout);
    expect(report.items.find((item: { name: string }) => item.name === "claude")).toMatchObject({ name: "claude", state: "missing", need });
  }).pipe(Effect.scoped));

  it.live.each([
    { model: "remote", route: "claude", state: "missing", need: "required", ready: false, code: 3 },
    { model: "remote", route: "claude", state: "ready", need: "required", ready: true, code: 0 },
    { model: "claude", route: "openai-compatible", state: "missing", need: "optional", ready: true, code: 0 },
    { model: "account", route: "chatgpt", state: "missing", need: "optional", ready: true, code: 0 },
    { model: "apple", route: "apple", state: "missing", need: "optional", ready: true, code: 0 },
  ] as const)("$model / $route の Claude $state は $need として exit $code を返す", ({ model, route, state, need, ready, code }) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const config = route === "apple" ? {} : { models: { [model]: { route, model: "synthetic-model", ...(route === "openai-compatible" ? { url: "http://127.0.0.1:1/v1" } : {}) } } };
    yield* Effect.tryPromise(() => writeFile(join(dir, "absent.config.json"), JSON.stringify(config)));
    const deps = fakeDeps(Effect.succeed([chromium("optional", "missing"), { ...claudeMissing, state }]));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, false, model);
    expect(result.code).toBe(code);
    expect(JSON.parse(result.stdout)).toEqual({ ready, items: [
      { name: "chromium", need: "optional", state: "missing", size: 211_000_000, install: "pnpm cli install chromium" },
      { name: "claude", need, state, size: 224_000_000, install: "pnpm cli install claude" },
      ...readyHelperItems,
    ] });
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
    expect(deps.install).not.toHaveBeenCalled();
    expect(server.launch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped));
  it.live.each(states)("HTTP は任意 chromium の %s と容量・導入コマンドを返す", (state) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const item = chromium("optional", state);
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check`));
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toEqual(responseFor(true, item));
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
  }).pipe(Effect.scoped));

  it.live.each([
    { need: "optional", state: "ready", ready: true, code: 0 },
    { need: "optional", state: "missing", ready: true, code: 0 },
    { need: "optional", state: "outdated", ready: true, code: 0 },
    { need: "optional", state: "absent", ready: true, code: 0 },
    { need: "required", state: "ready", ready: true, code: 0 },
    { need: "required", state: "missing", ready: false, code: 3 },
    { need: "required", state: "outdated", ready: false, code: 0 },
    { need: "required", state: "absent", ready: false, code: 3 },
  ] as const)("CLI は $need / $state の JSON を出して exit $code を返す", ({ need, state, ready, code }) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const item = { name: need === "required" ? "claude" as const : "chromium" as const, need, state, ...(state === "outdated" ? { version: "0.0.0" } : {}) };
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, false);
    expect(result.code).toBe(code);
    expect(JSON.parse(result.stdout)).toEqual(responseFor(ready, item));
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
    expect(result.stderr).toBe("");
  }).pipe(Effect.scoped));

  it.live("pnpm cli check もサーバーの任意不足を JSON と exit 0 で返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const item = chromium("optional", "missing");
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(responseFor(true, item));
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
  }).pipe(Effect.scoped));

  it.live("ManagedDepsFailed は成功 JSON を出さず exit 1 になる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps(Effect.fail(new ManagedDepsFailed({ message: "状態確認に失敗しました" })));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, false);
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("状態確認に失敗しました\n");
  }).pipe(Effect.scoped));

  it.live("接続不能では指定文面を出して exit 1 になる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const server = yield* serverWith(dir, fakeDeps(Effect.succeed([chromium("optional", "ready")])).service);
    yield* server.close;
    const result = yield* cliProcess(dir, server.port, false);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("サーバーにつながりません（pnpm dev で起動）\n");
  }).pipe(Effect.scoped));

  it.live("正常な check の後も導入・セッションの開始・既存ファイルの削除を行わない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const files = [join(dir, "deps/chromium/.work-retained/keep"), join(dir, "sessions/saved/keep")];
    yield* Effect.tryPromise(async () => {
      await mkdir(join(dir, "deps/chromium/.work-retained"), { recursive: true });
      await mkdir(join(dir, "sessions/saved"), { recursive: true });
      for (const file of files) await writeFile(file, "保存済みの内容");
    });
    const item = chromium("optional", "missing");
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check`));
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toEqual(responseFor(true, item));
    const result = yield* cliProcess(dir, server.port, false);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(responseFor(true, item));
    expect(deps.check.mock.calls).toEqual([[["chromium", "claude"]], [["chromium", "claude"]]]);
    expect(deps.install).not.toHaveBeenCalled();
    expect(server.launch).not.toHaveBeenCalled();
    for (const file of files) expect(yield* Effect.tryPromise(() => readFile(file, "utf8"))).toBe("保存済みの内容");
  }).pipe(Effect.scoped));

  it.live("HTTP は正常な check を受理し、不正 Origin は確認前に拒否する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const item = chromium("optional", "ready");
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const url = `http://127.0.0.1:${server.port}/check`;
    const allowed = yield* Effect.tryPromise(() => fetch(url, { headers: { origin: "http://localhost" } }));
    expect(allowed.status).toBe(200);
    expect(yield* Effect.tryPromise(() => allowed.json())).toEqual(responseFor(true, item));
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
    const forbidden = yield* Effect.tryPromise(() => fetch(url, { headers: { origin: "https://example.com" } }));
    expect(forbidden.status).toBe(403);
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium", "claude"]);
  }).pipe(Effect.scoped));
});
