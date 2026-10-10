import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { vi } from "vitest";
import { Helpers } from "../src/helpers.ts";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import type { InstallEvent } from "../src/managedDepsProtocol.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { temporaryDeps } from "./fixtures/managedDeps.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";

type CheckItem = Extract<typeof InstallEvent.Type, { type: "result" }>["items"][number];
const states = ["ready", "missing", "outdated", "absent"] as const;
const chromium = (need: CheckItem["need"], state: CheckItem["state"]): CheckItem => ({ name: "chromium", need, state });
const responseFor = (ready: boolean, item: CheckItem) => ({ ready, items: [{ ...item, size: 211_000_000, install: "pnpm cli install chromium" }] });

const fakeDeps = (result: Effect.Effect<ReadonlyArray<CheckItem>, ManagedDepsFailed>) => {
  const check = vi.fn((_names: ReadonlyArray<string>) => result);
  const install = vi.fn((_names: ReadonlyArray<string>) => Stream.die("check は導入しない"));
  return { service: ManagedDeps.of({ check, install }), check, install };
};

const serverWith = Effect.fnUntraced(function* (dir: string, deps: ManagedDeps["Service"]) {
  const launch = vi.fn(() => Effect.die("check はセッションを開始しない"));
  const server = yield* startedServer({ port: 0, sessionsDir: join(dir, "sessions") }, {
    helpers: Layer.succeed(Helpers, Helpers.of({ apps: Effect.die("apps は対象外"), launch })),
    sessionSinks: SessionSinks.layer({ prepareUpdater: () => Effect.succeed(updaterLayer(() => Effect.succeed({ ops: [] }))) }).pipe(Layer.provide(fakeExportServices())),
    managedDeps: Layer.succeed(ManagedDeps, deps),
  });
  return { ...server, launch };
});

const cliProcess = (dir: string, port: number, rootScript: boolean) => Effect.tryPromise(() => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
  execFile(rootScript ? "pnpm" : process.execPath, rootScript ? ["cli", "check"] : [join(import.meta.dirname, "../src/cli.ts"), "check"], {
    cwd: join(import.meta.dirname, "../.."),
    timeout: 15_000,
    env: { ...process.env, LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_DEPS: join(dir, "deps"), LIVE_MINDMAP_SESSIONS: join(dir, "sessions"), LIVE_MINDMAP_CONFIG: join(dir, "absent.config.json"), LIVE_MINDMAP_MODEL: "", NO_COLOR: "1" },
  }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== "number")) return reject(error);
    resolve({ code: error ? error.code as number : 0, stdout, stderr });
  });
}));

describe("開始せずに確かめる CLI check", () => {
  it.live.each(states)("HTTP は任意 chromium の %s と容量・導入コマンドを返す", (state) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const item = chromium("optional", state);
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/check`));
    expect(response.status).toBe(200);
    expect(yield* Effect.tryPromise(() => response.json())).toEqual(responseFor(true, item));
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium"]);
  }).pipe(Effect.scoped));

  it.live.each([
    { need: "optional", state: "ready", ready: true, code: 0 },
    { need: "optional", state: "missing", ready: true, code: 0 },
    { need: "optional", state: "outdated", ready: true, code: 0 },
    { need: "optional", state: "absent", ready: true, code: 0 },
    { need: "required", state: "ready", ready: true, code: 0 },
    { need: "required", state: "missing", ready: false, code: 3 },
    { need: "required", state: "outdated", ready: false, code: 3 },
    { need: "required", state: "absent", ready: false, code: 3 },
  ] as const)("CLI は $need / $state の JSON を出して exit $code を返す", ({ need, state, ready, code }) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const item = chromium(need, state);
    const deps = fakeDeps(Effect.succeed([item]));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, false);
    expect(result.code).toBe(code);
    expect(JSON.parse(result.stdout)).toEqual(responseFor(ready, item));
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium"]);
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
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium"]);
  }).pipe(Effect.scoped));

  it.live("ManagedDepsFailed は成功 JSON を出さず exit 1 になる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const deps = fakeDeps(Effect.fail(new ManagedDepsFailed({ message: "状態確認に失敗しました" })));
    const server = yield* serverWith(dir, deps.service);
    const result = yield* cliProcess(dir, server.port, false);
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium"]);
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

  it.live("正常な check の後も導入・helper 起動・既存ファイルの削除を行わない", () => Effect.gen(function* () {
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
    expect(deps.check.mock.calls).toEqual([[["chromium"]], [["chromium"]]]);
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
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium"]);
    const forbidden = yield* Effect.tryPromise(() => fetch(url, { headers: { origin: "https://example.com" } }));
    expect(forbidden.status).toBe(403);
    expect(deps.check).toHaveBeenCalledExactlyOnceWith(["chromium"]);
  }).pipe(Effect.scoped));
});
