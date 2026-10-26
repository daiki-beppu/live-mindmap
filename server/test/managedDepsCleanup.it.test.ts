import { StartupChecks } from "../src/startupChecks.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Console, Deferred, Effect, Fiber, FileSystem, Layer, PlatformError, Stream } from "effect";
import { afterEach, vi } from "vitest";
import { ManagedDeps } from "../src/managedDeps.ts";
import { Helpers } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { realLayers, type ServerOptions } from "../src/server.ts";
import { collectingConsole, fakeExportServices } from "./fixtures/exportServices.ts";
import { helperChecks } from "./fixtures/helperCheck.ts";
import { fakeNpm, installed, managedLayer, temporaryDeps } from "./fixtures/managedDeps.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { runCliEntry } from "./fixtures/cliEntry.ts";
import { forbiddenManagedDeps } from "./fixtures/forbiddenManagedDeps.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";

afterEach(() => vi.unstubAllEnvs());

const names = [1, 2, 3, 4].map((n) => `0.0.${n}-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const entity = async (root: string, name: string) => {
  const dir = join(root, "chromium", name);
  const pkg = join(dir, "node_modules/playwright-core");
  const version = name.split("-", 1)[0];
  await mkdir(pkg, { recursive: true });
  await writeFile(join(dir, "package.json"), '{"private":true,"type":"module"}');
  await writeFile(join(dir, ".ready.json"), JSON.stringify({ version, installedAt: "2026-01-01T00:00:00Z", hashes: {} }));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", version, type: "module", main: "index.js" }));
  await writeFile(join(pkg, "index.js"), `export const chromium = { launch: async () => ({ version: () => ${JSON.stringify(name)}, close: async () => {} }) };`);
  return dir;
};
const publish = async (root: string, name: string) => {
  await symlink(name, join(root, "chromium/next"));
  await rename(join(root, "chromium/next"), join(root, "chromium/current"));
};

const serverWith = Effect.fnUntraced(function* (dir: string, deps: ManagedDeps["Service"]) {
  return yield* startedServer({ port: 0, sessionsDir: join(dir, "sessions") }, {
    managedDeps: Layer.succeed(ManagedDeps, deps),
    helpers: Layer.succeed(Helpers, Helpers.of({ ...helperChecks(), apps: Effect.die("apps は対象外"), launch: () => Effect.die("開始は対象外") })),
    sessionSinks: SessionSinks.layer.pipe(Layer.provide(fakeExportServices())), startupChecks: StartupChecks.layer({ prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) }).pipe(Layer.provide(fakeExportServices())),
  });
});

const cli = (dir: string, port: number, command: "install" | "update" | "check") => runCliEntry([command, ...(command === "check" ? [] : ["chromium"])], Layer.mergeAll(
  forbiddenManagedDeps, NodeServices.layer, unusedApple, NodeHttpClient.layerUndici, fakeExportServices(), fakeScreenJpeg().layer,
  ConfigProvider.layer(ConfigProvider.fromEnvRecord({
    HOME: join(dir, "home"), LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_DEPS: join(dir, "deps"), LIVE_MINDMAP_SESSIONS: join(dir, "sessions"),
    LIVE_MINDMAP_CONFIG: join(dir, "absent.config.json"), LIVE_MINDMAP_MODEL: "", LIVE_MINDMAP_JUDGE: "off",
  })),
));

describe("712: 管理実体の削除", () => {
  it.live("正式実体以外と外向き symlink を保持し、サイズ集計もリンク先を走査しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    const external = join(dir, "external");
    const invalid = "0.0.0-not-a-uuid";
    yield* Effect.tryPromise(async () => {
      const old = await entity(root, names[0]!);
      await publish(root, names[0]!);
      await mkdir(external);
      await writeFile(join(external, "payload"), Buffer.alloc(5_000_000));
      await symlink(external, join(old, "external"));
      await symlink(external, join(root, "chromium", names[1]!));
      await mkdir(join(root, "chromium", invalid));
      await writeFile(join(root, "chromium", names[2]!), "regular file");
    });
    yield* Effect.gen(function* () {
      const events = yield* Stream.runCollect((yield* ManagedDeps).install(["chromium"]));
      expect(events.filter((event) => event.type === "progress" && event.message.startsWith("古い版を消しました:"))).toEqual([
        { type: "progress", message: "古い版を消しました: 0.0.1（約 0 MB）" },
      ]);
      for (const name of [names[1]!, names[2]!, invalid]) expect(existsSync(join(root, "chromium", name))).toBe(true);
      expect((yield* Effect.tryPromise(() => readFile(join(external, "payload")))).byteLength).toBe(5_000_000);
      expect(existsSync(join(root, "chromium", names[0]!))).toBe(false);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("起動時に current が壊れていれば警告し、保護先が不明な実体を削除しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    yield* Effect.tryPromise(async () => {
      await entity(root, names[0]!);
      await symlink("missing-entity", join(root, "chromium/current"));
    });
    const output = collectingConsole();
    const options: ServerOptions = { port: 0, sessionsDir: join(dir, "sessions"), depsDir: root, helper: { command: process.execPath, args: [] }, prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) };
    const server = yield* startedServer(options, realLayers(options, fakeExportServices())).pipe(Effect.provideService(Console.Console, output.service));
    expect((yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/session/status`))).status).toBe(200);
    expect(existsSync(join(root, "chromium", names[0]!))).toBe(true);
    expect(existsSync(join(root, "claude"))).toBe(false);
    expect(output.errors.some((line) => line.startsWith("警告:"))).toBe(true);
  }).pipe(Effect.scoped));

  it.live.each(["install", "update"] as const)("%s は未読込だけを消し、同じ所有者が読み込んだ全実体と current を保持する", (operation) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const physical = join(dir, "physical");
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      await mkdir(physical);
      await symlink(physical, root);
      for (const name of names) await entity(root, name);
      await publish(root, names[0]!);
      await mkdir(join(root, "chromium/notes"));
      await writeFile(join(root, "chromium/notes/keep"), "keep");
    });
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "unused");
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      for (const name of names.slice(0, 2)) {
        yield* Effect.tryPromise(() => publish(root, name));
        const module = yield* deps.load("chromium");
        const browser = yield* Effect.acquireRelease(Effect.tryPromise(() => module.chromium.launch()), (b) => Effect.promise(() => b.close()));
        expect(browser.version()).toBe(name);
      }
      yield* Effect.tryPromise(() => publish(root, names[2]!));
      const events = yield* Stream.runCollect(deps[operation](["chromium"]));
      const current = yield* Effect.tryPromise(() => realpath(join(root, "chromium/current")));
      expect.soft(existsSync(current)).toBe(true);
      for (const name of names.slice(0, 2)) expect.soft(existsSync(join(root, "chromium", name))).toBe(true);
      for (const name of names.slice(2)) expect.soft(existsSync(join(root, "chromium", name))).toBe(false);
      expect.soft(existsSync(join(root, "chromium/browsers/chromium_headless_shell-999/INSTALLATION_COMPLETE"))).toBe(true);
      expect.soft(yield* Effect.tryPromise(() => readFile(join(root, "chromium/notes/keep"), "utf8"))).toBe("keep");
      expect.soft(events.at(-1)).toEqual({ type: "result", items: [installed] });
      const remaining = (yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).filter((name) => /^\d.*-[0-9a-f-]{36}$/.test(name)).sort();
      expect(remaining).toEqual([...names.slice(0, 2), basename(current)].sort());
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live.each(["install", "update"] as const)("CLI %s は削除を result 前の progress で受け、指定の一行と items と exit 0 を返す", (operation) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      await entity(root, names[0]!);
      await publish(root, names[0]!);
      await writeFile(join(root, "chromium", names[0]!, "payload"), Buffer.alloc(2_000_000));
    });
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const events: string[] = [];
      const observed = ManagedDeps.of({ ...deps, [operation]: (requested: ReadonlyArray<string>) => deps[operation](requested).pipe(Stream.tap((event) => Effect.sync(() => { events.push(event.type); }))) });
      const server = yield* serverWith(dir, observed);
      const result = yield* cli(dir, server.port, operation);
      expect.soft(result.code).toBe(0);
      expect.soft(JSON.parse(result.stdout)).toEqual([installed]);
      expect.soft(events.at(-1)).toBe("result");
      expect.soft(events.filter((type) => type === "result")).toHaveLength(1);
      expect.soft(existsSync(join(root, "chromium", names[0]!))).toBe(false);
      const notices = result.stderr.split("\n").filter((line) => line.startsWith("古い版を消しました:"));
      expect(notices).toHaveLength(1);
      const notice = /^古い版を消しました: 0\.0\.1（約 (\d+(?:\.\d+)?) MB）$/.exec(notices[0]!);
      expect(notice).not.toBeNull();
      expect(Number(notice![1])).toBeGreaterThanOrEqual(2);
      expect(Number(notice![1])).toBeLessThanOrEqual(3);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("削除エラーに到達しても警告だけを出し、新 current と ready items と exit 0 を保持する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    const target = yield* Effect.tryPromise(async () => {
      const old = await entity(root, names[0]!);
      await entity(root, names[1]!);
      await publish(root, names[0]!);
      return await realpath(old);
    });
    const removals: string[] = [];
    const fsLayer = Layer.effect(FileSystem.FileSystem, Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return FileSystem.FileSystem.of({ ...fs, remove: (path, options) => Effect.suspend(() => {
        if (path === target || path === join(root, "chromium", names[0]!)) {
          removals.push(target);
          return Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "remove", pathOrDescriptor: path, description: "synthetic cleanup denied" }));
        }
        return fs.remove(path, options);
      }) });
    })).pipe(Layer.provide(NodeServices.layer));
    const layer = ManagedDeps.layer({ root, npm }).pipe(Layer.provide(Layer.merge(NodeServices.layer, fsLayer)));
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const server = yield* serverWith(dir, deps);
      const result = yield* cli(dir, server.port, "install");
      expect.soft(result.code).toBe(0);
      expect.soft(JSON.parse(result.stdout)).toEqual([installed]);
      expect.soft(existsSync(target)).toBe(true);
      expect.soft(yield* deps.check(["chromium"])).toEqual([installed]);
      expect.soft(yield* Effect.tryPromise(() => realpath(join(root, "chromium/current")))).not.toBe(target);
      expect.soft(removals).toEqual([target]);
      expect.soft(existsSync(join(root, "chromium", names[1]!))).toBe(false);
      expect(result.stderr.split("\n").some((line) => /警告|消せません|削除.*失敗/.test(line))).toBe(true);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped));

  it.live("登録前の load と差し替えが競合しても読み込んだ実体を消さない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    const old = yield* Effect.tryPromise(async () => { const old = await entity(root, names[0]!); await publish(root, names[0]!); return await realpath(old); });
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "unused");
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let held = false;
    const fsLayer = Layer.effect(FileSystem.FileSystem, Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return FileSystem.FileSystem.of({ ...fs, readFileString: (path, encoding) => Effect.gen(function* () {
        if (!held && path === join(old, ".ready.json")) {
          held = true;
          yield* Deferred.succeed(reading, undefined);
          yield* Deferred.await(release);
        }
        return yield* fs.readFileString(path, encoding);
      }) });
    })).pipe(Layer.provide(NodeServices.layer));
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const loading = yield* deps.load("chromium").pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      const installing = yield* Stream.runCollect(deps.install(["chromium"])).pipe(Effect.forkChild);
      try {
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(existsSync(join(dir, "browser-started"))).toBe(true)));
      } finally {
        yield* Deferred.succeed(release, undefined);
      }
      const module = yield* Fiber.join(loading);
      yield* Fiber.join(installing);
      const browser = yield* Effect.acquireRelease(Effect.tryPromise(() => module.chromium.launch()), (b) => Effect.promise(() => b.close()));
      expect(browser.version()).toBe(names[0]);
      expect(existsSync(old)).toBe(true);
      expect(yield* deps.check(["chromium"])).toEqual([installed]);
    }).pipe(Effect.provide(ManagedDeps.layer({ root, npm }).pipe(Layer.provide(Layer.merge(NodeServices.layer, fsLayer)))));
  }).pipe(Effect.scoped));

  it.live("CLI check の Layer 構築と状態確認は正式な旧実体を削除しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    yield* Effect.tryPromise(async () => {
      for (const name of names.slice(0, 2)) await entity(root, name);
      await publish(root, names[1]!);
    });
    yield* Effect.gen(function* () {
      const server = yield* serverWith(dir, yield* ManagedDeps);
      const before = yield* Effect.tryPromise(() => readdir(join(root, "chromium")));
      const result = yield* cli(dir, server.port, "check");
      expect(JSON.parse(result.stdout).items.find((item: { name: string }) => item.name === "chromium")).toMatchObject({ state: "outdated" });
      expect(yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).toEqual(before);
    }).pipe(Effect.provide(managedLayer(root)));
  }).pipe(Effect.scoped));

  it.live("実サーバーを起動し直すと読込済み Chromium の旧実体を消し current と browsers を保持する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", "unused");
    yield* Effect.tryPromise(async () => {
      for (const name of names.slice(0, 2)) await entity(root, name);
      await publish(root, names[0]!);
      await mkdir(join(root, "chromium/browsers"));
      await writeFile(join(root, "chromium/browsers/keep"), "browser data");
    });
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const first = yield* serverWith(dir, deps);
      yield* deps.load("chromium");
      yield* Effect.tryPromise(() => publish(root, names[1]!));
      expect(existsSync(join(root, "chromium", names[0]!))).toBe(true);
      yield* first.close;
      const options: ServerOptions = { port: 0, sessionsDir: join(dir, "sessions"), depsDir: root, helper: { command: process.execPath, args: [] }, prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) };
      const second = yield* startedServer(options, realLayers(options, fakeExportServices()));
      const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${second.port}/deps/check?names=chromium`));
      expect(response.status).toBe(200);
      expect.soft(existsSync(yield* Effect.tryPromise(() => realpath(join(root, "chromium/current"))))).toBe(true);
      expect.soft(yield* Effect.tryPromise(() => readFile(join(root, "chromium/browsers/keep"), "utf8"))).toBe("browser data");
      expect(existsSync(join(root, "chromium", names[0]!))).toBe(false);
    }).pipe(Effect.provide(managedLayer(root)));
  }).pipe(Effect.scoped));

  it.live("起動時に導入 lock を取れなければ警告して起動し、他の導入の実体と lock を保持する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    yield* Effect.tryPromise(async () => {
      for (const name of names.slice(0, 2)) await entity(root, name);
      await publish(root, names[1]!);
      await writeFile(join(root, "chromium/install.lock"), String(process.pid));
    });
    const output = collectingConsole();
    const options: ServerOptions = { port: 0, sessionsDir: join(dir, "sessions"), depsDir: root, helper: { command: process.execPath, args: [] }, prepareUpdater: () => Effect.succeed({ layer: updaterLayer(() => Effect.succeed({ ops: [] })) }) };
    const server = yield* startedServer(options, realLayers(options, fakeExportServices())).pipe(Effect.provideService(Console.Console, output.service));
    const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/deps/check?names=chromium`));
    expect(response.status).toBe(200);
    expect(existsSync(join(root, "chromium", names[0]!))).toBe(true);
    expect(existsSync(join(root, "chromium", names[1]!))).toBe(true);
    expect(yield* Effect.tryPromise(() => readFile(join(root, "chromium/install.lock"), "utf8"))).toBe(String(process.pid));
    expect(output.errors.some((line) => /警告|導入中|消せません|削除.*失敗/.test(line))).toBe(true);
  }).pipe(Effect.scoped));
});
