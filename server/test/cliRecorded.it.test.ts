import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { WebSocket } from "ws";
import { ConfigProvider, Console, Deferred, Effect, FileSystem, Fiber, Layer, Queue, Result, Stream, type Cause } from "effect";
import { HttpClient } from "effect/http";
import { vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import type { DiffInput } from "../src/core/index.ts";
import { Helpers, type HelperExitInfo } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { embeddedAudio, FAKE_MIX_BYTES, fakeAudioMix, type FakeMix } from "./fixtures/audioMix.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { readyHelperChecks } from "./fixtures/helperCheck.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { FAKE_TUNNEL_HOST, fakeTunnel } from "./fixtures/tunnel.ts";
import { AppleIntelligence } from "../src/appleIntelligence.ts";
import type { ExecutableModel } from "../src/modelSelection.ts";

// cli recorded <file> を、CLI の入口から常駐サーバー・偽の Helpers（台本のイベント）・偽の差分更新まで通して確かめる。
// 試すシームは CLI の recorded コマンドと、サーバーの Helpers.launch・DiffUpdater.update の 2 つ。

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-cli-recorded-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

type Remark = { start: number; end: number; text: string };
type Script = {
  duration?: number;
  remarks: Remark[];
  // true なら、台本のイベントを流し終えてもヘルパーは終わらない（stop の印で終わる）
  hold?: boolean;
  exit?: HelperExitInfo; // 自然に終わるときの終わり方（既定 code 0）
  // ヘルパーの creation-date の答え。ISO8601 の文字列、null（作成日時を持たないファイル）、"fail"（問い合わせの失敗）。既定は null
  creationDate?: string | null | "fail";
};

// 偽のヘルパーが --audio-dir へ書く音声（相手.m4a）の中身
const HELPER_AUDIO = "ヘルパーが書いた音声";

// ヘルパーは、録画の文字起こしでは partial → remark の順に出す
const events = (script: Script): unknown[] => [
  ...(script.duration === undefined ? [] : [{ type: "file-duration", duration: script.duration }]),
  ...script.remarks.flatMap((r) => [
    { type: "partial", track: "相手", ...r },
    { type: "remark", track: "相手", ...r },
  ]),
];

function fakeHelpers(script: Script) {
  const calls: string[][] = [];
  const stopSeen = Effect.runSync(Deferred.make<void>());
  // 起動した後に、テストからヘルパーのイベントを足す
  const live: { queue: Queue.Queue<string, Cause.Done> | undefined } = { queue: undefined };
  const feed = (event: unknown) => { Queue.offerUnsafe(live.queue!, JSON.stringify(event)); };
  const creationDateCalls: string[] = [];
  const creationDate = (file: string) => {
    creationDateCalls.push(file);
    return script.creationDate === "fail"
      ? Effect.fail({ _tag: "HelperCreationDateFailure", message: "作成日時を読めない" } as never)
      : Effect.succeed(script.creationDate ?? null);
  };
  const launch = (args: ReadonlyArray<string>, stopRequested: Deferred.Deferred<void>) => Effect.gen(function* () {
    calls.push([...args]);
    // 本物のヘルパーは、待ち受けを始める前に --audio-dir のフォルダへ 相手.m4a を書く
    const audioDir = args[args.indexOf("--audio-dir") + 1];
    if (args.includes("--audio-dir") && audioDir !== undefined) writeFileSync(join(audioDir, "相手.m4a"), HELPER_AUDIO);
    const queue = yield* Queue.make<string, Cause.Done>();
    live.queue = queue;
    const exited = yield* Deferred.make<HelperExitInfo>();
    const finish = (info: HelperExitInfo) => Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, info)));
    const stop = finish({ code: null, signal: "SIGTERM" });
    yield* Effect.addFinalizer(() => stop);
    yield* Effect.forkScoped(Effect.andThen(Deferred.await(stopRequested), Deferred.succeed(stopSeen, undefined)));
    for (const event of events(script)) Queue.offerUnsafe(queue, JSON.stringify(event));
    if (script.hold !== true) yield* finish(script.exit ?? { code: 0, signal: null });
    return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed(["helper stderr"]), send: () => Effect.void };
  });
  const layer = Layer.succeed(Helpers, Helpers.of({ ...readyHelperChecks, apps: Effect.succeed([]), creationDate, launch }));
  return { calls, creationDateCalls, stopSeen, layer, feed };
}

type UpdateScript = (input: DiffInput, call: number) => Effect.Effect<void>;

// 呼び出しを記録する差分更新。呼び出しが重なったら（前の呼び出しの終わりを待たずに次を呼んだら）overlaps が増える
function fakeUpdater(before: UpdateScript = () => Effect.void) {
  const inputs: DiffInput[] = [];
  const state = { inFlight: 0, overlaps: 0 };
  const layer = updaterLayer((input: DiffInput) => Effect.gen(function* () {
    inputs.push(input);
    state.inFlight += 1;
    if (state.inFlight > 1) state.overlaps += 1;
    yield* before(input, inputs.length);
    state.inFlight -= 1;
    return { ops: [] };
  }));
  return { inputs, state, layer };
}

// log.jsonl への書き込みのうち、条件に合う最初の 1 回だけ失敗させる FileSystem（書き込みの失敗は defect になる）。失敗した回数を数える
function failingLogWrite(matches: (content: string) => boolean) {
  const writes = { armed: true, failed: 0 };
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return new Proxy(fs, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "writeFileString") return value;
          return (path: string, data: string, options?: unknown) => {
            if (writes.armed && path.endsWith("log.jsonl") && matches(data)) {
              writes.armed = false;
              writes.failed += 1;
              return Effect.fail(new Error("ディスクに書けない"));
            }
            return (value as (...args: unknown[]) => Effect.Effect<void>).call(target, path, data, options);
          };
        },
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return { writes, layer };
}

// /session/recorded の応答の本文を読み始めた（stream にアクセスした）ことを知らせ、本文は永遠に来ないものにする HttpClient
function stalledRecordedBody() {
  const bodyRequested = Effect.runSync(Deferred.make<void>());
  const layer = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return HttpClient.transformResponse(client, (effect) => Effect.map(effect, (response) =>
        response.request.url.endsWith("/session/recorded")
          ? new Proxy(response, {
              get(target, key) {
                if (key === "stream") {
                  Deferred.doneUnsafe(bodyRequested, Effect.void);
                  return Stream.never;
                }
                return Reflect.get(target, key, target);
              },
            })
          : response));
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici));
  return { bodyRequested, layer };
}

type CliOptions = { env?: Record<string, string>; httpClient?: Layer.Layer<HttpClient.HttpClient> };

function cliDependencies(sessionsDir: string, port: number, apple: typeof unusedApple = unusedApple, options: CliOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(
    NodeServices.layer, apple, readyManagedDeps, options.httpClient ?? NodeHttpClient.layerUndici,
    Layer.succeed(MapCapture, MapCapture.of({ capture: () => Effect.die("CLI は撮影しない") })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.die("CLI は見返しを作らない") })),
    fakeAudioMix().layer, fakeScreenJpeg().layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({
      HOME: join(sessionsDir, "home"), LIVE_MINDMAP_CONFIG: join(sessionsDir, "absent.config.json"), LIVE_MINDMAP_JUDGE: "off",
      LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: String(port), ...options.env,
    })),
    Layer.succeed(Console.Console, consoleService),
  );
  return { layer, stdout, stderr };
}

const resource = Effect.fnUntraced(function* (script: Script, updater: ReturnType<typeof fakeUpdater> = fakeUpdater(), options: { viewing?: ReturnType<typeof fakeTunnel>["viewing"]; fileSystem?: Layer.Layer<FileSystem.FileSystem>; cli?: CliOptions; mix?: FakeMix } = {}) {
  // 実行準備（prepareUpdater）へ届いたモデル
  const models: ExecutableModel[] = [];
  const root = yield* temporaryDirectory;
  const sessionsDir = join(root, "sessions");
  const file = join(root, "meeting.m4a");
  writeFileSync(file, "audio");
  const helpers = fakeHelpers(script);
  const server = yield* startedServer({ port: 0, sessionsDir }, {
    helpers: helpers.layer, managedDeps: readyManagedDeps, ...(options.viewing === undefined ? {} : { viewing: options.viewing }),
    sessionSinks: SessionSinks.layer({ prepareUpdater: (model) => { models.push(model); return Effect.succeed(updater.layer); } }).pipe(Layer.provide(fakeExportServices({ ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }), ...(options.mix === undefined ? {} : { mix: options.mix }) }))),
  });
  const deps = cliDependencies(sessionsDir, server.port, unusedApple, options.cli);
  const cli = (argv: string[]) => runCli(argv).pipe(Effect.provide(deps.layer));
  const localDeps = cliDependencies(sessionsDir, server.port, Layer.succeed(AppleIntelligence, AppleIntelligence.of({
    availability: Effect.succeed({ osVersion: "27.0", availability: { status: "available" } }),
    launch: Effect.die("CLI は Apple を起動しない"),
  })));
  return { root, sessionsDir, file, helpers, updater, server, deps, cli, models, localDeps };
});

type Line = Record<string, unknown> & { type: string };
const logLines = (dir: string): Line[] =>
  readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Line);
const onlySession = (sessionsDir: string) => {
  const names = readdirSync(sessionsDir).filter((name) => existsSync(join(sessionsDir, name, "log.jsonl")));
  expect(names).toHaveLength(1);
  return join(sessionsDir, names[0]!);
};
const remarksOf = (lines: Line[]) => lines.filter((l) => l.type === "remark").map((l) => l.remark as { id: string; track: string; start: number; end: number; text: string });

// 10:00・11:00・12:30 の 3 発言。録画の全体の長さは 58:04
const THREE: Script = {
  duration: 3484,
  remarks: [
    { start: 590, end: 600, text: "最初の発言です" },
    { start: 600, end: 660, text: "次の発言です" },
    { start: 700, end: 750, text: "三つ目の発言です" },
  ],
};

const waitForRemarks = (sessionsDir: string, count: number) =>
  Effect.promise(() => vi.waitFor(() => {
    const dirs = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((name) => existsSync(join(sessionsDir, name, "log.jsonl"))) : [];
    expect(dirs).toHaveLength(1);
    expect(remarksOf(logLines(join(sessionsDir, dirs[0]!)))).toHaveLength(count);
  }, { timeout: 10_000 }));

describe("cli recorded <file>", () => {
  it.live("ファイルを渡すと、1 発言ずつ差分更新の終わりを待って入れ、マップ・log.jsonl・map.* ができる。進み具合の行と、フォルダと map.* のパスが出る", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    // 相対パスで渡しても、サーバー（作業フォルダが違う）には絶対パスで渡る
    yield* r.cli(["recorded", relative(process.cwd(), r.file)]);

    // 絶対パスのファイルと、音声を書くセッションのフォルダ（--audio-dir）で起動する
    const dir = onlySession(r.sessionsDir);
    expect(r.helpers.calls).toEqual([["transcribe-file", "--file", resolve(r.file), "--audio-dir", dir]]);
    // 呼び出しが 3 回あり、重ならず、1 回に 1 発言ずつ
    expect(r.updater.inputs.map((input) => input.fresh.map((remark) => remark.id))).toEqual([["r1"], ["r2"], ["r3"]]);
    expect(r.updater.state.overlaps).toBe(0);

    const lines = logLines(dir);
    // 発言を入れる → その差分更新の終わり → 次の発言、の順
    expect(lines.filter((l) => l.type === "remark" || l.type === "diff").map((l) => l.type)).toEqual(["remark", "diff", "remark", "diff", "remark", "diff"]);
    // 話者は分けない
    expect(remarksOf(lines).map((x) => ({ id: x.id, track: x.track, end: x.end, text: x.text }))).toEqual([
      { id: "r1", track: "相手", end: 600, text: "最初の発言です" },
      { id: "r2", track: "相手", end: 660, text: "次の発言です" },
      { id: "r3", track: "相手", end: 750, text: "三つ目の発言です" },
    ]);
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);

    // 標準出力は、フォルダと map.* のパス（音声つきの見返しは map-audio.html）だけ
    const out = r.deps.stdout.join("").trim().split("\n");
    expect(out[0]).toBe(dir);
    expect(out.slice(1).map((path) => basename(path))).toEqual(expect.arrayContaining(["map.md", "map.json", "map.drawnix"]));
    for (const path of out.slice(1)) {
      expect(path.startsWith(dir)).toBe(true);
      expect(basename(path)).toMatch(/^map[.-]/);
    }
    // 進み具合は標準エラーに 1 行ずつ。最後の行は、入れた位置・全体の長さ・マップの更新回数
    const progress = r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((l) => l.trim() !== "");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe("12:30 / 58:04  マップの更新 3 回");
    for (const line of progress) expect(line).toMatch(/^(\d+:\d\d|--:--) \/ (\d+:\d\d|--:--)  マップの更新 \d+ 回$/);
  }).pipe(Effect.scoped));

  it.live("--title は start と同じく、セッションの題名になる", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* r.cli(["recorded", r.file, "--title", "週次会議"]);
    const start = logLines(onlySession(r.sessionsDir)).find((l) => l.type === "start");
    expect(start).toMatchObject({ title: "週次会議" });
  }).pipe(Effect.scoped));

  it.live("録画からのセッションのフォルダに 相手.m4a（ヘルパーが書いた音声）と map-audio.html ができ、map-audio.html には 相手.m4a から混ぜた音声が入る。元のファイルはコピーしない", () => Effect.gen(function* () {
    const mix = fakeAudioMix();
    const r = yield* resource(THREE, fakeUpdater(), { mix });
    yield* r.cli(["recorded", r.file]);

    const dir = onlySession(r.sessionsDir);
    expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
    expect(existsSync(join(dir, "map-audio.html"))).toBe(true);
    expect(embeddedAudio(readFileSync(join(dir, "map-audio.html"), "utf8"))).toEqual(FAKE_MIX_BYTES);
    expect(mix.calls.map((call) => call.session)).toEqual([dir]);
    expect(readdirSync(dir)).not.toContain(basename(r.file));
    // 標準出力の map.* のパスに map-audio.html も入る
    expect(r.deps.stdout.join("").trim().split("\n").map((path) => basename(path))).toContain("map-audio.html");
  }).pipe(Effect.scoped));

  describe("フォルダ名と log.jsonl の時刻の基準", () => {
    const CREATED = "2026-10-01T01:02:03Z";
    const FOLDER = "2026-10-01T01-02-03.000Z";
    const folderTime = (dir: string) => Date.parse(basename(dir).replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"));
    // log.jsonl に書かれた時刻のすべて: 各行の at と、diff の call の startedAt・endedAt
    const loggedTimes = (lines: Line[]) => lines.flatMap((l) => [
      l.at as string,
      ...(l.type === "diff" && l.call !== undefined ? [(l.call as { startedAt: string }).startedAt, (l.call as { endedAt: string }).endedAt] : []),
    ]).map((t) => Date.parse(t));

    it.live("作成日時を持つファイルでは、フォルダ名がその日時になり、log.jsonl のすべての時刻（at と diff の call）がその日時から数分以内になる。問い合わせはそのファイルの絶対パス", () => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, creationDate: CREATED });
      yield* r.cli(["recorded", relative(process.cwd(), r.file)]);

      expect(r.helpers.creationDateCalls).toEqual([resolve(r.file)]);
      const dir = onlySession(r.sessionsDir);
      expect(basename(dir)).toBe(FOLDER);
      const lines = logLines(dir);
      expect(lines.some((l) => l.type === "diff" && l.call !== undefined)).toBe(true);
      const created = Date.parse(CREATED);
      const times = loggedTimes(lines);
      expect(times.length).toBeGreaterThan(lines.length);
      for (const time of times) {
        expect(time).toBeGreaterThanOrEqual(created);
        expect(time).toBeLessThan(created + 5 * 60_000);
      }
    }).pipe(Effect.scoped));

    it.live.each([
      { name: "作成日時を持たないファイル（null）", creationDate: null },
      { name: "作成日時を読めないファイル（問い合わせの失敗）", creationDate: "fail" as const },
    ])("$name では、フォルダ名と log.jsonl のすべての時刻が、流し始めた今の時刻になり、セッションは止まらない", ({ creationDate }) => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, creationDate });
      const before = Date.now();
      yield* r.cli(["recorded", r.file]);
      const after = Date.now();

      const dir = onlySession(r.sessionsDir);
      expect(basename(dir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
      expect(folderTime(dir)).toBeGreaterThanOrEqual(before - 1);
      expect(folderTime(dir)).toBeLessThanOrEqual(after + 1);
      const lines = logLines(dir);
      expect(remarksOf(lines)).toHaveLength(3);
      for (const time of loggedTimes(lines)) {
        expect(time).toBeGreaterThanOrEqual(before - 1);
        expect(time).toBeLessThanOrEqual(after + 1);
      }
      expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
    }).pipe(Effect.scoped));

    it.live("同じ名前のフォルダが既にあるときは使い回さず、-2 を付けた新しいフォルダに書く。既にあるフォルダの log.jsonl と 相手.m4a は変わらない", () => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, creationDate: CREATED });
      const existing = join(r.sessionsDir, FOLDER);
      mkdirSync(existing, { recursive: true });
      writeFileSync(join(existing, "log.jsonl"), "前のセッション\n");
      writeFileSync(join(existing, "相手.m4a"), "前の音声");

      yield* r.cli(["recorded", r.file]);

      expect(readdirSync(r.sessionsDir).filter((name) => name !== "vocabulary.json").sort()).toEqual([FOLDER, `${FOLDER}-2`]);
      expect(readFileSync(join(existing, "log.jsonl"), "utf8")).toBe("前のセッション\n");
      expect(readFileSync(join(existing, "相手.m4a"), "utf8")).toBe("前の音声");
      const dir = join(r.sessionsDir, `${FOLDER}-2`);
      expect(r.helpers.calls[0]).toEqual(["transcribe-file", "--file", resolve(r.file), "--audio-dir", dir]);
      expect(r.deps.stdout.join("").trim().split("\n")[0]).toBe(dir);
      expect(remarksOf(logLines(dir))).toHaveLength(3);
      expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
    }).pipe(Effect.scoped));
  });

  it.live("--title を省くと、ファイル名（拡張子なし）がセッションの題名になる", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* r.cli(["recorded", r.file]);
    const start = logLines(onlySession(r.sessionsDir)).find((l) => l.type === "start");
    expect(start).toMatchObject({ title: "meeting" });
  }).pipe(Effect.scoped));

  it.live("ヘルパーが 0 以外で終わると、入れた分で終えて map.* を書き、CLI は失敗する（標準エラーにヘルパーの末尾を出す）", () => Effect.gen(function* () {
    const r = yield* resource({ ...THREE, remarks: THREE.remarks.slice(0, 2), exit: { code: 1, signal: null } });
    const result = yield* Effect.result(r.cli(["recorded", r.file]));
    expect(Result.isFailure(result)).toBe(true);
    const dir = onlySession(r.sessionsDir);
    expect(remarksOf(logLines(dir)).map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(existsSync(join(dir, "map.md"))).toBe(true);
    expect(r.deps.stdout.join("")).toContain(join(dir, "map.md"));
    expect(r.deps.stderr.join("")).toContain("helper stderr");
  }).pipe(Effect.scoped));

  it.live("Ctrl-C は、そこまでに入れた分で終えて map.* を書き出す。溜まっていた分は入れず、そのあと status はセッションなしになる", () => Effect.gen(function* () {
    // 2 回目の差分更新は、stop の印が立つまで終わらない。3 発言目は溜まったまま
    const stopSeen = { current: undefined as Deferred.Deferred<void> | undefined };
    const updater = fakeUpdater((_input, call) => call === 2 ? Effect.suspend(() => Deferred.await(stopSeen.current!)) : Effect.void);
    const r = yield* resource(THREE, updater);
    stopSeen.current = r.helpers.stopSeen;
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForRemarks(r.sessionsDir, 2);
    // 実行中のセッションは status に出る（フォルダつき）
    const dir = onlySession(r.sessionsDir);
    const during = cliDependencies(r.sessionsDir, r.server.port);
    yield* runCli(["status"]).pipe(Effect.provide(during.layer));
    expect(during.stdout.join("")).toContain("動いている");
    expect(during.stdout.join("")).toContain(`セッションのフォルダ: ${dir}`);

    yield* Fiber.interrupt(running);

    expect(remarksOf(logLines(dir)).map((x) => x.id)).toEqual(["r1", "r2"]);
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
    const after = cliDependencies(r.sessionsDir, r.server.port);
    yield* runCli(["status"]).pipe(Effect.provide(after.layer));
    expect(after.stdout.join("")).toContain("セッションなし");
  }).pipe(Effect.scoped));

  it.live("ライブのセッションの最中は断る。ヘルパーは起動しない", () => Effect.gen(function* () {
    const r = yield* resource({ remarks: [], hold: true });
    yield* r.cli(["start", "--app", "us.zoom.xos", "--no-audio", "--no-screen"]);
    const result = yield* Effect.result(r.cli(["recorded", r.file]));
    expect(Result.isFailure(result)).toBe(true);
    expect(String(Result.isFailure(result) ? result.failure : "")).toContain("セッションが進行中です（先に stop）");
    expect(r.helpers.calls).toHaveLength(1);
    expect(r.helpers.calls[0]![0]).not.toBe("transcribe-file");
    yield* r.cli(["stop"]);
  }).pipe(Effect.scoped));

  it.live("録画からのセッションの最中は、ライブの start も別の recorded も断る。resume も断る", () => Effect.gen(function* () {
    const stopSeen = { current: undefined as Deferred.Deferred<void> | undefined };
    // 最初の差分更新が終わらず、セッションが続いている間に別の入口を試す
    const updater = fakeUpdater(() => Effect.suspend(() => Deferred.await(stopSeen.current!)));
    const r = yield* resource(THREE, updater);
    stopSeen.current = r.helpers.stopSeen;
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForRemarks(r.sessionsDir, 1);

    const attempt = (argv: string[]) => Effect.gen(function* () {
      const result = yield* Effect.result(r.cli(argv));
      expect(Result.isFailure(result)).toBe(true);
      return String(Result.isFailure(result) ? result.failure : "");
    });
    expect(yield* attempt(["start", "--app", "us.zoom.xos", "--no-audio", "--no-screen"])).toContain("セッションが進行中です（先に stop）");
    expect(yield* attempt(["recorded", r.file])).toContain("セッションが進行中です（先に stop）");
    expect(yield* attempt(["resume"])).toContain("録画からのセッションでは使えません");
    // 断った入口は、ヘルパーを起動していない
    expect(r.helpers.calls).toHaveLength(1);

    yield* r.cli(["stop"]);
    yield* Fiber.join(running).pipe(Effect.ignore);
  }).pipe(Effect.scoped));
  it.live("--vocab は語彙として vocab の行（source: user）に残り、モデルは実行準備へ届く。--local はローカルモードを求める", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const vocab = join(r.root, "vocab.txt");
    writeFileSync(vocab, "ヤマダ商事\n\n  アルファ \n");
    yield* r.cli(["recorded", r.file, "--vocab", vocab]);
    const words = logLines(onlySession(r.sessionsDir)).filter((l) => l.type === "vocab").flatMap((l) => (l.words as Array<{ surface: string; source: string }>).filter((w) => w.source === "user").map((w) => w.surface));
    expect(words).toEqual(["ヤマダ商事", "アルファ"]);
    expect(r.models).toHaveLength(1);
    expect(r.models[0]).toMatchObject({ route: "claude", local: false });
  }).pipe(Effect.scoped));

  it.live("--local は実行準備へ届くモデルをローカルにする", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* runCli(["recorded", r.file, "--local"]).pipe(Effect.provide(r.localDeps.layer));
    expect(r.models).toHaveLength(1);
    expect(r.models[0]).toMatchObject({ route: "apple", local: true });
  }).pipe(Effect.scoped));

  it.live("字幕・ログ・進み具合は、セッションに入れた位置で出る。差分更新が終わるまで、先読みした発言と途中結果は字幕にも進み具合にもログにも出ない", () => Effect.gen(function* () {
    const gate = Effect.runSync(Deferred.make<void>());
    const updater = fakeUpdater((_input, call) => call === 1 ? Deferred.await(gate) : Effect.void);
    const r = yield* resource({ ...THREE, hold: true }, updater);
    const frames: string[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${r.server.port}/ws`);
    socket.on("message", (data) => { frames.push(String(data)); });
    yield* Effect.promise(() => new Promise<void>((done) => socket.on("open", () => done())));
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForRemarks(r.sessionsDir, 1);
    const joined = () => frames.join("\n");
    const eventually = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion, { timeout: 10_000 }));
    // 最初の発言の字幕のフレームが届くまで待つ
    yield* eventually(() => { expect(joined()).toContain("最初の発言です"); });
    // 1 つ目の差分更新が終わらない間に、先の発言の途中結果と、その後ろの全体の長さが届く。サーバーは 1 件ずつ順に処理するので、
    // 全体の長さの進み具合が標準エラーに出たなら、その前の途中結果の処理は終わっている
    r.helpers.feed({ type: "partial", track: "相手", start: 800, end: 810, text: "先読みの途中結果です" });
    r.helpers.feed({ type: "file-duration", duration: 3485 });
    yield* eventually(() => { expect(r.deps.stderr.join("")).toContain("/ 58:05"); });

    expect(remarksOf(logLines(onlySession(r.sessionsDir))).map((x) => x.id)).toEqual(["r1"]);
    // 差分更新の公開（"round":1）のフレームと、その直後の 1 フレーム（相手 → 自分の順の flush）までに届いたものを集める。
    // 先読みした発言と途中結果は、入れた位置の字幕には出ない
    const early = r.deps.stderr.join("").replaceAll("\r", "\n");
    expect(early).not.toContain("10:00 /");
    expect(early).not.toContain("12:30 /");
    yield* Deferred.succeed(gate, undefined);
    yield* eventually(() => { expect(joined()).toContain("\"round\":1"); });
    const boundary = frames.findIndex((frame) => frame.includes("\"round\":1"));
    yield* eventually(() => { expect(frames.length).toBeGreaterThan(boundary + 1); });
    const settled = frames.slice(0, boundary + 2).join("\n");
    expect(settled).toContain("最初の発言です");
    for (const ahead of ["次の発言です", "三つ目の発言です", "先読みの途中結果です"]) expect(settled).not.toContain(ahead);

    yield* waitForRemarks(r.sessionsDir, 3);
    yield* eventually(() => { expect(r.deps.stderr.join("").replaceAll("\r", "\n")).toContain("12:30 / 58:05  マップの更新 3 回"); });
    yield* eventually(() => { expect(joined()).toContain("\"round\":3"); });
    yield* r.cli(["stop"]);
    yield* Fiber.join(running).pipe(Effect.ignore);
  }).pipe(Effect.scoped));

  const failsRemarkTwo = () => failingLogWrite((content) => content.includes('"type":"remark"') && content.includes("次の発言です"));
  const within = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.timeout("10 seconds"));
  const failureText = (result: Result.Result<unknown, unknown>) => (Result.isFailure(result) ? String(result.failure) : "");

  // 失敗の後で、次の recorded を始められる（SessionBusy・SessionTransition で断られない）ことを、ヘルパーの起動で確かめる
  const nextRecordedStarts = (r: { cli: (argv: string[]) => Effect.Effect<void, unknown, never>; helpers: { calls: string[][] }; file: string }, held: boolean) => Effect.gen(function* () {
    const before = r.helpers.calls.length;
    const next = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* Effect.promise(() => vi.waitFor(() => { expect(r.helpers.calls.length).toBe(before + 1); }, { timeout: 10_000 }));
    if (held) yield* r.cli(["stop"]);
    expect(Result.isSuccess(yield* Effect.result(within(Fiber.join(next))))).toBe(true);
  });

  it.live("取り込みの終わらせ方で書き込みが失敗しても、CLI は待ち続けず失敗で戻り、次の recorded を始められる", () => Effect.gen(function* () {
    const failing = failsRemarkTwo();
    const r = yield* resource(THREE, fakeUpdater(), { fileSystem: failing.layer });
    const result = yield* Effect.result(within(r.cli(["recorded", r.file])));
    expect(failing.writes.failed).toBe(1);
    expect(Result.isFailure(result)).toBe(true);
    expect(failureText(result)).toContain("録画からのセッションが終わる前に接続が終了しました");
    yield* nextRecordedStarts({ cli: r.cli, helpers: r.helpers, file: r.file }, false);
  }).pipe(Effect.scoped));

  it.live("stop の本体で書き込みが失敗しても、イベント列は閉じて recorded の CLI は失敗で戻り、次の recorded を始められる", () => Effect.gen(function* () {
    const failing = failsRemarkTwo();
    const r = yield* resource({ ...THREE, hold: true }, fakeUpdater(), { fileSystem: failing.layer });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* Effect.promise(() => vi.waitFor(() => { expect(failing.writes.failed).toBe(1); }, { timeout: 10_000 }));
    yield* Effect.result(within(r.cli(["stop"])));
    const result = yield* Effect.result(within(Fiber.join(running)));
    expect(Result.isFailure(result)).toBe(true);
    expect(failureText(result)).toContain("録画からのセッションが終わる前に接続が終了しました");
    yield* nextRecordedStarts({ cli: r.cli, helpers: r.helpers, file: r.file }, true);
  }).pipe(Effect.scoped));

  it.live("開始の応答を受け取った後、started を読む前の Ctrl-C でも、停止を求めて map.* を書き出し、status はセッションなしになる", () => Effect.gen(function* () {
    const stalled = stalledRecordedBody();
    const r = yield* resource({ ...THREE, hold: true }, fakeUpdater(), { cli: { httpClient: stalled.layer } });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* Deferred.await(stalled.bodyRequested).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(running);

    const dir = onlySession(r.sessionsDir);
    expect(existsSync(join(dir, "map.md"))).toBe(true);
    yield* Deferred.await(r.helpers.stopSeen).pipe(Effect.timeout("10 seconds"));
    const after = cliDependencies(r.sessionsDir, r.server.port);
    yield* runCli(["status"]).pipe(Effect.provide(after.layer));
    expect(after.stdout.join("")).toContain("セッションなし");
    // started を読めていないので、フォルダは出さず map.* のパスだけを出す
    expect(r.deps.stdout.join("")).toContain(join(dir, "map.md"));
  }).pipe(Effect.scoped));

  it.live("--model は名前で解決したモデルが、実行準備へ届く", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const config = join(root, "named.config.json");
    writeFileSync(config, JSON.stringify({ models: { fast: { route: "claude", model: "claude-haiku-5-5" } } }));
    const r = yield* resource(THREE, fakeUpdater(), { cli: { env: { LIVE_MINDMAP_CONFIG: config } } });
    yield* r.cli(["recorded", r.file, "--model", "fast"]);
    expect(r.models).toHaveLength(1);
    expect(r.models[0]).toMatchObject({ name: "fast", route: "claude", model: "claude-haiku-5-5", local: false });
  }).pipe(Effect.scoped));

  it.live("share は録画からのセッションの最中も開け、閉じる後片付けは録画の終了で走る", () => Effect.gen(function* () {
    const tunnel = fakeTunnel();
    const stopSeen = { current: undefined as Deferred.Deferred<void> | undefined };
    const updater = fakeUpdater(() => Effect.suspend(() => Deferred.await(stopSeen.current!)));
    const r = yield* resource(THREE, updater, { viewing: tunnel.viewing });
    stopSeen.current = r.helpers.stopSeen;
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForRemarks(r.sessionsDir, 1);

    const shared = cliDependencies(r.sessionsDir, r.server.port);
    yield* runCli(["share", "--anyone"]).pipe(Effect.provide(shared.layer));
    expect(shared.stdout.join("")).toContain(FAKE_TUNNEL_HOST);
    expect(tunnel.opened).toHaveLength(1);
    expect(tunnel.closed()).toBe(0);

    yield* r.cli(["stop"]);
    yield* Fiber.join(running).pipe(Effect.ignore);
    expect(tunnel.closed()).toBe(1);
  }).pipe(Effect.scoped));
});
