import { readFile, readlink, readdir, realpath, stat, symlink, mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, basename } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Result, Stream } from "effect";
import { NodeServices } from "@effect/platform-node";
import { vi } from "vitest";
import { ManagedDeps } from "../src/managedDeps.ts";
import { temporaryDeps, fakeNpm, managedLayer, install, installed } from "./fixtures/managedDeps.ts";

const calls = async (dir: string) => (await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
const check = Effect.gen(function* () { return yield* (yield* ManagedDeps).check(["chromium"]); });
const oldCurrent = async (root: string) => {
  const dir = join(root, "chromium");
  await mkdir(join(dir, "0.0.0-old"), { recursive: true });
  await writeFile(join(dir, "0.0.0-old", ".ready.json"), JSON.stringify({ version: "0.0.0", installedAt: "2026-01-01T00:00:00Z", hashes: {} }));
  await symlink("0.0.0-old", join(dir, "current"));
  return join(dir, "current");
};

const processInstaller = (dir: string, id: string, point: string) => {
  const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/managedDepsProcess.mjs"), dir, id, point], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += String(data); });
  child.stderr.on("data", (data) => { output += String(data); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  return { child, exit, output: () => output };
};
const reached = (dir: string, id: string) => vi.waitFor(async () => {
  expect(await readFile(join(dir, `${id}.reached`), "utf8")).not.toBe("");
}, { timeout: 10_000 });
const resume = (dir: string, id: string) => writeFile(join(dir, `${id}.resume`), "resume");
const finished = async (dir: string, id: string, worker: ReturnType<typeof processInstaller>, code: number) => {
  await vi.waitFor(async () => expect(await readFile(join(dir, `${id}.result`), "utf8")).not.toBe(""), { timeout: 10_000 });
  expect(await worker.exit, worker.output()).toBe(code);
  return await readFile(join(dir, `${id}.result`), "utf8");
};
const stopInstaller = async (worker: ReturnType<typeof processInstaller>) => {
  if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
  await worker.exit;
};

describe("管理 Chromium の導入", () => {
  it.live.each(["npm", "browser", "leader"])("親だけ死亡した %s の生存中は拒否し、終了後に同じルートで回復する", (stage) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      const base = join(dir, "deps/chromium");
      const current = await oldCurrent(join(dir, "deps"));
      const hold = join(dir, stage === "npm" ? "hold-npm" : "hold-browser");
      const pidFile = join(dir, stage === "npm" ? "npm-pid" : "browser-pid");
      await writeFile(hold, "hold");
      const first = processInstaller(dir, "first", "none");
      const workers = [first];
      let group: number | undefined;
      try {
        await vi.waitFor(async () => expect(Number(await readFile(pidFile, "utf8"))).toBeGreaterThan(0), { timeout: 10_000 });
        const pid = Number(await readFile(pidFile, "utf8"));
        const record = (await readdir(join(base, "install.lock.guard"))).find((name) => name.startsWith("execution-"));
        if (record === undefined) throw new Error("外部実行記録がありません");
        group = Number(await readFile(join(base, "install.lock.guard", record), "utf8"));
        const work = (await readdir(base)).find((name) => name.startsWith(".work-"));
        if (work === undefined) throw new Error("作業実体がありません");
        if (stage === "leader") process.kill(-group, "SIGKILL");
        await stopInstaller(first);
        process.kill(pid, 0);
        const before = await calls(dir);
        const lock = await readFile(join(base, "install.lock"), "utf8");
        const competing = processInstaller(dir, "competing", "none");
        workers.push(competing);
        expect(await finished(dir, "competing", competing, 1)).toContain("導入中です");
        expect(await calls(dir)).toEqual(before);
        expect((await stat(join(base, work))).isDirectory()).toBe(true);
        expect(await readlink(current)).toBe("0.0.0-old");
        expect(await readFile(join(base, "install.lock"), "utf8")).toBe(lock);
        await rm(hold);
        await vi.waitFor(() => expect(() => process.kill(group!, 0)).toThrow(), { timeout: 10_000 });
        const recovered = processInstaller(dir, "recovered", "none");
        workers.push(recovered);
        expect(await finished(dir, "recovered", recovered, 0)).toContain('"state":"ready"');
        expect(await readlink(current)).not.toBe("0.0.0-old");
        expect((await readdir(base)).filter((name) => name.startsWith(".work-") || name.startsWith("install.lock"))).toEqual([]);
      } finally {
        await rm(hold, { force: true });
        if (group !== undefined) {
          try { process.kill(group, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        for (const worker of workers) await stopInstaller(worker);
      }
    });
  }).pipe(Effect.scoped));

  it.live.each(["execution-before", "execution-after"])("%s の公開交差で旧ランナーは交代後の導入を開始しない", (point) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      const first = processInstaller(dir, "first", point);
      const workers = [first];
      let runner: number | undefined;
      try {
        await reached(dir, "first");
        runner = Number(await readFile(join(dir, "first.reached"), "utf8"));
        await stopInstaller(first);
        const second = processInstaller(dir, "second", "none");
        workers.push(second);
        const result = await finished(dir, "second", second, point === "execution-before" ? 0 : 1);
        if (point === "execution-after") expect(result).toContain("導入中です");
        await resume(dir, "first");
        await vi.waitFor(() => expect(() => process.kill(-runner!, 0)).toThrow(), { timeout: 10_000 });
        const recovered = processInstaller(dir, "recovered", "none");
        workers.push(recovered);
        expect(await finished(dir, "recovered", recovered, 0)).toContain(point === "execution-before" ? '"items":[]' : '"state":"ready"');
        expect((await calls(dir)).map((call) => call.kind)).toEqual(["npm", "browser"]);
        expect((await stat(join(dir, "deps/chromium/current/.ready.json"))).isFile()).toBe(true);
      } finally {
        await resume(dir, "first");
        if (runner !== undefined) {
          try { process.kill(-runner, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        for (const worker of workers) await stopInstaller(worker);
      }
    });
  }).pipe(Effect.scoped));

  it.live.each(["pid-read", "guard-read"])("独立プロセスの %s 回収交差は生存所有者と作業実体を保持する", (point) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(dead, "exit");
      const base = join(dir, "deps/chromium");
      await mkdir(base, { recursive: true });
      await writeFile(join(base, "install.lock"), String(dead.pid));
      if (point === "guard-read") {
        await mkdir(join(base, "install.lock.guard"));
        await writeFile(join(base, "install.lock.guard/dead-owner"), String(dead.pid));
      }
      await writeFile(join(dir, "hold-browser"), "hold");
      const first = processInstaller(dir, "first", point);
      let second: ReturnType<typeof processInstaller> | undefined;
      try {
        await reached(dir, "first");
        second = processInstaller(dir, "second", point === "guard-read" ? point : "none");
        if (point === "guard-read") {
          await reached(dir, "second");
          await resume(dir, "first");
        } else {
          expect(await finished(dir, "second", second, 1)).toContain("導入中です");
          await resume(dir, "first");
        }
        await vi.waitFor(async () => expect(await readFile(join(dir, "browser-started"), "utf8")).toBe("started"), { timeout: 10_000 });
        const lock = await readFile(join(base, "install.lock"), "utf8");
        expect(lock).toBe(String(first.child.pid));
        const work = (await readdir(base)).find((name) => name.startsWith(".work-"));
        expect(work).toBeDefined();
        if (work === undefined) throw new Error("所有者の作業実体がありません");
        if (point === "guard-read") {
          await resume(dir, "second");
          expect(await finished(dir, "second", second, 1)).toContain("導入中です");
        }
        expect(await readFile(join(base, "install.lock"), "utf8")).toBe(lock);
        expect((await stat(join(base, work))).isDirectory()).toBe(true);
        expect((await calls(dir)).filter((call) => call.kind === "npm")).toHaveLength(1);
        await rm(join(dir, "hold-browser"));
        expect(await finished(dir, "first", first, 0)).toContain('"state":"ready"');
        expect(await readdir(base)).not.toContain("install.lock.guard");
      } finally {
        await rm(join(dir, "hold-browser"), { force: true });
        await stopInstaller(first);
        if (second !== undefined) await stopInstaller(second);
      }
    });
  }).pipe(Effect.scoped));

  it.live("所有者記録の公開直後に死亡しても同じ管理ルートで再取得できる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      await writeFile(join(dir, "hold-browser"), "hold");
      const first = processInstaller(dir, "first", "guard-published");
      let second: ReturnType<typeof processInstaller> | undefined;
      try {
        await reached(dir, "first");
        await stopInstaller(first);
        await mkdir(join(dir, "deps/chromium/.work-abandoned"), { recursive: true });
        await rm(join(dir, "hold-browser"));
        second = processInstaller(dir, "second", "none");
        expect(await finished(dir, "second", second, 0)).toContain('"state":"ready"');
        expect((await readdir(join(dir, "deps/chromium"))).filter((name) => name.startsWith(".work-") || name === "install.lock" || name === "install.lock.guard")).toEqual([]);
        expect(await realpath(join(dir, "deps/chromium/current"))).not.toContain(".work-");
      } finally {
        await rm(join(dir, "hold-browser"), { force: true });
        await stopInstaller(first);
        if (second !== undefined) await stopInstaller(second);
      }
    });
  }).pipe(Effect.scoped));

  it.live("解放中に新所有者が取得しても古い所有者は補助排他を削除しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    yield* fakeNpm(dir);
    yield* Effect.tryPromise(async () => {
      const first = processInstaller(dir, "first", "owner-released");
      let second: ReturnType<typeof processInstaller> | undefined;
      try {
        await reached(dir, "first");
        await rm(join(dir, "deps/chromium/browsers/chromium_headless_shell-999/INSTALLATION_COMPLETE"));
        await rm(join(dir, "browser-started"));
        await writeFile(join(dir, "hold-browser"), "hold");
        second = processInstaller(dir, "second", "none");
        await vi.waitFor(async () => expect(await readFile(join(dir, "browser-started"), "utf8")).toBe("started"), { timeout: 10_000 });
        const base = join(dir, "deps/chromium");
        const owners = (await readdir(join(base, "install.lock.guard"))).filter((name) => !name.startsWith("execution-"));
        expect(owners).toHaveLength(1);
        expect(await readFile(join(base, "install.lock"), "utf8")).toBe(String(second.child.pid));
        await resume(dir, "first");
        await finished(dir, "first", first, 0);
        expect((await readdir(join(base, "install.lock.guard"))).filter((name) => !name.startsWith("execution-"))).toEqual(owners);
        expect(await readFile(join(base, "install.lock"), "utf8")).toBe(String(second.child.pid));
        expect((await calls(dir)).filter((call) => call.kind === "npm")).toHaveLength(2);
        await rm(join(dir, "hold-browser"));
        expect(await finished(dir, "second", second, 0)).toContain('"state":"ready"');
      } finally {
        await rm(join(dir, "hold-browser"), { force: true });
        await stopInstaller(first);
        if (second !== undefined) await stopInstaller(second);
      }
    });
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
    expect(yield* check.pipe(Effect.provide(managedLayer(root)))).toMatchObject([{ state: "outdated" }]);
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

  it.live("死亡 pid の lock と .work 残骸を回収して導入する", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    yield* Effect.tryPromise(() => once(child, "exit"));
    expect(pid).toBeTypeOf("number");
    yield* Effect.tryPromise(async () => {
      await mkdir(join(root, "chromium/.work-abandoned"), { recursive: true });
      await writeFile(join(root, "chromium/install.lock"), String(pid));
    });
    yield* install().pipe(Effect.provide(managedLayer(root, npm)));
    expect(yield* check.pipe(Effect.provide(managedLayer(root, npm)))).toMatchObject([installed]);
    expect(yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).not.toContain(".work-abandoned");
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

  it.live("導入の中断は子プロセスを終了してから lock を解放し、次回導入できる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    const current = yield* Effect.tryPromise(() => oldCurrent(root));
    yield* Effect.tryPromise(() => writeFile(join(dir, "hold-browser"), "hold"));
    yield* Effect.gen(function* () {
      const fiber = yield* install().pipe(Effect.forkChild);
      yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await readFile(join(dir, "browser-started"), "utf8")).toBe("started")));
      const pid = Number(yield* Effect.tryPromise(() => readFile(join(dir, "browser-pid"), "utf8")));
      yield* Fiber.interrupt(fiber);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(yield* Effect.tryPromise(() => readlink(current))).toBe("0.0.0-old");
      expect((yield* Effect.tryPromise(() => readdir(join(root, "chromium")))).filter((name) => name.startsWith("install.lock") || name.startsWith(".work-"))).toEqual([]);
      yield* Effect.tryPromise(() => rm(join(dir, "hold-browser")));
      yield* install();
      expect(yield* check).toMatchObject([installed]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("死亡 lock の同時回収でも一つだけ導入し、競合側は所有 lock を削除しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    yield* Effect.tryPromise(() => once(child, "exit"));
    yield* Effect.tryPromise(async () => {
      await mkdir(join(root, "chromium/.work-abandoned"), { recursive: true });
      await writeFile(join(root, "chromium/install.lock"), String(child.pid));
      await writeFile(join(dir, "hold-browser"), "hold");
    });
    yield* Effect.gen(function* () {
      const first = yield* install().pipe(Effect.result, Effect.forkChild);
      const second = yield* install().pipe(Effect.result, Effect.forkChild);
      try {
        yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await readFile(join(dir, "browser-started"), "utf8")).toBe("started")));
        expect((yield* Effect.tryPromise(() => calls(dir))).filter((call) => call.kind === "npm")).toHaveLength(1);
        expect(yield* Effect.tryPromise(() => readFile(join(root, "chromium/install.lock"), "utf8"))).toBe(String(process.pid));
      } finally { yield* Effect.tryPromise(() => rm(join(dir, "hold-browser"), { force: true })); }
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      const failure = results.find(Result.isFailure);
      expect(String(failure?.failure)).toContain("導入中です");
      expect(yield* check).toMatchObject([installed]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
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
        if (hashes === 2) { reached = true; return Stream.succeed(new Uint8Array([1])); }
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
