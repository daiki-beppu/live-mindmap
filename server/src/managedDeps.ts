import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type * as PlaywrightModule from "playwright-core";
import { Console, Context, DateTime, Effect, FileSystem, Layer, PlatformError, Predicate, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import manifest from "../managed-deps/chromium/package.json" with { type: "json" };
import claudeManifest from "../managed-deps/claude/package.json" with { type: "json" };
import { resolveNpm, type NpmCommand } from "./npmCommand.ts";
import { CLOUDFLARED_VERSION, resolveCloudflaredArtifact, type CloudflaredSource } from "./cloudflaredArtifact.ts";

type DepModules = { chromium: typeof PlaywrightModule; claude: typeof import("@anthropic-ai/claude-agent-sdk") };
type ModuleName = keyof DepModules;
type DepName = ModuleName | "cloudflared";
type ManagedDepsOptions = { root: string; npm?: NpmCommand; cleanupOnStartup?: boolean; cloudflared?: CloudflaredSource };
export type DepItem = {
  readonly name: DepName;
  readonly need: "required" | "optional";
  readonly state: "ready" | "missing" | "outdated" | "absent";
  readonly version?: string;
};
export type DepEvent = { readonly type: "progress"; readonly message: string } | { readonly type: "result"; readonly items: ReadonlyArray<DepItem> };
export class ManagedDepsFailed extends Schema.TaggedError<ManagedDepsFailed>()("ManagedDepsFailed", { message: Schema.String }) {}
class CloudflaredUnavailable extends Schema.TaggedError<CloudflaredUnavailable>()("CloudflaredUnavailable", { message: Schema.String }) {}

export class ManagedDeps extends Context.Service<ManagedDeps, {
  check: (names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<DepItem>, ManagedDepsFailed>;
  install: (names: ReadonlyArray<string>) => Stream.Stream<DepEvent, ManagedDepsFailed>;
  update: (names: ReadonlyArray<string>) => Stream.Stream<DepEvent, ManagedDepsFailed>;
  load: <N extends ModuleName>(name: N) => Effect.Effect<DepModules[N], ManagedDepsFailed>;
  executable: (name: "cloudflared") => Effect.Effect<string, ManagedDepsFailed>;
}>()("live-mindmap/server/ManagedDeps") {
  static readonly layer = (options: ManagedDepsOptions) => Layer.effect(ManagedDeps)(make(options));
}

const VERSION = manifest.dependencies["playwright-core"];
const CLAUDE_VERSION = claudeManifest.dependencies["@anthropic-ai/claude-agent-sdk"];
const CURRENT = "current";
const LOCK = "install.lock";
const READY = ".ready.json";
const MARKER = "INSTALLATION_COMPLETE";
const CLOUDFLARED_BINARY = "cloudflared";
// hashes: cloudflared では使うとき（validateExecutable）の照合に使う。Chromium と Claude では導入時の記録だけで照合しない。
const ReadyRecord = Schema.Struct({
  version: Schema.String,
  installedAt: Schema.String,
  hashes: Schema.Record(Schema.String, Schema.String),
});
const PackageRecord = Schema.Struct({ version: Schema.String });
const BrowserRecord = Schema.Struct({
  browsers: Schema.Array(Schema.Struct({
    name: Schema.String,
    revision: Schema.String.check(Schema.isPattern(/^\d+$/)),
    revisionOverrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.String.check(Schema.isPattern(/^\d+$/)))),
  })),
});
// 相対パスが基準の外へ出ている（絶対パス・`..` で始まる）
const escapes = (path: string): boolean => isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
const failed = (error: unknown) => error instanceof ManagedDepsFailed
  ? error : new ManagedDepsFailed({ message: error instanceof Error ? error.message : String(error) });
const codeIs = (error: unknown, code: string): boolean =>
  Predicate.hasProperty(error, "code") && error.code === code;

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (codeIs(error, "ESRCH")) return false;
    if (codeIs(error, "EPERM")) return true;
    throw error;
  }
};

const removeOwner = (file: string) => {
  try { unlinkSync(file); } catch (error) { if (!codeIs(error, "ENOENT")) throw error; }
};
const removeEmptyDirectory = (dir: string) => {
  try { rmdirSync(dir); }
  catch (error) {
    if (!codeIs(error, "ENOENT") && !codeIs(error, "ENOTEMPTY") && !codeIs(error, "EEXIST")) throw error;
  }
};
const readPid = (file: string) => {
  const pid = Number(readFileSync(file, "utf8"));
  if (!Number.isSafeInteger(pid) || pid === 0 || (pid < 0 && !basename(file).startsWith("execution-"))) throw new ManagedDepsFailed({ message: "install.lock の pid が不正です" });
  return pid;
};
const executionsFinishedIn = (directory: string) => {
  const records = readdirSync(directory).filter((name) => name.startsWith("execution-"));
  for (const name of records) {
    if (pidAlive(readPid(join(directory, name)))) return false;
  }
  for (const name of records) removeOwner(join(directory, name));
  return true;
};

// 既存の guard ディレクトリの所有者ファイルを確かめ、生きていなければ消す。ディレクトリが消えていたら何もしない（呼び出し側が rename を再試行する）
const clearStaleGuard = (directory: string) => {
  try {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      if (pidAlive(readPid(file))) throw new ManagedDepsFailed({ message: "導入中です" });
      // 古い回収処理は確認した UUID だけを削除し、交代後の所有者には触れない。
      removeOwner(file);
    }
  } catch (error) {
    if (codeIs(error, "ENOENT")) return;
    throw error;
  }
};

const publishGuard = (candidate: string, directory: string) => {
  for (;;) {
    try {
      // 完成した非空候補だけを公開する。rename は別所有者の非空ディレクトリを置換しない。
      renameSync(candidate, directory);
      return;
    } catch (error) {
      if (!codeIs(error, "EEXIST") && !codeIs(error, "ENOTEMPTY")) throw error;
      clearStaleGuard(directory);
    }
  }
};

const reclaimPidLock = (path: string) => {
  try {
    if (pidAlive(readPid(path))) throw new ManagedDepsFailed({ message: "導入中です" });
    removeOwner(path);
  } catch (error) { if (!codeIs(error, "ENOENT")) throw error; }
};

const acquireLock = (path: string) => {
  const uuid = randomUUID();
  const directory = `${path}.guard`;
  const candidate = `${directory}-${uuid}`;
  const owner = join(directory, uuid);
  const executionsFinished = () => executionsFinishedIn(directory);
  const releaseGuard = () => {
    // UUID の削除後は PID lock や作業実体を操作しない。新所有者の非空ディレクトリは残す。
    removeOwner(owner);
    removeEmptyDirectory(directory);
  };
  let guarded = false;
  try {
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(join(candidate, uuid), String(process.pid), { flag: "wx", mode: 0o600 });
    publishGuard(candidate, directory);
    guarded = true;
    reclaimPidLock(path);
    // 所有者ファイルへの hard link により、空の PID lock を公開しない。
    linkSync(owner, path);
    return {
      owner, executionsFinished,
      release: () => {
        if (!executionsFinished()) throw new ManagedDepsFailed({ message: "外部導入プロセスの終了を確認できません" });
        try { removeOwner(path); } finally { releaseGuard(); }
      },
    };
  } catch (error) {
    if (guarded) releaseGuard();
    throw error;
  } finally {
    removeOwner(join(candidate, uuid));
    removeEmptyDirectory(candidate);
  }
};

const headlessShellPlatform = (platform: NodeJS.Platform, arch: string): string | undefined => {
  if (platform === "darwin") return `mac-${arch}`;
  if (platform === "linux") return arch === "x64" ? "linux64" : "linux-arm64";
  return platform === "win32" ? "win64" : undefined;
};

const validateNames = (names: ReadonlyArray<string>): Effect.Effect<DepName[], ManagedDepsFailed> => names.length > 0 && names.every((name) => name === "chromium" || name === "claude" || name === "cloudflared")
  ? Effect.succeed([...new Set(names)] as DepName[]) : Effect.fail(new ManagedDepsFailed({ message: "導入名は chromium、claude または cloudflared を指定してください" }));

const make = Effect.fnUntraced(function* (options: ManagedDepsOptions) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // 動的 import の遅延読込先も、サーバーの終了までは保持する。
  const loadedEntities = new Set<string>();
  const entityAccess = yield* Semaphore.make(1);
  const metadata = (path: string) => Effect.tryPromise({
    try: () => lstat(path),
    catch: (error) => PlatformError.systemError({
      _tag: codeIs(error, "ENOENT") ? "NotFound" : "Unknown",
      module: "FileSystem", method: "lstat", pathOrDescriptor: path, description: failed(error).message,
    }),
  });
  const sizeOf = Effect.fnUntraced(function* (path: string): Effect.fn.Return<number, PlatformError.PlatformError> {
    const stat = yield* metadata(path);
    if (!stat.isDirectory()) return stat.isSymbolicLink() ? 0 : stat.size;
    let size = 0;
    for (const name of yield* fs.readDirectory(path)) size += yield* sizeOf(join(path, name));
    return size;
  });
  const warning = (error: unknown) => `警告: 古い版の削除に失敗しました: ${failed(error).message}`;
  const readJson = <A>(path: string, schema: Schema.Decoder<A>) =>
    fs.readFileString(path).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))));
  const isFile = (path: string) => fs.stat(path).pipe(
    Effect.map((stat) => stat.type === "File"),
    Effect.catchTag("PlatformError", (error) => error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error)),
  );
  const dependency = (name: DepName) => {
    const dir = resolve(options.root, name);
    const browsers = join(dir, "browsers");
    const removeOldEntities = Stream.unwrap(Effect.gen(function* () {
      const current = join(dir, CURRENT);
      const protectedEntities = new Set<string>();
      // 壊れた current は未導入と区別し、保持先が解決できない場合は削除を始めない。
      const currentExists = yield* metadata(current).pipe(Effect.as(true), Effect.catch((error) => {
        if (error.reason._tag === "NotFound") return Effect.succeed(false);
        return Effect.fail(error);
      }));
      if (currentExists) protectedEntities.add(yield* fs.realPath(current));
      for (const entity of loadedEntities) protectedEntities.add(yield* fs.realPath(entity));
      const candidates = yield* fs.readDirectory(dir);
      return Stream.fromIterable(candidates).pipe(Stream.flatMap((candidate) => Stream.unwrap(Effect.gen(function* () {
        const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(candidate);
        if (match === null) return Stream.empty;
        const path = join(dir, candidate);
        if (!(yield* metadata(path)).isDirectory()) return Stream.empty;
        if (protectedEntities.has(yield* fs.realPath(path))) return Stream.empty;
        const size = yield* sizeOf(path);
        yield* fs.remove(path, { recursive: true });
        return Stream.succeed({ type: "progress" as const, message: `古い版を消しました: ${match[1]}（約 ${Math.round(size / 1_000_000)} MB）` });
      }).pipe(Effect.catch((error) => Effect.succeed(Stream.succeed({ type: "progress" as const, message: warning(error) })))))));
    }).pipe(Effect.catch((error) => Effect.succeed(Stream.succeed({ type: "progress" as const, message: warning(error) })))));
    const version = name === "cloudflared" ? CLOUDFLARED_VERSION : name === "chromium" ? VERSION : CLAUDE_VERSION;
    const packageName = name === "chromium" ? "playwright-core" : "@anthropic-ai/claude-agent-sdk";
    const packageDir = join(import.meta.dirname, "../managed-deps", name);
    const report = process.platform === "linux" ? process.report.getReport() : undefined;
    const musl = report !== undefined && Predicate.hasProperty(report, "header") && Predicate.isObject(report.header) && !Predicate.hasProperty(report.header, "glibcVersionRuntime");
    const binaryPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
    const claudeBinary = (entity: string) => join(entity, "node_modules", binaryPackage, process.platform === "win32" ? "claude.exe" : "claude");
    const shellInfo = Effect.fnUntraced(function* (entity: string) {
      const record = yield* readJson(join(entity, "node_modules/playwright-core/browsers.json"), BrowserRecord);
      const shell = record.browsers.find((browser) => browser.name === "chromium-headless-shell");
      if (shell === undefined) return yield* new ManagedDepsFailed({ message: "headless shell の revision がありません" });
      // 固定版 1.63.0 の browsers.json に shell の override は無い。将来の版変更はこの対応も見直す。
      if (shell.revisionOverrides !== undefined) return yield* new ManagedDepsFailed({ message: "未対応の headless shell revision override です" });
      const directory = join(browsers, `chromium_headless_shell-${shell.revision}`);
      return { directory, marker: join(directory, MARKER) };
    });
    const checkDependency = Effect.gen(function* () {
      const current = join(dir, CURRENT);
      const missing: DepItem = { name, need: "optional", state: "missing" };
      if (!(yield* isFile(join(current, READY)))) return missing;
      const ready = yield* readJson(join(current, READY), ReadyRecord).pipe(Effect.catchTag("SchemaError", () => Effect.void));
      if (ready === undefined) return missing;
      if (ready.version !== version) return { ...missing, state: "outdated" as const, version: ready.version };
      if (name === "cloudflared") {
        const usable = yield* validateExecutable.pipe(
          Effect.as(true),
          Effect.catchTag("CloudflaredUnavailable", () => Effect.succeed(false)),
        );
        return { ...missing, state: usable ? "ready" as const : "missing" as const };
      }
      if (!(yield* isFile(join(current, "node_modules", packageName, "package.json")))) return missing;
      const pkg = yield* readJson(join(current, "node_modules", packageName, "package.json"), PackageRecord);
      if (pkg.version !== version) return { ...missing, state: "outdated" as const, version: pkg.version };
      if (name === "claude") return { ...missing, state: (yield* isFile(claudeBinary(current))) ? "ready" as const : "missing" as const };
      if (!(yield* isFile(join(current, "node_modules/playwright-core/browsers.json")))) return missing;
      const shell = yield* shellInfo(current);
      return { ...missing, state: (yield* isFile(shell.marker)) ? "ready" as const : "missing" as const };
    });
    // current の実体と、管理ディレクトリからの相対パス
    const currentEntity = Effect.gen(function* () {
      const entity = yield* fs.realPath(join(dir, CURRENT));
      const managedDir = yield* fs.realPath(dir);
      return { entity, entityPath: relative(managedDir, entity) };
    });
    const load = Effect.gen(function* () {
      const { entity, entityPath } = yield* currentEntity;
      if (escapes(entityPath)) {
        return yield* new ManagedDepsFailed({ message: "current の実体が管理ディレクトリ外です" });
      }
      const require = createRequire(join(entity, "package.json"));
      const resolved = yield* Effect.try({
        // SDK は package.json を exports に公開しないので、管理実体の既知のパッケージ位置を検証する。
        try: () => ({ module: require.resolve(packageName), package: join(entity, "node_modules", packageName, "package.json") }),
        catch: failed,
      });
      const modulePath = yield* fs.realPath(resolved.module);
      const packagePath = yield* fs.realPath(resolved.package);
      for (const path of [modulePath, packagePath]) {
        const within = relative(join(entity, "node_modules"), path);
        if (escapes(within)) {
          return yield* new ManagedDepsFailed({ message: `${packageName} の解決先が管理実体の node_modules 外です` });
        }
      }
      const pkg = yield* readJson(packagePath, PackageRecord);
      const ready = yield* readJson(join(entity, READY), ReadyRecord);
      if (pkg.version !== ready.version) return yield* new ManagedDepsFailed({ message: "読込版が導入記録と一致しません" });
      const module = yield* Effect.tryPromise({
        try: () => {
          if (name === "chromium") process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
          return import(pathToFileURL(modulePath).href) as Promise<DepModules[ModuleName]>;
        },
        catch: failed,
      });
      loadedEntities.add(entity);
      return module;
    }).pipe(entityAccess.withPermit, Effect.mapError(failed));

    const run = Effect.fnUntraced(function* (lock: ReturnType<typeof acquireLock>, command: NpmCommand, args: string[], cwd: string, browserGc: boolean) {
      const completed = yield* Effect.scoped(Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [join(import.meta.dirname, "managedDepsRunner.ts"), lock.owner, command.command, ...command.args, ...args], {
          cwd, env: name === "chromium" ? { PLAYWRIGHT_BROWSERS_PATH: browsers, PLAYWRIGHT_SKIP_BROWSER_GC: browserGc ? undefined : "1" } : {}, extendEnv: true,
          stdin: "ignore", forceKillAfter: 5_000,
        }));
        // 大きい出力を溜めず、失敗表示に必要な末尾だけを保持する。
        let tail = "";
        const consume = (source: typeof handle.stdout) => Stream.runForEach(Stream.decodeText(source), (text) =>
          Effect.sync(() => { tail = (tail + text).slice(-8192); }));
        const [, , code] = yield* Effect.all([consume(handle.stdout), consume(handle.stderr), handle.exitCode], { concurrency: "unbounded" });
        return { code, tail };
      }));
      if (!(yield* Effect.try({ try: lock.executionsFinished, catch: failed }))) return yield* new ManagedDepsFailed({ message: "外部導入プロセスの終了を確認できません" });
      if (completed.code !== 0) return yield* new ManagedDepsFailed({ message: `導入に失敗しました: ${completed.tail.trim().split("\n").slice(-10).join("\n") || `終了コード ${completed.code}`}` });
    });
    const hash = Effect.fnUntraced(function* (path: string) {
      const digest = createHash("sha256");
      yield* Stream.runForEach(fs.stream(path), (bytes) => Effect.sync(() => { digest.update(bytes); }));
      return digest.digest("hex");
    });
    const binaryNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound"
      ? new CloudflaredUnavailable({ message: "cloudflared の実行ファイルがありません" }) : error;
    const validateExecutable = Effect.gen(function* () {
      const { entity, entityPath } = yield* currentEntity;
      if (entityPath === "" || escapes(entityPath) || basename(entity).startsWith(".work-")) {
        return yield* new ManagedDepsFailed({ message: "current の実体が完成済み管理ディレクトリ内ではありません" });
      }
      const binary = yield* fs.realPath(join(entity, CLOUDFLARED_BINARY)).pipe(Effect.mapError(binaryNotFound));
      if (binary !== join(entity, CLOUDFLARED_BINARY)) return yield* new ManagedDepsFailed({ message: "cloudflared の実行ファイルが管理実体外です" });
      const stat = yield* metadata(binary).pipe(Effect.mapError(binaryNotFound));
      if (!stat.isFile()) return yield* new ManagedDepsFailed({ message: "cloudflared の実行ファイルがありません" });
      if ((stat.mode & 0o111) === 0) return yield* new CloudflaredUnavailable({ message: "cloudflared の実行ファイルがありません" });
      const ready = yield* readJson(join(entity, READY), ReadyRecord);
      const records = yield* Effect.forEach(Object.entries(ready.hashes), ([path, digest]) =>
        fs.realPath(path).pipe(Effect.map((resolved) => ({ path: resolved, digest }))));
      const expected = records.find((record) => record.path === binary);
      if (expected === undefined) return yield* new ManagedDepsFailed({ message: "cloudflared のハッシュが導入記録と一致しません" });
      if ((yield* hash(binary)) !== expected.digest) {
        return yield* new CloudflaredUnavailable({ message: "cloudflared のハッシュが導入記録と一致しません" });
      }
      return binary;
    });
    const executable = validateExecutable.pipe(Effect.mapError(failed));
    const verifyCloudflared = Effect.fnUntraced(function* (work: string, entity: string) {
      const binary = join(work, CLOUDFLARED_BINARY);
      const stat = yield* metadata(binary);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) return yield* new ManagedDepsFailed({ message: "cloudflared の実行ファイルがありません" });
      const now = yield* DateTime.now;
      yield* fs.writeFileString(join(work, READY), JSON.stringify({
        version, installedAt: DateTime.formatIso(now), hashes: { [join(entity, CLOUDFLARED_BINARY)]: yield* hash(binary) },
      }));
    });
    const installedBinary = Effect.fnUntraced(function* (work: string) {
      if (name === "claude") {
        const binaryPkg = yield* readJson(join(work, "node_modules", binaryPackage, "package.json"), PackageRecord);
        if (binaryPkg.version !== version) return yield* new ManagedDepsFailed({ message: "バイナリの版が固定版と一致しません" });
        return claudeBinary(work);
      }
      const shell = yield* shellInfo(work);
      if (!(yield* isFile(shell.marker))) return yield* new ManagedDepsFailed({ message: "headless shell の導入が完了していません" });
      const platform = headlessShellPlatform(process.platform, process.arch);
      if (platform === undefined) return yield* new ManagedDepsFailed({ message: "未対応の Chromium プラットフォームです" });
      return join(shell.directory, `chrome-headless-shell-${platform}`, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
    });
    const verify = Effect.fnUntraced(function* (work: string, entity: string) {
      if (name === "cloudflared") return yield* verifyCloudflared(work, entity);
      const pkg = yield* readJson(join(work, "node_modules", packageName, "package.json"), PackageRecord);
      if (pkg.version !== version) return yield* new ManagedDepsFailed({ message: "導入版が固定版と一致しません" });
      const binary = yield* installedBinary(work);
      // Chromium と Claude は導入時点のハッシュを記録するだけで、後から照合しない。
      // Claude は npm ci が lock の integrity で照合済み、headless shell は Playwright が取得するため期待値を持たない。
      const recorded = yield* hash(binary);
      const now = yield* DateTime.now;
      const publishedBinary = name === "claude" ? claudeBinary(entity) : binary;
      yield* fs.writeFileString(join(work, READY), JSON.stringify({ version, installedAt: DateTime.formatIso(now), hashes: { [publishedBinary]: recorded } }));
    });
    const cleanup = <E>(effect: Effect.Effect<void, E>) => effect.pipe(Effect.catch((error) => Effect.logWarning(`管理依存の後片付けに失敗しました: ${String(error)}`)));

    const install = (operation: "install" | "update"): Stream.Stream<DepEvent, ManagedDepsFailed> => Stream.unwrap(Effect.gen(function* () {
      const artifact = name === "cloudflared" ? yield* (options.cloudflared?.resolve ?? resolveCloudflaredArtifact(process.platform, process.arch)) : undefined;
      if (operation === "update" && (yield* checkDependency).state !== "outdated") return Stream.succeed<DepEvent>({ type: "result", items: [] });
      yield* fs.makeDirectory(dir, { recursive: true });
      const lock = yield* Effect.acquireRelease(Effect.try({ try: () => acquireLock(join(dir, LOCK)), catch: failed }), (lock) => cleanup(Effect.try({ try: lock.release, catch: failed })));
      for (const name of yield* fs.readDirectory(dir)) {
        if (name.startsWith(".work-")) yield* fs.remove(join(dir, name), { recursive: true, force: true });
      }
      const state = (yield* checkDependency).state;
      if (state === "ready" || (operation === "update" && state !== "outdated")) return Stream.succeed<DepEvent>({ type: "result", items: [] });
      const uuid = randomUUID();
      const work = join(dir, `.work-${uuid}`);
      const entity = join(dir, `${version}-${uuid}`);
      const link = join(dir, `.work-link-${uuid}`);
      let published = false;
      yield* Effect.acquireRelease(
        fs.makeDirectory(work),
        () => cleanup(Effect.gen(function* () {
          if (!(yield* Effect.try({ try: lock.executionsFinished, catch: failed }))) return yield* new ManagedDepsFailed({ message: "外部導入プロセスの終了を確認できないため作業実体を保持します" });
          yield* fs.remove(work, { recursive: true, force: true });
          yield* fs.remove(link, { force: true });
          if (!published) yield* fs.remove(entity, { recursive: true, force: true });
        })),
      );
      const progress = (message: string) => Stream.succeed<DepEvent>({ type: "progress", message });
      const step = (effect: Effect.Effect<void, unknown>) => Stream.drain(Stream.fromEffect(effect));
      const acquireArtifact = Effect.gen(function* () {
        if (artifact !== undefined) {
          const archive = join(work, "cloudflared.tgz");
          yield* options.cloudflared !== undefined
            ? options.cloudflared.download(artifact.url, archive)
            : run(lock, { command: "/usr/bin/curl", args: [] }, ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--output", archive, artifact.url], work, false);
          if ((yield* hash(archive)) !== artifact.sha256) return yield* new ManagedDepsFailed({ message: "cloudflared の SHA256 が固定値と一致しません" });
          yield* run(lock, { command: "/usr/bin/tar", args: [] }, ["-xzf", archive, "-C", work, CLOUDFLARED_BINARY], work, false);
          yield* fs.remove(archive);
        } else {
          const npm = options.npm ?? (yield* resolveNpm({ execPath: process.execPath, env: process.env }));
          for (const file of ["package.json", "package-lock.json"]) yield* fs.copyFile(join(packageDir, file), join(work, file));
          yield* run(lock, npm, ["ci", "--omit=dev", "--omit=peer", "--ignore-scripts"], work, false);
        }
      });
      return Stream.concat(
        Stream.concat(progress(`ダウンロード: ${name === "cloudflared" ? CLOUDFLARED_BINARY : packageName}`), step(acquireArtifact)),
        Stream.concat(
          name === "chromium" ? Stream.concat(progress("展開: Chromium headless shell"), step(run(lock, { command: process.execPath, args: [join(work, "node_modules/playwright-core/cli.js")] }, ["install", "--only-shell", "chromium"], work, false))) : Stream.empty,
          Stream.concat(progress(name === "cloudflared" ? "確認: 版・完了 marker・ハッシュ" : "確認: 版・完了 marker、ハッシュを記録"), Stream.unwrap(Effect.gen(function* () {
            yield* verify(work, entity);
            yield* Effect.acquireRelease(entityAccess.take(1), () => entityAccess.release(1));
            yield* fs.rename(work, entity).pipe(Effect.uninterruptible);
            yield* fs.symlink(basename(entity), link);
            // 公開の確定点と published の更新を中断で分離しない。
            yield* fs.rename(link, join(dir, CURRENT)).pipe(Effect.andThen(Effect.sync(() => { published = true; })), Effect.uninterruptible);
            const browserCleanup = name === "chromium" ? step(run(lock,
              { command: process.execPath, args: [join(dir, CURRENT, "node_modules/playwright-core/cli.js")] },
              ["install", "--only-shell", "chromium"], join(dir, CURRENT), true,
            )).pipe(Stream.catch((error) => progress(`警告: ブラウザの掃除に失敗しました: ${failed(error).message}`))) : Stream.empty;
            return Stream.concat(removeOldEntities, Stream.concat(browserCleanup, Stream.succeed<DepEvent>({ type: "result", items: [{ name, need: "optional", state: "ready" }] })));
          })).pipe(Stream.scoped)),
        ),
      );
    })).pipe(Stream.mapError(failed));
    const cleanupOnStartup = Effect.scoped(Effect.gen(function* () {
      if (!(yield* fs.exists(dir))) return;
      yield* Effect.acquireRelease(Effect.try({ try: () => acquireLock(join(dir, LOCK)), catch: failed }), (lock) =>
        Effect.try({ try: lock.release, catch: failed }).pipe(Effect.catch((error) => Console.error(warning(error)))));
      yield* Stream.runForEach(removeOldEntities, (event) => Console.error(event.message)).pipe(entityAccess.withPermit);
    })).pipe(Effect.catch((error) => Console.error(warning(error))));
    return { check: checkDependency, load, executable, install, cleanupOnStartup };
  };
  const check = Effect.fnUntraced(function* (names: ReadonlyArray<string>) {
    const validated = yield* validateNames(names);
    return yield* Effect.forEach(validated, (name) => dependency(name).check);
  }, Effect.mapError(failed));
  const load: ManagedDeps["Service"]["load"] = <N extends ModuleName>(name: N) => validateNames([name]).pipe(
    Effect.flatMap(() => dependency(name).load),
  ) as Effect.Effect<DepModules[N], ManagedDepsFailed>;
  const install = (names: ReadonlyArray<string>, operation: "install" | "update"): Stream.Stream<DepEvent, ManagedDepsFailed> => Stream.unwrap(Effect.gen(function* () {
    const validated = yield* validateNames(names);
    if (operation === "update" && validated.includes("cloudflared")) return yield* new ManagedDepsFailed({ message: "更新名は chromium または claude を指定してください" });
    const items: DepItem[] = [];
    const installs = Stream.fromIterable(validated).pipe(
      Stream.flatMap((name) => dependency(name).install(operation)),
      Stream.filter((event) => {
        if (event.type === "progress") return true;
        items.push(...event.items);
        return false;
      }),
    );
    return Stream.concat(installs, Stream.fromEffect(Effect.sync((): DepEvent => ({ type: "result", items }))));
  }));
  if (options.cleanupOnStartup) {
    for (const name of ["chromium", "claude", "cloudflared"] as const) yield* dependency(name).cleanupOnStartup;
  }
  return ManagedDeps.of({ check, install: (names) => install(names, "install"), update: (names) => install(names, "update"), load,
    executable: (name) => dependency(name).executable.pipe(
      Effect.tap((binary) => Effect.sync(() => { loadedEntities.add(resolve(binary, "..")); })),
      entityAccess.withPermit,
    ) });
});
