import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type * as PlaywrightModule from "playwright-core";
import { Context, DateTime, Effect, FileSystem, Layer, Predicate, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import manifest from "../managed-deps/chromium/package.json" with { type: "json" };
import { resolveNpm, type NpmCommand } from "./npmCommand.ts";

export type DepItem = {
  readonly name: "chromium";
  readonly need: "required" | "optional";
  readonly state: "ready" | "missing" | "outdated" | "absent";
};
export type DepEvent = { readonly type: "progress"; readonly message: string } | { readonly type: "result"; readonly items: ReadonlyArray<DepItem> };
export class ManagedDepsFailed extends Schema.TaggedError<ManagedDepsFailed>()("ManagedDepsFailed", { message: Schema.String }) {}

export class ManagedDeps extends Context.Service<ManagedDeps, {
  check: (names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<DepItem>, ManagedDepsFailed>;
  install: (names: ReadonlyArray<string>) => Stream.Stream<DepEvent, ManagedDepsFailed>;
  load: (name: "chromium") => Effect.Effect<typeof PlaywrightModule, ManagedDepsFailed>;
}>()("live-mindmap/server/ManagedDeps") {
  static readonly layer = (options: { root: string; npm?: NpmCommand }) => Layer.effect(ManagedDeps)(make(options));
}

const VERSION = manifest.dependencies["playwright-core"];
const PACKAGE_DIR = join(import.meta.dirname, "../managed-deps/chromium");
const CURRENT = "current";
const LOCK = "install.lock";
const READY = ".ready.json";
const MARKER = "INSTALLATION_COMPLETE";
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

const acquireLock = (path: string) => {
  const uuid = randomUUID();
  const directory = `${path}.guard`;
  const candidate = `${directory}-${uuid}`;
  const owner = join(directory, uuid);
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
  const executionsFinished = () => {
    const records = readdirSync(directory).filter((name) => name.startsWith("execution-"));
    for (const name of records) {
      if (pidAlive(readPid(join(directory, name)))) return false;
    }
    for (const name of records) removeOwner(join(directory, name));
    return true;
  };
  const releaseGuard = () => {
    // UUID の削除後は PID lock や作業実体を操作しない。新所有者の非空ディレクトリは残す。
    removeOwner(owner);
    removeEmptyDirectory(directory);
  };
  let guarded = false;
  try {
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(join(candidate, uuid), String(process.pid), { flag: "wx", mode: 0o600 });
    for (;;) {
      try {
        // 完成した非空候補だけを公開する。rename は別所有者の非空ディレクトリを置換しない。
        renameSync(candidate, directory);
        guarded = true;
        break;
      } catch (error) {
        if (!codeIs(error, "EEXIST") && !codeIs(error, "ENOTEMPTY")) throw error;
        try {
          for (const name of readdirSync(directory)) {
            const file = join(directory, name);
            if (pidAlive(readPid(file))) throw new ManagedDepsFailed({ message: "導入中です" });
            // 古い回収処理は確認した UUID だけを削除し、交代後の所有者には触れない。
            removeOwner(file);
          }
        } catch (error) {
          if (codeIs(error, "ENOENT")) continue;
          throw error;
        }
      }
    }
    try {
      if (pidAlive(readPid(path))) throw new ManagedDepsFailed({ message: "導入中です" });
      removeOwner(path);
    } catch (error) { if (!codeIs(error, "ENOENT")) throw error; }
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

const validateNames = (names: ReadonlyArray<string>) => names.length > 0 && names.every((name) => name === "chromium")
  ? Effect.void : Effect.fail(new ManagedDepsFailed({ message: "導入名は chromium を指定してください" }));

const make = Effect.fnUntraced(function* (options: { root: string; npm?: NpmCommand }) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const dir = resolve(options.root, "chromium");
  const browsers = join(dir, "browsers");
  // #712 の掃除が、使用済みの実体を消さないための記録。current が交代しても残す。
  const loadedEntities = new Set<string>();
  const readJson = <A>(path: string, schema: Schema.Decoder<A>) =>
    fs.readFileString(path).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))));
  const isFile = (path: string) => fs.stat(path).pipe(
    Effect.map((stat) => stat.type === "File"),
    Effect.catchTag("PlatformError", (error) => error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error)),
  );
  const shellInfo = Effect.fnUntraced(function* (entity: string) {
    const record = yield* readJson(join(entity, "node_modules/playwright-core/browsers.json"), BrowserRecord);
    const shell = record.browsers.find((browser) => browser.name === "chromium-headless-shell");
    if (shell === undefined) return yield* new ManagedDepsFailed({ message: "headless shell の revision がありません" });
    // 固定版 1.63.0 の browsers.json に shell の override は無い。将来の版変更はこの対応も見直す。
    if (shell.revisionOverrides !== undefined) return yield* new ManagedDepsFailed({ message: "未対応の headless shell revision override です" });
    const directory = join(browsers, `chromium_headless_shell-${shell.revision}`);
    return { directory, marker: join(directory, MARKER) };
  });
  const checkChromium = Effect.gen(function* () {
    const current = join(dir, CURRENT);
    const missing: DepItem = { name: "chromium", need: "optional", state: "missing" };
    if (!(yield* isFile(join(current, READY)))) return missing;
    const ready = yield* readJson(join(current, READY), ReadyRecord).pipe(Effect.catchTag("SchemaError", () => Effect.void));
    if (ready === undefined) return missing;
    if (ready.version !== VERSION) return { ...missing, state: "outdated" as const };
    if (!(yield* isFile(join(current, "node_modules/playwright-core/package.json"))) ||
        !(yield* isFile(join(current, "node_modules/playwright-core/browsers.json")))) return missing;
    const pkg = yield* readJson(join(current, "node_modules/playwright-core/package.json"), PackageRecord);
    if (pkg.version !== VERSION) return { ...missing, state: "outdated" as const };
    const shell = yield* shellInfo(current);
    return { ...missing, state: (yield* isFile(shell.marker)) ? "ready" as const : "missing" as const };
  });
  const check = Effect.fnUntraced(function* (names: ReadonlyArray<string>) {
    yield* validateNames(names);
    return [yield* checkChromium];
  }, Effect.mapError(failed));

  const load = Effect.fnUntraced(function* (name: "chromium") {
    yield* validateNames([name]);
    const entity = yield* fs.realPath(join(dir, CURRENT));
    const require = createRequire(join(entity, "package.json"));
    const resolved = yield* Effect.try({
      try: () => ({ module: require.resolve("playwright-core"), package: require.resolve("playwright-core/package.json") }),
      catch: failed,
    });
    const modulePath = yield* fs.realPath(resolved.module);
    const packagePath = yield* fs.realPath(resolved.package);
    for (const path of [modulePath, packagePath]) {
      const within = relative(join(entity, "node_modules"), path);
      if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
        return yield* new ManagedDepsFailed({ message: "playwright-core の解決先が管理実体の node_modules 外です" });
      }
    }
    const pkg = yield* readJson(packagePath, PackageRecord);
    if (pkg.version !== VERSION) return yield* new ManagedDepsFailed({ message: "読込版が固定版と一致しません" });
    const module = yield* Effect.tryPromise({
      try: () => {
        process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
        return import(pathToFileURL(modulePath).href) as Promise<typeof PlaywrightModule>;
      },
      catch: failed,
    });
    loadedEntities.add(entity);
    return module;
  }, Effect.mapError(failed));

  const run = Effect.fnUntraced(function* (lock: ReturnType<typeof acquireLock>, command: NpmCommand, args: string[], cwd: string) {
    const completed = yield* Effect.scoped(Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [join(import.meta.dirname, "managedDepsRunner.ts"), lock.owner, command.command, ...command.args, ...args], {
        cwd, env: { PLAYWRIGHT_BROWSERS_PATH: browsers, PLAYWRIGHT_SKIP_BROWSER_GC: "1" }, extendEnv: true,
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
  const verify = Effect.fnUntraced(function* (work: string) {
    const pkg = yield* readJson(join(work, "node_modules/playwright-core/package.json"), PackageRecord);
    if (pkg.version !== VERSION) return yield* new ManagedDepsFailed({ message: "導入版が固定版と一致しません" });
    const shell = yield* shellInfo(work);
    if (!(yield* isFile(shell.marker))) return yield* new ManagedDepsFailed({ message: "headless shell の導入が完了していません" });
    const platform = process.platform === "darwin" ? `mac-${process.arch}`
      : process.platform === "linux" ? (process.arch === "x64" ? "linux64" : "linux-arm64")
      : process.platform === "win32" ? "win64" : undefined;
    if (platform === undefined) return yield* new ManagedDepsFailed({ message: "未対応の Chromium プラットフォームです" });
    const binary = join(shell.directory, `chrome-headless-shell-${platform}`, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
    const expected = yield* hash(binary);
    if ((yield* hash(binary)) !== expected) return yield* new ManagedDepsFailed({ message: "導入直後のハッシュが一致しません" });
    const now = yield* DateTime.now;
    yield* fs.writeFileString(join(work, READY), JSON.stringify({ version: VERSION, installedAt: DateTime.formatIso(now), hashes: { [binary]: expected } }));
  });
  const cleanup = <E>(effect: Effect.Effect<void, E>) => effect.pipe(Effect.catch((error) => Effect.logWarning(`管理依存の後片付けに失敗しました: ${String(error)}`)));

  const install = (names: ReadonlyArray<string>): Stream.Stream<DepEvent, ManagedDepsFailed> => Stream.unwrap(Effect.gen(function* () {
    yield* validateNames(names);
    yield* fs.makeDirectory(dir, { recursive: true });
    const lock = yield* Effect.acquireRelease(Effect.try({ try: () => acquireLock(join(dir, LOCK)), catch: failed }), (lock) => cleanup(Effect.try({ try: lock.release, catch: failed })));
    for (const name of yield* fs.readDirectory(dir)) {
      if (name.startsWith(".work-")) yield* fs.remove(join(dir, name), { recursive: true, force: true });
    }
    if ((yield* checkChromium).state === "ready") return Stream.succeed<DepEvent>({ type: "result", items: [] });
    const npm = options.npm ?? (yield* resolveNpm({ execPath: process.execPath, env: process.env }));
    const uuid = randomUUID();
    const work = join(dir, `.work-${uuid}`);
    const entity = join(dir, `${VERSION}-${uuid}`);
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
    for (const file of ["package.json", "package-lock.json"]) yield* fs.copyFile(join(PACKAGE_DIR, file), join(work, file));
    const progress = (message: string) => Stream.succeed<DepEvent>({ type: "progress", message });
    const step = (effect: Effect.Effect<void, unknown>) => Stream.drain(Stream.fromEffect(effect));
    return Stream.concat(
      Stream.concat(progress("ダウンロード: playwright-core"), step(run(lock, npm, ["ci", "--omit=dev", "--omit=peer", "--ignore-scripts"], work))),
      Stream.concat(
        Stream.concat(progress("展開: Chromium headless shell"), step(run(lock, { command: process.execPath, args: [join(work, "node_modules/playwright-core/cli.js")] }, ["install", "--only-shell", "chromium"], work))),
        Stream.concat(progress("確認: 版・完了 marker・ハッシュ"), Stream.fromEffect(Effect.gen(function* (): Effect.fn.Return<DepEvent, unknown> {
          yield* verify(work);
          yield* fs.rename(work, entity).pipe(Effect.uninterruptible);
          yield* fs.symlink(basename(entity), link);
          // 公開の確定点と published の更新を中断で分離しない。
          yield* fs.rename(link, join(dir, CURRENT)).pipe(Effect.andThen(Effect.sync(() => { published = true; })), Effect.uninterruptible);
          return { type: "result", items: [{ name: "chromium", need: "optional", state: "ready" }] };
        }))),
      ),
    );
  })).pipe(Stream.mapError(failed));
  return ManagedDeps.of({ check, install, load });
});
