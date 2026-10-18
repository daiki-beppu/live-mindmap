import { readFile, readlink, readdir, realpath, stat, symlink, mkdir, writeFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Result, Stream } from "effect";
import { NodeServices } from "@effect/platform-node";
import { vi } from "vitest";
import claudeManifest from "../managed-deps/claude/package.json" with { type: "json" };
import { ManagedDeps } from "../src/managedDeps.ts";
import { calls, check, fakeNpm, install, installed, managedLayer, oldCurrent, temporaryDeps } from "./fixtures/managedDeps.ts";

describe("管理 Chromium の導入", () => {
  it.live.each([undefined, "1"])("713: 親の GC 無効設定=%s でも差し替えと旧実体削除の後に公開 CLI で GC し、完了後に result を返す", (skipGc) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const base = join(root, "chromium");
    const oldName = "0.0.0-11111111-1111-4111-8111-111111111111";
    const old = join(base, oldName);
    const current = join(base, "current");
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      await mkdir(old, { recursive: true });
      await writeFile(join(old, ".ready.json"), JSON.stringify({ version: "0.0.0", installedAt: "2026-01-01T00:00:00Z", hashes: {} }));
      await symlink(oldName, current);
      await writeFile(join(dir, "observe-browser.json"), JSON.stringify({ current, old }));
    });
    const oldPath = yield* Effect.tryPromise(() => realpath(old));
    vi.stubEnv("PLAYWRIGHT_SKIP_BROWSER_GC", skipGc);
    try {
      yield* Effect.gen(function* () {
        const deps = yield* ManagedDeps;
        expect(yield* deps.check(["chromium"])).toMatchObject([{ state: "outdated" }]);
        expect(yield* Effect.tryPromise(() => realpath(current))).toBe(oldPath);
        const events = yield* Stream.runCollect(deps.update(["chromium"]).pipe(Stream.tap((event) => event.type === "result"
          ? Effect.tryPromise(async () => {
            const completed = (await readFile(join(dir, "browser-completed.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
            expect(completed).toHaveLength(2);
            expect(completed[1].cli).toBe(join(await realpath(current), "node_modules/playwright-core/cli.js"));
          }) : Effect.void)));
        const published = yield* Effect.tryPromise(() => realpath(current));
        expect(published).not.toBe(oldPath);
        const recorded = yield* Effect.tryPromise(() => calls(dir));
        expect(recorded.map((call) => [call.kind, call.args])).toEqual([
          ["npm", ["ci", "--omit=dev", "--omit=peer", "--ignore-scripts"]],
          ["browser", ["install", "--only-shell", "chromium"]],
          ["browser", ["install", "--only-shell", "chromium"]],
        ]);
        expect(recorded[1]).toMatchObject({ skipGc: "1", current: oldPath, oldExists: true, browsers: join(base, "browsers") });
        expect(recorded[2]).toMatchObject({ skipGc: null, current: published, oldExists: false, browsers: join(base, "browsers") });
        expect(recorded[2].cli).toBe(join(published, "node_modules/playwright-core/cli.js"));
        expect(events.at(-1)).toEqual({ type: "result", items: [installed] });
        expect(yield* deps.check(["chromium"])).toEqual([installed]);
        expect(process.env.PLAYWRIGHT_SKIP_BROWSER_GC).toBe(skipGc);
      }).pipe(Effect.provide(managedLayer(root, npm)));
    } finally { vi.unstubAllEnvs(); }
  }).pipe(Effect.scoped));

  it.live("713: 2 回目の CLI の失敗は result 前に警告し、同じサービスと公開済み current を ready のまま保持する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const current = yield* Effect.tryPromise(() => oldCurrent(root));
    const old = yield* Effect.tryPromise(() => realpath(current));
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      await writeFile(join(dir, "observe-browser.json"), JSON.stringify({ current, old }));
      await writeFile(join(dir, "fail-browser-second"), "fail");
    });
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      expect(yield* deps.check(["chromium"])).toMatchObject([{ state: "outdated" }]);
      const events = yield* Stream.runCollect(deps.update(["chromium"]));
      const recorded = (yield* Effect.tryPromise(() => calls(dir))).filter((call) => call.kind === "browser");
      expect(recorded).toHaveLength(2);
      const failedCurrent = yield* Effect.tryPromise(() => readFile(join(dir, "browser-second-failed"), "utf8"));
      expect(failedCurrent).not.toBe(old);
      expect(recorded[1]).toMatchObject({ current: failedCurrent, skipGc: null });
      expect(yield* Effect.tryPromise(() => realpath(current))).toBe(failedCurrent);
      expect((yield* Effect.tryPromise(() => stat(join(failedCurrent, ".ready.json")))).isFile()).toBe(true);
      expect((yield* Effect.tryPromise(() => stat(join(root, "chromium/browsers/chromium_headless_shell-999/INSTALLATION_COMPLETE")))).isFile()).toBe(true);
      const warningIndex = events.findIndex((event) => event.type === "progress" && /警告/.test(event.message) && event.message.includes("browser GC failed"));
      expect(warningIndex).toBeGreaterThanOrEqual(0);
      expect(warningIndex).toBeLessThan(events.findIndex((event) => event.type === "result"));
      expect(events.at(-1)).toEqual({ type: "result", items: [installed] });
      expect(yield* deps.check(["chromium"])).toEqual([installed]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live.each(["ready", "missing"] as const)("711-4: 同じ ManagedDeps で outdated を更新し、%s の依存には触らない", (state) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      yield* Effect.tryPromise(() => oldCurrent(root));
      if (state === "ready") yield* Effect.tryPromise(async () => {
        const current = join(root, "claude/current");
        const version = claudeManifest.dependencies["@anthropic-ai/claude-agent-sdk"];
        const sdk = join(current, "node_modules/@anthropic-ai/claude-agent-sdk");
        const binary = join(current, `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`);
        await mkdir(sdk, { recursive: true });
        await mkdir(binary, { recursive: true });
        await writeFile(join(current, ".ready.json"), JSON.stringify({ version, installedAt: "2026-01-01T00:00:00Z", hashes: {} }));
        await writeFile(join(sdk, "package.json"), JSON.stringify({ version }));
        await writeFile(join(binary, process.platform === "win32" ? "claude.exe" : "claude"), "ready SDK");
      });
      const before = yield* deps.check(["chromium", "claude"]);
      expect(before).toMatchObject([{ state: "outdated" }, { name: "claude", state }]);
      const events = yield* Stream.runCollect(deps.update(["chromium", "claude"]));
      expect(events.filter((event) => event.type === "result")).toMatchObject([{ type: "result", items: [installed] }]);
      expect(yield* deps.check(["chromium", "claude"])).toMatchObject([installed, { name: "claude", state }]);
      expect((yield* Effect.tryPromise(() => calls(dir))).filter((call) => call.kind === "npm")).toHaveLength(1);
      expect((yield* Effect.tryPromise(() => readdir(root))).sort()).toEqual(state === "ready" ? ["chromium", "claude"] : ["chromium"]);
      const again = yield* Stream.runCollect(deps.update(["chromium"]));
      expect(again.at(-1)).toMatchObject({ type: "result", items: [] });
      expect((yield* Effect.tryPromise(() => calls(dir))).filter((call) => call.kind === "npm")).toHaveLength(1);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("711-4: update 失敗後は旧 current を保持し、同じサービスで再更新できる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const current = yield* Effect.tryPromise(() => oldCurrent(root));
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(() => writeFile(join(dir, "fail-npm"), "fail"));
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const result = yield* Effect.result(Stream.runCollect(deps.update(["chromium"])));
      expect(Result.isFailure(result)).toBe(true);
      expect((yield* Effect.tryPromise(() => calls(dir)))[0].kind).toBe("npm");
      expect(yield* Effect.tryPromise(() => readlink(current))).toBe("0.0.0-old");
      expect((yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).filter((name) => name.startsWith(".work-") || name.startsWith("install.lock"))).toEqual([]);
      expect(yield* deps.check(["chromium"])).toMatchObject([{ state: "outdated" }]);
      yield* Effect.tryPromise(() => rm(join(dir, "fail-npm")));
      expect((yield* Stream.runCollect(deps.update(["chromium"]))).at(-1)).toMatchObject({ type: "result", items: [installed] });
      expect(yield* deps.check(["chromium"])).toMatchObject([installed]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("固定版を作業実体へ入れ、完了した shell と記録を持つ正式実体だけを公開する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    const layer = managedLayer(root, npm);
    expect(yield* check.pipe(Effect.provide(layer))).toMatchObject([{ name: "chromium", need: "optional", state: "missing" }]);
    const events = yield* install().pipe(Effect.provide(layer));
    expect(events.at(-1)).toMatchObject({ type: "result", items: [installed] });
    const current = yield* Effect.tryPromise(() => realpath(join(root, "chromium", "current")));
    expect(basename(current)).not.toMatch(/^\.work-/);
    const pkg = JSON.parse(yield* Effect.tryPromise(() => readFile(join(current, "node_modules/playwright-core/package.json"), "utf8")));
    const ready = JSON.parse(yield* Effect.tryPromise(() => readFile(join(current, ".ready.json"), "utf8")));
    expect(basename(current)).toMatch(new RegExp(`^${pkg.version.replaceAll(".", "\\.")}-`));
    expect(ready.version).toBe(pkg.version);
    expect(Number.isFinite(Date.parse(ready.installedAt))).toBe(true);
    expect(JSON.stringify(ready)).toContain("7a3dfeea5125c82fc9786f1c733a130ab407a56f8cc2eee1014e229640505cb6");
    expect((yield* Effect.tryPromise(() => stat(join(root, "chromium/browsers/chromium_headless_shell-999/INSTALLATION_COMPLETE")))).isFile()).toBe(true);
    const recorded = yield* Effect.tryPromise(() => calls(dir));
    expect(recorded.map((call) => [call.kind, call.args])).toEqual([
      ["npm", ["ci", "--omit=dev", "--omit=peer", "--ignore-scripts"]],
      ["browser", ["install", "--only-shell", "chromium"]],
      ["browser", ["install", "--only-shell", "chromium"]],
    ]);
    expect(basename(recorded[0].cwd)).toMatch(/^\.work-/);
    expect(recorded[1].browsers).toBe(join(root, "chromium/browsers"));
    expect(yield* check.pipe(Effect.provide(layer))).toMatchObject([installed]);
    expect(yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).not.toContain("install.lock");
  }).pipe(Effect.scoped));

  it.live("ready なら再導入せず、同じサービスは marker の消失を次の check で認識する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    yield* Effect.gen(function* () {
      yield* install();
      expect(yield* check).toMatchObject([installed]);
      const current = yield* Effect.tryPromise(() => realpath(join(root, "chromium/current")));
      const ready = yield* Effect.tryPromise(() => readFile(join(current, ".ready.json"), "utf8"));
      yield* Effect.tryPromise(async () => {
        for (const platform of ["mac-arm64", "mac-x64", "linux64"]) {
          await writeFile(join(root, `chromium/browsers/chromium_headless_shell-999/chrome-headless-shell-${platform}/chrome-headless-shell`), "changed after install");
        }
      });
      expect(yield* check).toMatchObject([installed]);
      expect(yield* Effect.tryPromise(() => readFile(join(current, ".ready.json"), "utf8"))).toBe(ready);
      const before = yield* Effect.tryPromise(() => calls(dir));
      expect((yield* install()).at(-1)).toMatchObject({ type: "result", items: [] });
      expect(yield* Effect.tryPromise(() => calls(dir))).toEqual(before);
      yield* Effect.tryPromise(() => rm(join(root, "chromium/browsers/chromium_headless_shell-999/INSTALLATION_COMPLETE")));
      expect(yield* check).toMatchObject([{ state: "missing" }]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("固定版と異なる記録は outdated", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    yield* Effect.tryPromise(() => oldCurrent(root));
    expect(yield* check.pipe(Effect.provide(managedLayer(root)))).toMatchObject([{ state: "outdated", version: "0.0.0" }]);
  }).pipe(Effect.scoped));

  it.live("記録が固定版でも実パッケージが異なれば outdated とその版を返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    yield* Effect.gen(function* () {
      yield* install();
      expect(yield* check).toMatchObject([installed]);
      yield* Effect.tryPromise(() => writeFile(join(root, "chromium/current/node_modules/playwright-core/package.json"), JSON.stringify({ version: "0.0.0" })));
      expect(yield* check).toMatchObject([{ state: "outdated", version: "0.0.0" }]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live.each(["fail-npm", "fail-browser", "omit-marker"])("%s で失敗しても current を保持し、次の導入で回復できる", (failure) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const current = yield* Effect.tryPromise(() => oldCurrent(root));
    const npm = yield* fakeNpm(dir);
    const layer = managedLayer(root, npm);
    yield* Effect.tryPromise(() => writeFile(join(dir, failure), "fail"));
    const result = yield* Effect.result(install().pipe(Effect.provide(layer)));
    expect(Result.isFailure(result)).toBe(true);
    const recorded = yield* Effect.tryPromise(() => calls(dir));
    expect(recorded.some((call) => call.kind === (failure === "fail-npm" ? "npm" : "browser"))).toBe(true);
    if (failure === "fail-npm" && Result.isFailure(result)) expect(String(result.failure)).toMatch(/導入に失敗しました:.*npm failure last line/s);
    expect(yield* Effect.tryPromise(() => readlink(current))).toBe("0.0.0-old");
    expect((yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).filter((name) => name.startsWith(".work-") || name === "install.lock")).toEqual([]);
    yield* Effect.tryPromise(() => rm(join(dir, failure)));
    yield* install().pipe(Effect.provide(layer));
    expect(yield* check.pipe(Effect.provide(layer))).toMatchObject([installed]);
  }).pipe(Effect.scoped));

  it.live("初回の npm 失敗は current を作らない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(() => writeFile(join(dir, "fail-npm"), "fail"));
    expect(Result.isFailure(yield* Effect.result(install().pipe(Effect.provide(managedLayer(root, npm)))))).toBe(true);
    expect((yield* Effect.tryPromise(() => calls(dir)))[0].kind).toBe("npm");
    expect(yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).not.toContain("current");
  }).pipe(Effect.scoped));

  it.live("導入保留中は旧 current を保持し、競合を待たず拒否し、完了してから差し替える", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const current = yield* Effect.tryPromise(() => oldCurrent(root));
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(() => writeFile(join(dir, "hold-browser"), "hold"));
    yield* Effect.gen(function* () {
      const fiber = yield* install().pipe(Effect.forkChild);
      try {
        yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await readFile(join(dir, "browser-started"), "utf8")).toBe("started")));
        expect(yield* Effect.tryPromise(() => readlink(current))).toBe("0.0.0-old");
        const lock = yield* Effect.tryPromise(() => readFile(join(root, "chromium/install.lock"), "utf8"));
        const result = yield* Effect.result(install().pipe(Effect.timeout("1 second")));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(String(result.failure)).toContain("導入中です");
        expect(yield* Effect.tryPromise(() => readFile(join(root, "chromium/install.lock"), "utf8"))).toBe(lock);
        expect((yield* Effect.tryPromise(() => calls(dir))).filter((call) => call.kind === "npm")).toHaveLength(1);
      } finally {
        yield* Effect.tryPromise(() => rm(join(dir, "hold-browser"), { force: true }));
      }
      yield* Fiber.join(fiber);
      expect(yield* Effect.tryPromise(() => readlink(current))).not.toBe("0.0.0-old");
      expect(yield* check).toMatchObject([installed]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("生存 pid の lock は保持し、他の導入の作業実体を掃除しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      await mkdir(join(root, "chromium/.work-active"), { recursive: true });
      await writeFile(join(root, "chromium/install.lock"), String(process.pid));
    });
    const result = yield* Effect.result(install().pipe(Effect.provide(managedLayer(root, npm)), Effect.timeout("1 second")));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("導入中です");
    expect(yield* Effect.tryPromise(() => readFile(join(root, "chromium/install.lock"), "utf8"))).toBe(String(process.pid));
    expect(yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).toContain(".work-active");
    expect((yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).filter((name) => name.startsWith("install.lock.guard"))).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("PID 検証で取得に失敗しても補助排他と候補を解放する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      await mkdir(join(root, "chromium/.work-retained"), { recursive: true });
      await writeFile(join(root, "chromium/install.lock"), "invalid");
    });
    const result = yield* Effect.result(install().pipe(Effect.provide(managedLayer(root, npm))));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("pid が不正です");
    expect(yield* Effect.tryPromise(() => readFile(join(root, "chromium/install.lock"), "utf8"))).toBe("invalid");
    expect(yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).toEqual([".work-retained", "install.lock"]);
    yield* Effect.tryPromise(() => rm(join(root, "chromium/install.lock")));
    yield* install().pipe(Effect.provide(managedLayer(root, npm)));
    expect(yield* check.pipe(Effect.provide(managedLayer(root, npm)))).toMatchObject([installed]);
  }).pipe(Effect.scoped));

  it.live.each(["publish", "hash"])("%s の確認失敗でも current を保持して作業実体を捨てる", (failure) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    const current = yield* Effect.tryPromise(() => oldCurrent(root));
    const fs = yield* FileSystem.FileSystem;
    let reached = false;
    let hashes = 0;
    const altered: FileSystem.FileSystem = {
      ...fs,
      rename: (from, to) => to === current ? Effect.sync(() => { reached = true; }).pipe(Effect.andThen(Effect.die("publish failure"))) : fs.rename(from, to),
      stream: (path, options) => {
        if (failure !== "hash") return fs.stream(path, options);
        hashes++;
        if (hashes === 1) { reached = true; return Stream.die("hash failure"); }
        return fs.stream(path, options);
      },
    };
    const layer = ManagedDeps.layer({ root, npm }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, altered))));
    // rename の失敗は defect として注入するため、cause で成功/失敗を観測する。
    const result = yield* install().pipe(Effect.provide(layer), Effect.exit);
    expect(result._tag).toBe("Failure");
    expect(reached).toBe(true);
    expect(yield* Effect.tryPromise(() => readlink(current))).toBe("0.0.0-old");
    expect((yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).filter((name) => name !== "browsers" && name !== "current")).toEqual(["0.0.0-old"]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped));
});
