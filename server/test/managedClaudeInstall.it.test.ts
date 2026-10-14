import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, readlink, realpath, symlink, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Result, Stream } from "effect";
import { vi } from "vitest";
import { ManagedDeps } from "../src/managedDeps.ts";
import { fakeNpm, managedLayer, temporaryDeps } from "./fixtures/managedDeps.ts";

const ready = { name: "claude", state: "ready" } as const;
const fakeInstaller = Effect.fnUntraced(function* (root: string) {
  const chromium = yield* fakeNpm(root);
  const script = join(root, "sdk-npm.cjs");
  yield* Effect.tryPromise(() => writeFile(script, `
const fs = require('node:fs');
const path = require('node:path');
const control = ${JSON.stringify(root)};
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const name = '@anthropic-ai/claude-agent-sdk';
if (!manifest.dependencies[name]) { require(${JSON.stringify(chromium.args[0])}); }
else {
  fs.appendFileSync(path.join(control, 'sdk-calls'), JSON.stringify(process.argv.slice(2)) + '\\n');
  fs.writeFileSync(path.join(control, 'sdk-started'), String(process.pid));
  const waiting = new Int32Array(new SharedArrayBuffer(4));
  while (fs.existsSync(path.join(control, 'hold-sdk'))) Atomics.wait(waiting, 0, 0, 10);
  if (fs.existsSync(path.join(control, 'fail-sdk'))) { console.error('synthetic npm failure'); process.exit(17); }
  const pkg = path.join('node_modules', name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version: manifest.dependencies[name], type: 'module', exports: { '.': './sdk.mjs' } }));
  fs.writeFileSync(path.join(pkg, 'sdk.mjs'), "export const query = () => { throw new Error('query must not run'); };\\n");
  const binaryPkg = name + '-' + process.platform + '-' + process.arch;
  const binaryDir = path.join('node_modules', binaryPkg);
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(path.join(binaryDir, 'package.json'), JSON.stringify({ name: binaryPkg, version: manifest.dependencies[name] }));
  fs.writeFileSync(path.join(binaryDir, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'synthetic CLI binary', { mode: 0o755 });
}
`));
  return { command: process.execPath, args: [script] };
});
const install = Effect.fnUntraced(function* (names: string[]) {
  return yield* Stream.runCollect((yield* ManagedDeps).install(names));
});
const oldCurrent = async (root: string) => {
  const old = join(root, "claude/old");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, ".ready.json"), JSON.stringify({ version: "0.0.0", installedAt: "2000-01-01T00:00:00Z", hashes: {} }));
  await symlink("old", join(root, "claude/current"));
};
const leftovers = async (root: string) => (await readdir(join(root, "claude"))).filter((name) => name.startsWith(".work-") || name.startsWith("install.lock"));

describe("管理 Claude SDK の導入と公開", () => {
  it.live("未導入から固定版を導入し、ready の管理 SDK を読める", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeInstaller(dir);
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      expect(yield* deps.check(["claude"])).toMatchObject([{ name: "claude", state: "missing" }]);
      const events = yield* install(["claude"]);
      expect(events.filter((event) => event.type === "result")).toMatchObject([{ type: "result", items: [ready] }]);
      expect(yield* deps.check(["claude"])).toMatchObject([ready]);
      const record = JSON.parse(yield* Effect.tryPromise(() => readFile(join(root, "claude/current/.ready.json"), "utf8"))) as { hashes: Record<string, string> };
      const entity = basename(yield* Effect.tryPromise(() => realpath(join(root, "claude/current"))));
      const binary = join(root, "claude", entity, "node_modules", `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === "win32" ? "claude.exe" : "claude");
      expect(record.hashes).toEqual({ [binary]: createHash("sha256").update("synthetic CLI binary").digest("hex") });
      expect(yield* Effect.tryPromise(() => readFile(binary, "utf8"))).toBe("synthetic CLI binary");
      const module = yield* deps.load("claude");
      expect((module as unknown as { query: unknown }).query).toBeTypeOf("function");
      expect(yield* Effect.tryPromise(() => leftovers(root))).toEqual([]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("Chromium と Claude の同時要求は最終 result を一度だけ返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const npm = yield* fakeInstaller(dir);
    const events = yield* install(["chromium", "claude"]).pipe(Effect.provide(managedLayer(join(dir, "deps"), npm)));
    const results = events.filter((event) => event.type === "result");
    expect(results).toHaveLength(1);
    expect(events.at(-1)).toEqual(results[0]);
    expect(results[0]).toMatchObject({ items: [{ name: "chromium", state: "ready" }, ready] });
  }).pipe(Effect.scoped));

  it.live("npm 失敗後は旧 current を保持して後片付けし、同じルートで再導入できる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeInstaller(dir);
    yield* Effect.tryPromise(async () => { await oldCurrent(root); await writeFile(join(dir, "fail-sdk"), "fail"); });
    yield* Effect.gen(function* () {
      const result = yield* Effect.result(install(["claude"]));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain("synthetic npm failure");
      expect(yield* Effect.tryPromise(() => readFile(join(dir, "sdk-calls"), "utf8"))).not.toBe("");
      expect(yield* Effect.tryPromise(() => readlink(join(root, "claude/current")))).toBe("old");
      expect(yield* Effect.tryPromise(() => leftovers(root))).toEqual([]);
      yield* Effect.tryPromise(() => rm(join(dir, "fail-sdk")));
      yield* install(["claude"]);
      expect(yield* (yield* ManagedDeps).check(["claude"])).toMatchObject([ready]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));

  it.live("導入中断は子プロセスを終了し、旧 current を保持して再導入できる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const npm = yield* fakeInstaller(dir);
    yield* Effect.tryPromise(async () => { await oldCurrent(root); await writeFile(join(dir, "hold-sdk"), "hold"); });
    yield* Effect.gen(function* () {
      expect(yield* (yield* ManagedDeps).check(["claude"])).toMatchObject([{ name: "claude", state: "outdated" }]);
      const fiber = yield* install(["claude"]).pipe(Effect.forkChild);
      try {
        yield* Effect.tryPromise(() => vi.waitFor(async () => expect(Number(await readFile(join(dir, "sdk-started"), "utf8"))).toBeGreaterThan(0)));
        const pid = Number(yield* Effect.tryPromise(() => readFile(join(dir, "sdk-started"), "utf8")));
        yield* Fiber.interrupt(fiber);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(yield* Effect.tryPromise(() => readlink(join(root, "claude/current")))).toBe("old");
        expect(yield* Effect.tryPromise(() => leftovers(root))).toEqual([]);
      } finally {
        yield* Fiber.interrupt(fiber);
        yield* Effect.tryPromise(() => rm(join(dir, "hold-sdk"), { force: true }));
      }
      yield* install(["claude"]);
      expect(yield* (yield* ManagedDeps).check(["claude"])).toMatchObject([ready]);
    }).pipe(Effect.provide(managedLayer(root, npm)));
  }).pipe(Effect.scoped));
});
