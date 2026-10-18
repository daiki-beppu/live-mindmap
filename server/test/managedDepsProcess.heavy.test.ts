import { readFile, readlink, readdir, realpath, stat, mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Result } from "effect";
import { vi } from "vitest";
import { calls, check, fakeNpm, install, installed, managedLayer, oldCurrent, temporaryDeps } from "./fixtures/managedDeps.ts";

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

// プロセスをまたぐ lock の排他、SIGKILL の後に残る lock、プロセスグループの終了、pid の生存で結果が決まる契約。
describe("管理 Chromium の導入（プロセスをまたぐ排他）", () => {
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
        expect((await calls(dir)).map((call) => call.kind)).toEqual(["npm", "browser", "browser"]);
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

  // 回収前のゾンビだけのグループは、kill(-pgid, 0) で生存と見える（macOS は EPERM、Linux は成功。#1111）。親が回収を止めている間だけ
  // そう見えるグループを、実行記録の別グループとして足す。親は stdin が閉じるまで同期で止まり、閉じると終わってゾンビが init（launchd）に回収される。
  const isZombie = async (pid: number) => {
    if (process.platform !== "darwin") return (await readFile(`/proc/${pid}/stat`, "utf8")).includes(") Z ");
    try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  };
  const interruptWithZombie = Effect.fnUntraced(function* (reap: boolean) {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeNpm(dir);
    yield* Effect.tryPromise(() => oldCurrent(root));
    yield* Effect.tryPromise(() => writeFile(join(dir, "hold-browser"), "hold"));
    const base = join(root, "chromium");
    const fiber = yield* install().pipe(Effect.provide(managedLayer(root, npm)), Effect.forkChild);
    yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await readFile(join(dir, "browser-started"), "utf8")).toBe("started")));
    const runner = Number(yield* Effect.tryPromise(() => readFile(join(dir, "browser-pid"), "utf8")));
    const reaper = yield* Effect.acquireRelease(Effect.sync(() => spawn(process.execPath, ["-e", `
const fs = require('node:fs');
const zombie = require('node:child_process').spawn('/usr/bin/true', [], { detached: true, stdio: 'ignore' });
fs.writeSync(1, String(zombie.pid));
try { fs.readSync(0, Buffer.alloc(1)); } catch {}
`], { stdio: ["pipe", "pipe", "inherit"] })), (child) => Effect.sync(() => { child.kill("SIGKILL"); }));
    const zombie = Number(String((yield* Effect.tryPromise(() => once(reaper.stdout!, "data")))[0]));
    yield* Effect.tryPromise(() => vi.waitFor(async () => expect(await isZombie(zombie)).toBe(true)));
    yield* Effect.tryPromise(() => writeFile(join(base, "install.lock.guard", "execution-zombie"), String(-zombie)));
    // Effect が導入ランナーを止め終えた（後片付けが子孫を確かめ始める）後に、ゾンビの回収を許す。
    const release = reap ? yield* Effect.tryPromise(() => vi.waitFor(() => expect(() => process.kill(runner, 0)).toThrow(), { timeout: 10_000 }).then(() => { reaper.stdin!.end(); })).pipe(Effect.forkChild) : undefined;
    yield* Fiber.interrupt(fiber);
    if (release !== undefined) yield* Fiber.join(release);
    return (yield* Effect.tryPromise(() => readdir(base))).filter((name) => name.startsWith("install.lock") || name.startsWith(".work-"));
  });

  it.live("中断の後片付けは、生存と見える回収前の子孫が消えるのを待ってから作業実体と lock を片付ける", () => Effect.gen(function* () {
    expect(yield* interruptWithZombie(true)).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("中断の後も期限内に子孫が消えなければ、作業実体と lock を残す", () => Effect.gen(function* () {
    const left = yield* interruptWithZombie(false);
    expect(left.some((name) => name.startsWith(".work-"))).toBe(true);
    expect(left).toContain("install.lock");
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
});
