import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, PlatformError, Result, Stream } from "effect";
import { ManagedDeps, ManagedDepsFailed } from "../src/managedDeps.ts";
import { fakeNpm, temporaryDeps } from "./fixtures/managedDeps.ts";
import { archive, CONTENT } from "./fixtures/cloudflared.ts";

const installed = { name: "cloudflared", need: "optional", state: "ready" } as const;

const oldEntity = async (root: string) => {
  const name = "2026.8.0-11111111-1111-4111-8111-111111111111";
  const entity = join(root, "cloudflared", name);
  const binary = join(entity, "cloudflared");
  await mkdir(entity, { recursive: true });
  await writeFile(binary, CONTENT, { mode: 0o755 });
  await writeFile(join(entity, ".ready.json"), JSON.stringify({
    version: "2026.8.0", installedAt: "2026-01-01T00:00:00Z",
    hashes: { [binary]: createHash("sha256").update(CONTENT).digest("hex") },
  }));
  await symlink(name, join(root, "cloudflared/current"));
  return { entity, binary, name };
};

const transientNames = (names: string[]) => names.filter((name) => name.startsWith(".work-") || name.startsWith("install.lock"));

describe("管理 cloudflared の導入", () => {
  it.live("ARCH-001: binary の通常 I/O 障害は check・install・取得で伝播し、再取得しない", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const fixture = yield* archive(dir);
    const fs = yield* FileSystem.FileSystem;
    let denied: string | undefined;
    let reached = 0;
    let downloads = 0;
    const altered = FileSystem.FileSystem.of({ ...fs, stream: (path, options) => {
      if (path !== denied) return fs.stream(path, options);
      reached++;
      return Stream.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "stream", pathOrDescriptor: path, description: "synthetic binary read denied" }));
    } });
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      yield* Stream.runDrain(deps.install(["cloudflared"]));
      expect(downloads).toBe(1);
      expect(yield* deps.check(["cloudflared"])).toEqual([installed]);
      denied = yield* deps.executable("cloudflared");
      for (const operation of [deps.check(["cloudflared"]).pipe(Effect.asVoid), Stream.runDrain(deps.install(["cloudflared"])), deps.executable("cloudflared").pipe(Effect.asVoid)]) {
        const result = yield* Effect.result(operation);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(ManagedDepsFailed);
          expect(result.failure.message).toContain("synthetic binary read denied");
        }
      }
      expect(reached).toBe(3);
      expect(downloads).toBe(1);
      denied = undefined;
      expect(yield* deps.check(["cloudflared"])).toEqual([installed]);
      const binary = yield* deps.executable("cloudflared");
      expect(yield* Effect.tryPromise(() => readFile(binary, "utf8"))).toBe(CONTENT);
    }).pipe(Effect.provide(ManagedDeps.layer({ root, cloudflared: {
      resolve: Effect.succeed(fixture.artifact),
      download: (_url: string, destination: string) => Effect.tryPromise(async () => { downloads++; await copyFile(fixture.path, destination); }),
    } }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, altered))))));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped));
  it.live("831 C4: 環境解決の拒否を取得前に返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    let resolved = false;
    let downloaded = false;
    const options = { root, cloudflared: {
      resolve: Effect.sync(() => { resolved = true; }).pipe(Effect.andThen(Effect.fail(new ManagedDepsFailed({ message: "未対応の環境: linux/arm64" })))),
      download: (_url: string, _destination: string) => Effect.sync(() => { downloaded = true; }),
    } };
    const result = yield* Effect.gen(function* () {
      return yield* Stream.runCollect((yield* ManagedDeps).install(["cloudflared"]));
    }).pipe(Effect.provide(ManagedDeps.layer(options).pipe(Layer.provide(NodeServices.layer))), Effect.result);
    expect(resolved).toBe(true);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.message).toContain("linux/arm64");
    expect(downloaded).toBe(false);
  }).pipe(Effect.scoped));

  it.live("831 C5: 取得済みの旧実行ファイルは同じサービスで正常導入しても読める", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const fixture = yield* archive(dir);
    const old = yield* Effect.tryPromise(() => oldEntity(root));
    const options = { root, cloudflared: {
      resolve: Effect.succeed(fixture.artifact),
      download: (_url: string, destination: string) => Effect.tryPromise(() => copyFile(fixture.path, destination)),
    } };
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const acquired = yield* deps.executable("cloudflared");
      expect(yield* Effect.tryPromise(() => realpath(acquired))).toBe(yield* Effect.tryPromise(() => realpath(old.binary)));
      expect((yield* Stream.runCollect(deps.install(["cloudflared"]))).at(-1)).toEqual({ type: "result", items: [installed] });
      const published = yield* deps.executable("cloudflared");
      expect(yield* Effect.tryPromise(() => realpath(published))).not.toBe(yield* Effect.tryPromise(() => realpath(acquired)));
      expect(yield* Effect.tryPromise(() => readFile(acquired, "utf8"))).toBe(CONTENT);
      expect(yield* Effect.tryPromise(() => readFile(published, "utf8"))).toBe(CONTENT);
    }).pipe(Effect.provide(ManagedDeps.layer(options).pipe(Layer.provide(NodeServices.layer))));
  }).pipe(Effect.scoped));

  it.live("831 C2・C4・C5: 合成 tgz を管理ルートに導入し実行可能なパスを返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const fixture = yield* archive(dir);
    const npm = yield* fakeNpm(dir);
    const downloads: string[] = [];
    const options = { root, npm, cloudflared: {
      resolve: Effect.succeed(fixture.artifact),
      download: (url: string, destination: string) => Effect.tryPromise(async () => {
        downloads.push(url);
        await copyFile(fixture.path, destination);
      }),
    } };
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const events = yield* Stream.runCollect(deps.install(["cloudflared"]));
      expect(events.at(-1)).toEqual({ type: "result", items: [installed] });
      expect(downloads).toEqual([fixture.artifact.url]);
      expect(yield* deps.check(["cloudflared"])).toEqual([installed]);
      const binary = yield* deps.executable("cloudflared");
      const within = relative(yield* Effect.tryPromise(() => realpath(join(root, "cloudflared"))), yield* Effect.tryPromise(() => realpath(binary)));
      expect(isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)).toBe(false);
      expect(yield* Effect.tryPromise(() => readFile(binary, "utf8"))).toBe(CONTENT);
      expect((yield* Effect.tryPromise(() => stat(binary))).mode & 0o111).not.toBe(0);
      expect(yield* Effect.tryPromise(() => readFile(join(root, "cloudflared/current/cloudflared"), "utf8"))).toBe(CONTENT);
      expect(yield* Effect.tryPromise(() => readdir(dir))).not.toContain("calls.jsonl");
      expect(transientNames(yield* Effect.tryPromise(() => readdir(join(root, "cloudflared"))))).toEqual([]);
    }).pipe(Effect.provide(ManagedDeps.layer(options).pipe(Layer.provide(NodeServices.layer))));
  }).pipe(Effect.scoped));

  it.live.each([false, true])("831 C3: ハッシュ不一致は取得まで到達して拒否し、旧版あり=%s の公開状態を保持して再試行できる", (hasOld) => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const fixture = yield* archive(dir);
    const old = hasOld ? yield* Effect.tryPromise(() => oldEntity(root)) : undefined;
    let corrupted = true;
    const downloads: string[] = [];
    const options = { root, cloudflared: {
      resolve: Effect.succeed(fixture.artifact),
      download: (url: string, destination: string) => Effect.tryPromise(async () => {
        downloads.push(url);
        await copyFile(corrupted ? fixture.corruptedPath : fixture.path, destination);
      }),
    } };
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      if (old !== undefined) {
        expect(yield* Effect.tryPromise(() => readFile(old.binary, "utf8"))).toBe(CONTENT);
      }
      const result = yield* Effect.result(Stream.runCollect(deps.install(["cloudflared"])));
      expect(downloads).toEqual([fixture.artifact.url]);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toMatch(/SHA256|ハッシュ|checksum/i);
      const names = yield* Effect.tryPromise(() => readdir(join(root, "cloudflared")));
      expect(transientNames(names)).toEqual([]);
      if (old !== undefined) {
        expect(yield* Effect.tryPromise(() => readlink(join(root, "cloudflared/current")))).toBe(old.name);
        expect(yield* Effect.tryPromise(() => readFile(old.binary, "utf8"))).toBe(CONTENT);
        const binary = yield* deps.executable("cloudflared");
        expect(yield* Effect.tryPromise(() => realpath(binary))).toBe(yield* Effect.tryPromise(() => realpath(old.binary)));
      } else {
        expect(names).not.toContain("current");
        expect(yield* deps.check(["cloudflared"])).toMatchObject([{ state: "missing" }]);
      }
      corrupted = false;
      expect((yield* Stream.runCollect(deps.install(["cloudflared"]))).at(-1)).toEqual({ type: "result", items: [installed] });
      expect(downloads).toEqual([fixture.artifact.url, fixture.artifact.url]);
      expect(yield* deps.check(["cloudflared"])).toEqual([installed]);
      const binary = yield* deps.executable("cloudflared");
      expect(yield* Effect.tryPromise(() => readFile(binary, "utf8"))).toBe(CONTENT);
    }).pipe(Effect.provide(ManagedDeps.layer(options).pipe(Layer.provide(NodeServices.layer))));
  }).pipe(Effect.scoped));

  it.live("831 C3: 取得中の競合を拒否し、中断後に旧版を保持して同じサービスで再導入できる", () => Effect.gen(function* () {
    const dir = yield* temporaryDeps;
    const root = join(dir, "deps");
    const fixture = yield* archive(dir);
    const old = yield* Effect.tryPromise(() => oldEntity(root));
    const started = yield* Deferred.make<void>();
    let attempts = 0;
    let finished = false;
    const options = { root, cloudflared: {
      resolve: Effect.succeed(fixture.artifact),
      download: (_url: string, destination: string) => Effect.gen(function* () {
        attempts++;
        if (attempts === 1) {
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => { finished = true; })));
        }
        yield* Effect.tryPromise(() => copyFile(fixture.path, destination));
      }),
    } };
    yield* Effect.gen(function* () {
      const deps = yield* ManagedDeps;
      const fiber = yield* Stream.runDrain(deps.install(["cloudflared"])).pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(started), Fiber.join(fiber));
      expect(yield* Effect.tryPromise(() => readlink(join(root, "cloudflared/current")))).toBe(old.name);
      const competitor = yield* Effect.result(Stream.runDrain(deps.install(["cloudflared"])).pipe(Effect.timeout("1 second")));
      expect(Result.isFailure(competitor)).toBe(true);
      if (Result.isFailure(competitor)) expect(competitor.failure.message).toContain("導入中");
      expect(attempts).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(finished).toBe(true);
      expect(yield* Effect.tryPromise(() => readFile(old.binary, "utf8"))).toBe(CONTENT);
      expect(transientNames(yield* Effect.tryPromise(() => readdir(join(root, "cloudflared"))))).toEqual([]);
      expect((yield* Stream.runCollect(deps.install(["cloudflared"]))).at(-1)).toEqual({ type: "result", items: [installed] });
      expect(attempts).toBe(2);
    }).pipe(Effect.provide(ManagedDeps.layer(options).pipe(Layer.provide(NodeServices.layer))));
  }).pipe(Effect.scoped));

  it.live.each(["missing", "incomplete", "outside"] as const)("831 C5: %s の実行ファイル取得は失敗する", (condition) => Effect.gen(function* () {
    const root = yield* temporaryDeps;
    if (condition !== "missing") {
      const old = yield* Effect.tryPromise(() => oldEntity(root));
      yield* Effect.tryPromise(async () => {
        if (condition === "incomplete") await rm(join(old.entity, ".ready.json"));
        else {
          const outside = join(root, "outside");
          await mkdir(outside);
          await copyFile(old.binary, join(outside, "cloudflared"));
          await writeFile(join(outside, ".ready.json"), JSON.stringify({
            version: "2026.8.0", installedAt: "2026-01-01T00:00:00Z",
            hashes: { [join(outside, "cloudflared")]: createHash("sha256").update(CONTENT).digest("hex") },
          }));
          await rm(join(root, "cloudflared/current"));
          await symlink(outside, join(root, "cloudflared/current"));
        }
      });
    }
    const result = yield* Effect.gen(function* () {
      return yield* (yield* ManagedDeps).executable("cloudflared");
    }).pipe(Effect.provide(ManagedDeps.layer({ root }).pipe(Layer.provide(NodeServices.layer))), Effect.result);
    expect(Result.isFailure(result)).toBe(true);
  }).pipe(Effect.scoped));
});
