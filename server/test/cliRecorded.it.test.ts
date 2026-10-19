import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { WebSocket } from "ws";
import { Clock, ConfigProvider, Console, Deferred, Effect, FileSystem, Fiber, Layer, Queue, Result, Stream, type Cause } from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import { DiffUpdatePaused, formatAudioTracksNotice, formatRecordedPosition, formatScreenOffNotice, formatSpeakerOffNotice, type DiffInput } from "../src/core/index.ts";
import { Helpers, HelperLaunchFailure, type HelperExitInfo } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { fakeReadings, type FakeReadings } from "./fixtures/readings.ts";
import { readyHelperChecks } from "./fixtures/helperCheck.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { advanceTo, eventually, runToEnd, trackingClock, virtualNow } from "./fixtures/virtualTime.ts";
import { FAKE_TUNNEL_HOST, fakeTunnel } from "./fixtures/tunnel.ts";
import type { ExecutableModel } from "../src/modelSelection.ts";
import { planModel } from "../src/updatePlan.ts";

// cli recorded <file> を、CLI の入口から常駐サーバー・偽の Helpers（台本のイベント）・偽の差分更新まで通して確かめる。
// 試すシームは CLI の recorded コマンドと、サーバーの Helpers.launch・DiffUpdater.update の 2 つ。

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-cli-recorded-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

type Remark = { start: number; end: number; text: string };
type Script = {
  duration?: number;
  // ヘルパーが流す file-audio-tracks の本数（file-duration の後）。省略すると流さない
  audioTracks?: number;
  remarks: Remark[];
  // 渡すと remarks の代わりに、このイベントをこの順で流す（共有画面の変化を発言の間に挟むとき）
  events?: unknown[];
  // true なら、台本のイベントを流し終えてもヘルパーは終わらない（stop の印で終わる）
  hold?: boolean;
  exit?: HelperExitInfo; // 自然に終わるときの終わり方（既定 code 0）
  // ヘルパーの creation-date の答え。ISO8601 の文字列、null（作成日時を持たないファイル）、"fail"（問い合わせの失敗）。既定は null
  creationDate?: string | null | "fail";
  // true なら、この回の起動は接続できないまま待つ（stop の印で HelperLaunchFailure になる）。起動し直しの接続待ちの間の stop を試す
  blockLaunch?: boolean;
  // true なら、この回の起動は接続できず、すぐ失敗する（HelperLaunchFailure）
  failLaunch?: boolean;
};

// 偽のヘルパーが --audio-dir へ書く音声（相手.m4a）の中身
const HELPER_AUDIO = "ヘルパーが書いた音声";
// --self-file があるときだけ、偽のヘルパーが --audio-dir へ書く 自分.m4a の中身
const HELPER_SELF_AUDIO = "ヘルパーが書いた自分の音声";

// ヘルパーは、録画の文字起こしでは partial → remark の順に出す
const remarkEvents = (r: Remark, track: "相手" | "自分" = "相手"): unknown[] => [
  { type: "partial", track, ...r },
  { type: "remark", track, ...r },
];
const events = (script: Script): unknown[] => [
  ...(script.duration === undefined ? [] : [{ type: "file-duration", duration: script.duration }]),
  ...(script.audioTracks === undefined ? [] : [{ type: "file-audio-tracks", count: script.audioTracks }]),
  ...(script.events ?? script.remarks.flatMap((r) => remarkEvents(r))),
];

// attempts[n] は n 回目（0 始まり）の起動の台本。無い回は script を使う（起動し直しで別の振る舞いを試すときだけ渡す）
function fakeHelpers(script: Script, attempts: ReadonlyArray<Script> = []) {
  const calls: string[][] = [];
  // サーバーからヘルパーへ送られた指示（self-pause・reading-pause）を、送られた順に
  const sent: { type: string; paused: boolean }[] = [];
  // 同じ指示を、送り先の起動回（0 始まり）つきで記録したもの
  const sentByAttempt: { attempt: number; type: string; paused: boolean }[] = [];
  const stopSeen = Effect.runSync(Deferred.make<void>());
  // 起動した後に、テストからヘルパーのイベントを足す
  const live: { queue: Queue.Queue<string, Cause.Done> | undefined; end: Effect.Effect<void> | undefined; crash: Effect.Effect<void> | undefined } = { queue: undefined, end: undefined, crash: undefined };
  const feed = (event: unknown) => { Queue.offerUnsafe(live.queue!, JSON.stringify(event)); };
  // hold のヘルパーを、自然な終わり（code 0）で終わらせる
  const end = Effect.suspend(() => live.end!);
  // hold のヘルパーを、終了コード 1 で落とす（ヘルパーだけが落ちた）
  const crash = Effect.suspend(() => live.crash!);
  const creationDateCalls: string[] = [];
  const creationDate = (file: string) => {
    creationDateCalls.push(file);
    return script.creationDate === "fail"
      ? Effect.fail({ _tag: "HelperCreationDateFailure", message: "作成日時を読めない" } as never)
      : Effect.succeed(script.creationDate ?? null);
  };
  const launch = (args: ReadonlyArray<string>, stopRequested: Deferred.Deferred<void>) => Effect.gen(function* () {
    calls.push([...args]);
    const attemptIndex = calls.length - 1;
    const current = attempts[attemptIndex] ?? script;
    if (current.failLaunch === true) return yield* new HelperLaunchFailure({ stderrTail: ["起動できない"], exit: { code: 1, signal: null } });
    if (current.blockLaunch === true) {
      yield* Deferred.await(stopRequested);
      return yield* new HelperLaunchFailure({ stderrTail: [], exit: { code: null, signal: "SIGTERM" } });
    }
    // 本物のヘルパーは、待ち受けを始める前に --audio-dir のフォルダへ 相手.m4a を書く
    const audioDir = args[args.indexOf("--audio-dir") + 1];
    if (args.includes("--audio-dir") && audioDir !== undefined) writeFileSync(join(audioDir, "相手.m4a"), HELPER_AUDIO);
    // --self-file のときは、自分用の音声も書く（待ち受けの前に 相手.m4a と 自分.m4a の両方を書き終える）
    if (args.includes("--audio-dir") && args.includes("--self-file") && audioDir !== undefined) writeFileSync(join(audioDir, "自分.m4a"), HELPER_SELF_AUDIO);
    const queue = yield* Queue.make<string, Cause.Done>();
    live.queue = queue;
    const exited = yield* Deferred.make<HelperExitInfo>();
    const finish = (info: HelperExitInfo) => Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, info)));
    live.end = finish({ code: 0, signal: null });
    live.crash = finish({ code: 1, signal: null });
    const stop = finish({ code: null, signal: "SIGTERM" });
    yield* Effect.addFinalizer(() => stop);
    yield* Effect.forkScoped(Effect.andThen(Deferred.await(stopRequested), Deferred.succeed(stopSeen, undefined)));
    for (const event of events(current)) Queue.offerUnsafe(queue, JSON.stringify(event));
    if (current.hold !== true) yield* finish(current.exit ?? { code: 0, signal: null });
    return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed(["helper stderr"]), send: (instruction: { type: string; paused: boolean }) => Effect.sync(() => { sent.push(instruction); sentByAttempt.push({ attempt: attemptIndex, ...instruction }); }) };
  });
  const layer = Layer.succeed(Helpers, Helpers.of({ ...readyHelperChecks, apps: Effect.succeed([]), creationDate, launch }));
  return { calls, sent, sentByAttempt, creationDateCalls, stopSeen, layer, feed, end, crash };
}

type UpdateScript = (input: DiffInput, call: number) => Effect.Effect<void, UpdateFailure>;

// 呼び出しを記録する差分更新。呼び出しが重なったら（前の呼び出しの終わりを待たずに次を呼んだら）overlaps が増える
function fakeUpdater(before: UpdateScript = () => Effect.void) {
  const inputs: DiffInput[] = [];
  const state = { inFlight: 0, overlaps: 0 };
  const layer = updaterLayer((input: DiffInput) => Effect.gen(function* () {
    inputs.push(input);
    state.inFlight += 1;
    if (state.inFlight > 1) state.overlaps += 1;
    yield* before(input, inputs.length).pipe(Effect.ensuring(Effect.sync(() => { state.inFlight -= 1; })));
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

// log.jsonl への書き込みのうち、条件に合う最初の 1 回を、release されるまで保留する FileSystem。保留に入ったら entered が完了する
function stallingLogWrite(matches: (content: string) => boolean) {
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  const state = { armed: true };
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return new Proxy(fs, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "writeFileString") return value;
          return (path: string, data: string, options?: unknown) => {
            const write = (value as (...args: unknown[]) => Effect.Effect<void>).call(target, path, data, options);
            if (!(state.armed && path.endsWith("log.jsonl") && matches(data))) return write;
            state.armed = false;
            return Effect.andThen(Deferred.succeed(entered, undefined), Effect.andThen(Deferred.await(release), write));
          };
        },
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return { entered, release, layer };
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

function cliDependencies(sessionsDir: string, port: number, options: CliOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(
    NodeServices.layer, unusedApple, readyManagedDeps, options.httpClient ?? NodeHttpClient.layerUndici,
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

const resource = Effect.fnUntraced(function* (script: Script, updater: ReturnType<typeof fakeUpdater> = fakeUpdater(), options: { fileName?: string; viewing?: ReturnType<typeof fakeTunnel>["viewing"]; fileSystem?: Layer.Layer<FileSystem.FileSystem>; cli?: CliOptions; readings?: FakeReadings; attempts?: ReadonlyArray<Script> } = {}) {
  // 実行準備（prepareUpdater）へ届いたモデル
  const models: ExecutableModel[] = [];
  const root = yield* temporaryDirectory;
  const sessionsDir = join(root, "sessions");
  const file = join(root, options.fileName ?? "meeting.m4a");
  writeFileSync(file, "audio");
  // --self に渡す、自分用の録音
  const selfFile = join(root, "me.m4a");
  writeFileSync(selfFile, "self audio");
  const helpers = fakeHelpers(script, options.attempts);
  const server = yield* startedServer({ port: 0, sessionsDir }, {
    helpers: helpers.layer, managedDeps: readyManagedDeps, ...(options.viewing === undefined ? {} : { viewing: options.viewing }),
    sessionSinks: SessionSinks.layer({ prepareUpdater: (plan) => { models.push(planModel(plan)); return Effect.succeed({ layer: updater.layer }); } }).pipe(Layer.provide(fakeExportServices({ ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }), ...(options.readings === undefined ? {} : { readings: options.readings }) }))),
  });
  const deps = cliDependencies(sessionsDir, server.port, options.cli);
  const cli = (argv: string[]) => runCli(argv).pipe(Effect.provide(deps.layer));
  return { root, sessionsDir, file, selfFile, helpers, updater, server, deps, cli, models };
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

const failureText = (result: Result.Result<unknown, unknown>) => (Result.isFailure(result) ? String(result.failure) : "");

const within = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.timeout("10 seconds"));

const SCREEN_IMAGE = Buffer.from("jpeg-bytes").toString("base64");
const sessionLog = (sessionsDir: string): Line[] => {
  const dirs = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((name) => existsSync(join(sessionsDir, name, "log.jsonl"))) : [];
  return dirs.length === 1 ? logLines(join(sessionsDir, dirs[0]!)) : [];
};
const has = (sessionsDir: string, match: (l: Line) => boolean) => sessionLog(sessionsDir).some(match);
const garbledWords = [
  { surface: "江南", romaji: "kounan", location: 0, length: 2 },
  { surface: "店", romaji: "ten", location: 2, length: 1 },
  { surface: "に", romaji: "ni", location: 3, length: 1 },
  { surface: "行き", romaji: "iki", location: 4, length: 2 },
  { surface: "ます", romaji: "masu", location: 6, length: 2 },
];
const garbledRemark = (start: number, end: number) => ({ type: "remark", track: "相手", start, end, text: "江南店に行きます", words: garbledWords });
const garbledPartial = (start: number, end: number) => ({ type: "partial", track: "相手", start, end, text: "江南店に行きます" });
const vocabLines = (lines: Line[]) => lines.filter((l) => l.type === "vocab");
const remarkTexts = (lines: Line[]) => lines.filter((l) => l.type === "remark").map((l) => (l.remark as { text: string }).text);

const waitForRemarks = (sessionsDir: string, count: number) =>
  Effect.promise(() => vi.waitFor(() => {
    const dirs = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((name) => existsSync(join(sessionsDir, name, "log.jsonl"))) : [];
    expect(dirs).toHaveLength(1);
    expect(remarksOf(logLines(join(sessionsDir, dirs[0]!)))).toHaveLength(count);
  }, { timeout: 10_000 }));

// 偽の時計をサーバーにも CLI にも渡す（resource の中のサーバーの起動も、この Clock の下で行う）
const withVirtualClock = <A, E, R>(body: (pending: number[]) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const pending: number[] = [];
    const clock = yield* trackingClock(pending);
    return yield* body(pending).pipe(Effect.provideService(Clock.Clock, clock));
  });

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
    // 話者分離の speaker 系のイベントを流さない台本（話者なしの 相手）
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

  describe("動画のファイル", () => {
    const stderrLines = (r: { deps: { stderr: string[] } }) => r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((l) => l.trim() !== "");

    it.live("音声のトラックが 2 本あると、最初のトラックだけを使ったことと --self を使えることを標準エラーに 1 回出す。発言は入り、セッションのフォルダには 相手.m4a だけが残り、動画はコピーされない", () => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, audioTracks: 2 }, fakeUpdater(), { fileName: "meeting.mp4" });
      yield* r.cli(["recorded", r.file]);

      const notice = formatAudioTracksNotice(2);
      // 文面は本番の formatter とは別に確かめる（最初のトラックだけを使ったことと、--self を使えること）
      expect(notice).toContain("最初のトラックだけを使いました");
      expect(notice).toContain("--self");
      expect(stderrLines(r).filter((l) => l === "音声のトラックが 2 本あります。最初のトラックだけを使いました（分けたいときは --self を使えます）")).toHaveLength(1);
      expect(stderrLines(r).filter((l) => l === notice)).toHaveLength(1);
      const dir = onlySession(r.sessionsDir);
      expect(remarksOf(logLines(dir)).map((x) => x.text)).toEqual(["最初の発言です", "次の発言です", "三つ目の発言です"]);
      expect(r.helpers.calls).toEqual([["transcribe-file", "--file", resolve(r.file), "--audio-dir", dir]]);
      expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
      expect(readdirSync(dir)).not.toContain("meeting.mp4");
    }).pipe(Effect.scoped));

    it.live("音声のトラックが 1 本なら、知らせは出ない", () => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, audioTracks: 1 }, fakeUpdater(), { fileName: "meeting.mp4" });
      yield* r.cli(["recorded", r.file]);

      const output = r.deps.stderr.join("");
      expect(output).not.toContain("--self");
      expect(output).not.toContain(formatAudioTracksNotice(2));
      expect(remarksOf(logLines(onlySession(r.sessionsDir)))).toHaveLength(3);
    }).pipe(Effect.scoped));
  });

  describe("--self（自分用の録音を足して、ライブと同じ 2 トラックで組む）", () => {
    type SpokenRemark = { start: number; end: number; text: string };
    // ヘルパーは、録画の文字起こしでは partial → remark の順に出す。duplicate は 自分 の重複の印
    const spoken = (track: "相手" | "自分", r: SpokenRemark, duplicate = false): unknown[] => [
      { type: "partial", track, ...r, duplicate },
      { type: "remark", track, ...r, duplicate },
    ];
    const idsAndTracks = (dir: string) => remarksOf(logLines(dir)).map((x) => ({ id: x.id, track: x.track, end: x.end, text: x.text }));
    const sessionEntries = (sessionsDir: string) => (existsSync(sessionsDir) ? readdirSync(sessionsDir) : []).filter((name) => name !== "vocabulary.json");

    // 音声の時刻の順に交互に流す 2 本の台本。最後の 自分 は、相手の二つ目とほぼ同じ文のスピーカーの回り込み（ヘルパーが重複の印を付けた確定結果）
    const INTERLEAVED: Script = {
      duration: 10,
      remarks: [],
      events: [
        ...spoken("相手", { start: 0, end: 2, text: "相手の一つ目" }),
        ...spoken("自分", { start: 2.5, end: 4, text: "自分の発言" }),
        ...spoken("相手", { start: 4.5, end: 6, text: "相手の二つ目" }),
        ...spoken("自分", { start: 4.6, end: 6.2, text: "相手の二つ目" }, true),
      ],
    };

    it.live("--self のファイルは、絶対パスの --self-file としてヘルパーに渡る（--file・--audio-dir の組はそのまま）", () => Effect.gen(function* () {
      const r = yield* resource(INTERLEAVED);
      yield* r.cli(["recorded", relative(process.cwd(), r.file), "--self", relative(process.cwd(), r.selfFile)]);

      const dir = onlySession(r.sessionsDir);
      expect(r.helpers.calls).toEqual([["transcribe-file", "--file", resolve(r.file), "--self-file", resolve(r.selfFile), "--audio-dir", dir]]);
    }).pipe(Effect.scoped));

    it.live("相手 と 自分 の発言が、音声の時刻（end）の順に並ぶ。相手 の保留を自分が追い越さない。自分 の重複の印はライブと同じに付き、差分更新には入らない", () => Effect.gen(function* () {
      const r = yield* resource(INTERLEAVED);
      yield* r.cli(["recorded", r.file, "--self", r.selfFile]);

      const dir = onlySession(r.sessionsDir);
      expect(idsAndTracks(dir)).toEqual([
        { id: "r1", track: "相手", end: 2, text: "相手の一つ目" },
        { id: "r2", track: "自分", end: 4, text: "自分の発言" },
        { id: "r3", track: "相手", end: 6, text: "相手の二つ目" },
        { id: "r4", track: "自分", end: 6.2, text: "相手の二つ目" },
      ]);
      // 重複の印は、自分 の最後の発言にだけ付く（ログに残り、差分更新の fresh には入らない）
      const remarks = remarksOf(logLines(dir)) as { track: string; duplicate?: boolean }[];
      expect(remarks.map((x) => x.duplicate === true)).toEqual([false, false, false, true]);
      expect(r.updater.inputs.flatMap((input) => input.fresh.map((remark) => remark.text))).toEqual(["相手の一つ目", "自分の発言", "相手の二つ目"]);
      expect(r.updater.state.overlaps).toBe(0);
    }).pipe(Effect.scoped));

    it.live("--self の 自分 の発言は、ライブと同じ字幕のフレームで track: 自分 の本文として WebSocket に届く（相手 の本文は track: 相手）。終了時の空のフレームとは区別する", () => Effect.gen(function* () {
      // 2 つ目の差分更新（自分 の発言を入れた直後）を止め、自分 の発言が未反映の間に出る字幕を見る。終了時の空のフレームはまだ出ない
      const gate = Effect.runSync(Deferred.make<void>());
      const updater = fakeUpdater((_input, call) => call === 2 ? Deferred.await(gate) : Effect.void);
      const r = yield* resource(INTERLEAVED, updater);
      const frames: string[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${r.server.port}/ws`);
      socket.on("message", (data) => { frames.push(String(data)); });
      yield* Effect.promise(() => new Promise<void>((done) => socket.on("open", () => done())));
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));
      yield* Effect.forkChild(r.cli(["recorded", r.file, "--self", r.selfFile]));

      // 字幕のフレーム（captions）の吹き出しを、すべてのフレームから集める
      const bubbles = () => frames.flatMap((frame) => {
        try { return [JSON.parse(frame) as { type?: string; bubbles?: { track: string; text: string }[] }]; } catch { return []; }
      }).flatMap((frame) => frame.type === "captions" ? frame.bubbles ?? [] : []);
      yield* Effect.promise(() => vi.waitFor(() => {
        expect(bubbles().some((b) => b.track === "自分" && b.text.includes("自分の発言"))).toBe(true);
      }, { timeout: 10_000 }));
      expect(bubbles().some((b) => b.track === "相手" && b.text.includes("自分の発言"))).toBe(false);
      yield* Deferred.succeed(gate, undefined);
    }).pipe(Effect.scoped));

    it.live("1 トラックしか発言が無くても、ヘルパーが終われば全部入る（どちらかが黙っている間に溜めた発言は、終わりで出し切る）", () => Effect.gen(function* () {
      const r = yield* resource({
        duration: 10,
        remarks: [],
        events: [
          ...spoken("相手", { start: 0, end: 2, text: "相手の一つ目" }),
          ...spoken("相手", { start: 4, end: 5, text: "相手の二つ目" }),
        ],
      });
      yield* r.cli(["recorded", r.file, "--self", r.selfFile]);

      expect(idsAndTracks(onlySession(r.sessionsDir)).map((x) => [x.id, x.track, x.end])).toEqual([["r1", "相手", 2], ["r2", "相手", 5]]);
    }).pipe(Effect.scoped));

    it.live("--self を渡さないときは 自分.m4a を作らず、ヘルパーの引数に --self-file が入らない", () => Effect.gen(function* () {
      const r = yield* resource(THREE);
      yield* r.cli(["recorded", r.file]);

      const dir = onlySession(r.sessionsDir);
      expect(r.helpers.calls[0]).not.toContain("--self-file");
      expect(readdirSync(dir)).not.toContain("自分.m4a");
    }).pipe(Effect.scoped));

    it.live("作成日時の問い合わせと題名は、メインのファイルだけで決める（--self のファイルは使わない）", () => Effect.gen(function* () {
      const r = yield* resource({ ...INTERLEAVED, creationDate: "2026-10-01T01:02:03Z" });
      yield* r.cli(["recorded", r.file, "--self", r.selfFile]);

      expect(r.helpers.creationDateCalls).toEqual([resolve(r.file)]);
      expect(basename(onlySession(r.sessionsDir))).toBe("2026-10-01T01-02-03.000Z");
      expect(logLines(onlySession(r.sessionsDir)).find((l) => l.type === "start")).toMatchObject({ title: "meeting" });
    }).pipe(Effect.scoped));

    it.live("--self だけを渡す（メインのファイルが無い）と断る。ヘルパーは起動せず、セッションのフォルダも作らない", () => Effect.gen(function* () {
      const r = yield* resource(INTERLEAVED);
      const result = yield* Effect.result(r.cli(["recorded", "--self", r.selfFile]));

      expect(Result.isFailure(result)).toBe(true);
      expect(r.helpers.calls).toEqual([]);
      expect(sessionEntries(r.sessionsDir)).toEqual([]);
    }).pipe(Effect.scoped));

    it.live("--self に存在しないファイルを渡すと断る。ヘルパーは起動せず、セッションのフォルダも作らない", () => Effect.gen(function* () {
      const r = yield* resource(INTERLEAVED);
      const result = yield* Effect.result(r.cli(["recorded", r.file, "--self", join(r.root, "absent.m4a")]));

      expect(Result.isFailure(result)).toBe(true);
      expect(r.helpers.calls).toEqual([]);
      expect(sessionEntries(r.sessionsDir)).toEqual([]);
    }).pipe(Effect.scoped));
  });

  it.live("--title は start と同じく、セッションの題名になる", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* r.cli(["recorded", r.file, "--title", "週次会議"]);
    const start = logLines(onlySession(r.sessionsDir)).find((l) => l.type === "start");
    expect(start).toMatchObject({ title: "週次会議" });
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

  it.live("ヘルパーが落ち続けて起動し直しを諦めると、そこまでに入れた分で終えて map.* を書き、CLI は失敗する。進んだ位置とヘルパーの標準エラーの末尾が出る", () => Effect.gen(function* () {
    // どの回も r1・r2 を流して 0 以外で終わる（2 回目以降は音声の時刻 660 より前の結果なので捨てられる）
    const r = yield* resource({ ...THREE, remarks: THREE.remarks.slice(0, 2), exit: { code: 1, signal: null } });
    const result = yield* Effect.result(r.cli(["recorded", r.file]));
    expect(Result.isFailure(result)).toBe(true);
    const dir = onlySession(r.sessionsDir);
    const lines = logLines(dir);
    // 諦めたら Ctrl-C と同じく、溜まりは捨てて入れている途中の 1 件だけ入れ終える。入れ終えた分は先頭から連続し、読み直しで重なっていない
    const ids = remarksOf(lines).map((x) => x.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids).toEqual(["r1", "r2"].slice(0, ids.length));
    // ライブと同じ判断（続けて 3 回失敗）で諦める: 起動は 3 回、起動し直しは 2 回
    expect(r.helpers.calls).toHaveLength(3);
    expect(lines.filter((l) => l.type === "intake-stopped")).toHaveLength(3);
    expect(lines.filter((l) => l.type === "intake-restarted")).toHaveLength(2);
    expect(lines.filter((l) => l.type === "intake-gave-up")).toEqual([expect.objectContaining({ reason: "failures" })]);
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
    expect(r.deps.stdout.join("")).toContain(join(dir, "map.md"));
    expect(r.deps.stderr.join("")).toContain("helper stderr");
    // 進んだ位置（入れた最後の発言の end / 全体の長さ。r2 まで入れていれば 11:00 / 58:04）は、進み具合の行（… マップの更新 N 回）とは別に、諦めたことの知らせとして出る
    const reached = formatRecordedPosition(ids.length === 2 ? 660 : 600, 3484);
    const stderrLines = r.deps.stderr.join("").replaceAll("\r", "\n").split("\n");
    const notices = [...stderrLines.filter((l) => !/マップの更新 \d+ 回$/.test(l)), failureText(result)];
    expect(notices.some((l) => l.includes(reached))).toBe(true);
  }).pipe(Effect.scoped));

  it.live("起動し直したヘルパーに接続できない回も 1 回の失敗として数え、続けて 3 回で諦める。map.* を書き、CLI は進んだ位置と最後の起動失敗の標準エラーを出して失敗する", () => Effect.gen(function* () {
    // 1 回目は r1・r2 を流して落ちる。2・3 回目は接続できない
    const first: Script = { duration: 3484, remarks: THREE.remarks.slice(0, 2), exit: { code: 1, signal: null } };
    const r = yield* resource(THREE, undefined, { attempts: [first, { remarks: [], failLaunch: true }, { remarks: [], failLaunch: true }] });
    const result = yield* Effect.result(r.cli(["recorded", r.file]));
    expect(Result.isFailure(result)).toBe(true);
    const dir = onlySession(r.sessionsDir);
    const lines = logLines(dir);
    expect(r.helpers.calls).toHaveLength(3);
    expect(lines.filter((l) => l.type === "intake-stopped")).toHaveLength(3);
    // 接続できなかった回は起動し直しに数えない
    expect(lines.filter((l) => l.type === "intake-restarted")).toHaveLength(0);
    expect(lines.filter((l) => l.type === "intake-gave-up")).toEqual([expect.objectContaining({ reason: "failures" })]);
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
    expect(r.deps.stderr.join("")).toContain("起動できない");
    const stderrLines = r.deps.stderr.join("").replaceAll("\r", "\n").split("\n");
    const notices = [...stderrLines.filter((l) => !/マップの更新 \d+ 回$/.test(l)), failureText(result)];
    // 入れ終えた最後の発言の end までの位置が出る（溜まりは捨てるので、r2 まで入れたかは実行の順による）
    const ids = remarksOf(lines).map((x) => x.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids).toEqual(["r1", "r2"].slice(0, ids.length));
    expect(notices.some((l) => l.includes(formatRecordedPosition(ids.length === 2 ? 660 : 600, 3484)))).toBe(true);
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

// ヘルパーだけが落ちたときの起動し直し（Issue #1093）。ライブと同じ判断（60 秒・3 回）で、サーバーが最後に作った発言の end から読み直す。
// 偽のヘルパーは、起動の回ごとの台本（attempts）に従って流す。偽の読み直しは頭から全部を流すので、
// 開始位置（--from）より前の結果をサーバーが捨てることを、発言が重ならず抜けもないことで確かめる
describe("cli recorded <file> ヘルパーが落ちたとき", () => {
  const flagOf = (flag: string) => (args: string[]) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const fromOf = flagOf("--from");
  const selfFromOf = flagOf("--self-from");
  const stderrLines = (r: { deps: { stderr: string[] } }) => r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((l) => l.trim() !== "");
  const waitForLaunches = (r: { helpers: { calls: string[][] } }, count: number) =>
    Effect.promise(() => vi.waitFor(() => { expect(r.helpers.calls.length).toBeGreaterThanOrEqual(count); }, { timeout: 10_000 }));
  // 発言が重ならず（start は前の発言の end 以降）、同じ発言が 2 回入らない
  const expectNoOverlap = (remarks: { start: number; end: number; text: string }[]) => {
    for (const [i, remark] of remarks.entries()) if (i > 0) expect(remark.start).toBeGreaterThanOrEqual(remarks[i - 1]!.end);
    expect(new Set(remarks.map((x) => x.text)).size).toBe(remarks.length);
  };
  const spoken = (track: "相手" | "自分", r: Remark): unknown[] => [
    { type: "partial", track, ...r, duplicate: false },
    { type: "remark", track, ...r, duplicate: false },
  ];

  it.live.each([
    { name: "終了コード 1", exit: { code: 1, signal: null } },
  ])("ヘルパーが $name で落ちると、最後に作った発言の end（660）から読み直す。--audio-dir は渡さない。発言は重ならず抜けもなく、番号も続く。CLI は成功する", ({ exit }) => Effect.gen(function* () {
    const r = yield* resource(THREE, fakeUpdater(), { attempts: [{ duration: 3484, remarks: THREE.remarks.slice(0, 2), exit }] });
    yield* r.cli(["recorded", r.file]);

    const dir = onlySession(r.sessionsDir);
    expect(r.helpers.calls).toHaveLength(2);
    expect(r.helpers.calls[0]).toEqual(["transcribe-file", "--file", resolve(r.file), "--audio-dir", dir]);
    expect(r.helpers.calls[1]).toEqual(expect.arrayContaining(["transcribe-file", "--file", resolve(r.file), "--from", "660"]));
    expect(r.helpers.calls[1]).not.toContain("--audio-dir");
    expect(fromOf(r.helpers.calls[1]!)).toBe("660");

    const lines = logLines(dir);
    const remarks = remarksOf(lines);
    expect(remarks.map((x) => ({ id: x.id, start: x.start, end: x.end, text: x.text }))).toEqual([
      { id: "r1", start: 590, end: 600, text: "最初の発言です" },
      { id: "r2", start: 600, end: 660, text: "次の発言です" },
      { id: "r3", start: 700, end: 750, text: "三つ目の発言です" },
    ]);
    expectNoOverlap(remarks);
    expect(r.updater.inputs.map((input) => input.fresh.map((remark) => remark.id))).toEqual([["r1"], ["r2"], ["r3"]]);
    expect(lines.filter((l) => l.type === "intake-stopped")).toEqual([expect.objectContaining({ code: exit.code, signal: exit.signal })]);
    expect(lines.filter((l) => l.type === "intake-restarted")).toHaveLength(1);
    expect(lines.some((l) => l.type === "intake-gave-up")).toBe(false);
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
    expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
  }).pipe(Effect.scoped));

  it.live("作った発言がまだ無いうちに落ちたら、--from は渡さず頭から読み直す。何も捨てない", () => Effect.gen(function* () {
    const r = yield* resource(THREE, fakeUpdater(), { attempts: [{ duration: 3484, remarks: [], exit: { code: 1, signal: null } }] });
    yield* r.cli(["recorded", r.file]);

    expect(r.helpers.calls).toHaveLength(2);
    expect(r.helpers.calls[1]).not.toContain("--from");
    expect(r.helpers.calls[1]).not.toContain("--audio-dir");
    expect(remarksOf(logLines(onlySession(r.sessionsDir))).map((x) => x.id)).toEqual(["r1", "r2", "r3"]);
  }).pipe(Effect.scoped));

  it.live("溜まりに止まっていてセッションにまだ入れていない発言も、作った発言に含める。差分更新が終わらない間に 3 発言を作って落ちると、750 から読み直し、あとで溜まりが流れても 3 発言が 1 回ずつ", () => Effect.gen(function* () {
    const gate = Effect.runSync(Deferred.make<void>());
    const updater = fakeUpdater((_input, call) => call === 1 ? Deferred.await(gate) : Effect.void);
    const r = yield* resource(THREE, updater, { attempts: [{ ...THREE, exit: { code: 1, signal: null } }] });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForLaunches(r, 2);

    expect(fromOf(r.helpers.calls[1]!)).toBe("750");
    yield* Deferred.succeed(gate, undefined);
    yield* within(Fiber.join(running));

    const remarks = remarksOf(logLines(onlySession(r.sessionsDir)));
    expect(remarks.map((x) => ({ id: x.id, end: x.end, text: x.text }))).toEqual([
      { id: "r1", end: 600, text: "最初の発言です" },
      { id: "r2", end: 660, text: "次の発言です" },
      { id: "r3", end: 750, text: "三つ目の発言です" },
    ]);
    expectNoOverlap(remarks);
  }).pipe(Effect.scoped));

  it.live("確定していない途中結果も、起動し直す前に発言にしてから開始位置を決める。落ちる直前の途中結果（760〜770）の end 770 から読み直し、その発言は 1 件だけ", () => Effect.gen(function* () {
    const unsettled = { start: 760, end: 770, text: "確定していない発言です" };
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        { duration: 3484, remarks: [], events: [...remarkEvents(THREE.remarks[0]!), { type: "partial", track: "相手", ...unsettled }], exit: { code: 1, signal: null } },
        // 頭から読み直した結果: 最初の発言と、落ちる前の途中結果の確定結果、その後の発言
        { duration: 3484, remarks: [], events: [...remarkEvents(THREE.remarks[0]!), ...remarkEvents(unsettled), ...remarkEvents({ start: 800, end: 810, text: "続きの発言です" })] },
      ],
    });
    yield* r.cli(["recorded", r.file]);

    expect(fromOf(r.helpers.calls[1]!)).toBe("770");
    const remarks = remarksOf(logLines(onlySession(r.sessionsDir)));
    expect(remarks.map((x) => [x.id, x.text])).toEqual([["r1", "最初の発言です"], ["r2", "確定していない発言です"], ["r3", "続きの発言です"]]);
    expectNoOverlap(remarks);
  }).pipe(Effect.scoped));

  it.live("--self の 2 トラックでは、トラックごとに最後に作った発言の end（相手 10・自分 6）から読み直す（--from と --self-from）。--self-file も渡し、--audio-dir は渡さない", () => Effect.gen(function* () {
    const mine = { start: 5, end: 6, text: "自分の発言です" };
    const theirs = { start: 8, end: 10, text: "相手の発言です" };
    const next = { start: 12, end: 14, text: "続きの発言です" };
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        { duration: 20, remarks: [], events: [...spoken("相手", theirs), ...spoken("自分", mine)], exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [...spoken("相手", theirs), ...spoken("自分", mine), ...spoken("相手", next)] },
      ],
    });
    yield* r.cli(["recorded", r.file, "--self", r.selfFile]);

    expect(r.helpers.calls).toHaveLength(2);
    expect(fromOf(r.helpers.calls[1]!)).toBe("10");
    expect(selfFromOf(r.helpers.calls[1]!)).toBe("6");
    expect(r.helpers.calls[1]).toEqual(expect.arrayContaining(["--self-file", resolve(r.selfFile)]));
    expect(r.helpers.calls[1]).not.toContain("--audio-dir");
    const remarks = remarksOf(logLines(onlySession(r.sessionsDir)));
    expect(remarks.map((x) => [x.track, x.end, x.text])).toEqual([
      ["自分", 6, "自分の発言です"], ["相手", 10, "相手の発言です"], ["相手", 14, "続きの発言です"],
    ]);
  }).pipe(Effect.scoped));

  it.live("--self で、自分 の確定結果が届く前に、相手 のより後ろの発言を作って落ちても、自分 の発言は抜けない（--self-from は渡さず、自分 は頭から読み直す）。発言は end の順に 1 回ずつ", () => Effect.gen(function* () {
    const mine = { start: 5, end: 6, text: "自分の発言です" };
    const theirs = { start: 8, end: 10, text: "相手の発言です" };
    const next = { start: 12, end: 14, text: "続きの発言です" };
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        { duration: 20, remarks: [], events: spoken("相手", theirs), exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [...spoken("相手", theirs), ...spoken("自分", mine), ...spoken("相手", next)] },
      ],
    });
    yield* r.cli(["recorded", r.file, "--self", r.selfFile]);

    expect(r.helpers.calls).toHaveLength(2);
    expect(fromOf(r.helpers.calls[1]!)).toBe("10");
    expect(r.helpers.calls[1]).toContain("--self-file");
    expect(r.helpers.calls[1]).not.toContain("--self-from");
    expect(r.helpers.calls[1]).not.toContain("--audio-dir");
    const remarks = remarksOf(logLines(onlySession(r.sessionsDir)));
    expect(remarks.map((x) => [x.id, x.track, x.end, x.text])).toEqual([
      ["r1", "自分", 6, "自分の発言です"], ["r2", "相手", 10, "相手の発言です"], ["r3", "相手", 14, "続きの発言です"],
    ]);
  }).pipe(Effect.scoped));

  it.live("--self で両トラックの発言を作っていれば、トラックごとの end から読み直し、各トラックで開始位置より前の流し直しは捨てる。発言の番号は r1 から続く", () => Effect.gen(function* () {
    const mineFirst = { start: 1, end: 2, text: "自分の最初の発言です" };
    const theirs = { start: 8, end: 10, text: "相手の発言です" };
    const mineNext = { start: 5, end: 6, text: "自分の続きの発言です" };
    const theirsNext = { start: 12, end: 14, text: "相手の続きの発言です" };
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        { duration: 20, remarks: [], events: [...spoken("自分", mineFirst), ...spoken("相手", theirs)], exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [...spoken("自分", mineFirst), ...spoken("相手", theirs), ...spoken("自分", mineNext), ...spoken("相手", theirsNext)] },
      ],
    });
    yield* r.cli(["recorded", r.file, "--self", r.selfFile]);

    expect(fromOf(r.helpers.calls[1]!)).toBe("10");
    expect(selfFromOf(r.helpers.calls[1]!)).toBe("2");
    const remarks = remarksOf(logLines(onlySession(r.sessionsDir)));
    expect(remarks.map((x) => [x.id, x.track, x.end])).toEqual([["r1", "自分", 2], ["r2", "自分", 6], ["r3", "相手", 10], ["r4", "相手", 14]]);
  }).pipe(Effect.scoped));

  it.live("--self で起動し直しても、共有画面は重ならず消えない。落ちる前に入れた画面（5）は 1 回、読み直した回が流し直した画面（11）も 1 回で、発言との時刻の順を保つ", () => Effect.gen(function* () {
    const mine = { start: 1, end: 2, text: "自分の発言です" };
    const theirs = { start: 8, end: 10, text: "相手の発言です" };
    const next = { start: 12, end: 14, text: "続きの発言です" };
    const screen = (start: number) => ({ type: "screen", start, image: SCREEN_IMAGE, lines: ["画面の文字"] });
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        { duration: 20, remarks: [], events: [...spoken("自分", mine), screen(5), ...spoken("相手", theirs), screen(11)], exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [screen(11), ...spoken("相手", next)] },
      ],
    });
    yield* r.cli(["recorded", r.file, "--self", r.selfFile]);

    const timeline = sessionLog(r.sessionsDir).filter((l) => l.type === "remark" || l.type === "screen").map((l) => l.type === "screen" ? `screen@${String(l.start)}` : `remark:${(l.remark as { text: string }).text}`);
    expect(timeline).toEqual(["remark:自分の発言です", "screen@5", "remark:相手の発言です", "screen@11", "remark:続きの発言です"]);
  }).pipe(Effect.scoped));

  it.live("落ちる前に先読みしていた、開始位置より後の共有画面は入れない。読み直した回が流し直した画面が 1 回だけ、続きの発言の前に入る", () => Effect.gen(function* () {
    const first = { start: 0, end: 2, text: "最初の発言です" };
    const second = { start: 12, end: 14, text: "続きの発言です" };
    const screen = { type: "screen", start: 11, image: SCREEN_IMAGE, lines: ["画面の文字"] };
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        { duration: 20, remarks: [], events: [screen, ...remarkEvents(first)], exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [screen, ...remarkEvents(second)] },
      ],
    });
    yield* r.cli(["recorded", r.file]);

    expect(fromOf(r.helpers.calls[1]!)).toBe("2");
    const timeline = sessionLog(r.sessionsDir).filter((l) => l.type === "remark" || l.type === "screen").map((l) => l.type === "screen" ? `screen@${String(l.start)}` : `remark:${(l.remark as { text: string }).text}`);
    expect(timeline).toEqual(["remark:最初の発言です", "screen@11", "remark:続きの発言です"]);
  }).pipe(Effect.scoped));

  it.live("まだ発言に覆われていない screen-off も、起動し直しで失われない。流し直されても、ログには 1 回だけ入る", () => Effect.gen(function* () {
    const first = { start: 0, end: 2, text: "最初の発言です" };
    const second = { start: 12, end: 14, text: "続きの発言です" };
    const off = { type: "screen-off", start: 11, reason: "許可なし" };
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        { duration: 20, remarks: [], events: [off, ...remarkEvents(first)], exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [off, ...remarkEvents(second)] },
      ],
    });
    yield* r.cli(["recorded", r.file]);

    const timeline = sessionLog(r.sessionsDir).filter((l) => l.type === "remark" || l.type === "screen-off").map((l) => l.type === "screen-off" ? `screen-off@${String(l.start)}` : `remark:${(l.remark as { text: string }).text}`);
    expect(timeline).toEqual(["remark:最初の発言です", "screen-off@11", "remark:続きの発言です"]);
  }).pipe(Effect.scoped));

  it.live("起動し直したヘルパーが流し直す知らせ（音声のトラックが複数・映像が読めない）は、標準エラーに 1 回だけ出る", () => Effect.gen(function* () {
    const first = { start: 0, end: 2, text: "最初の発言です" };
    const second = { start: 10, end: 12, text: "次の発言です" };
    const r = yield* resource(THREE, fakeUpdater(), {
      fileName: "meeting.mp4",
      attempts: [
        { duration: 20, audioTracks: 2, remarks: [], events: [{ type: "screen-off", start: 0, reason: "許可なし" }, ...remarkEvents(first)], exit: { code: 1, signal: null } },
        { duration: 20, audioTracks: 2, remarks: [], events: [{ type: "screen-off", start: 0, reason: "許可なし" }, ...remarkEvents(first), ...remarkEvents(second)] },
      ],
    });
    yield* r.cli(["recorded", r.file]);

    expect(r.helpers.calls).toHaveLength(2);
    expect(stderrLines(r).filter((l) => l === formatAudioTracksNotice(2))).toHaveLength(1);
    expect(stderrLines(r).filter((l) => l === formatScreenOffNotice())).toHaveLength(1);
    expect(remarkTexts(logLines(onlySession(r.sessionsDir)))).toEqual(["最初の発言です", "次の発言です"]);
  }).pipe(Effect.scoped));

  it.live("起動し直したヘルパーの接続を待っている間の stop は、すぐ戻り、それ以上は起動しない。入れた分で map.* を書く", () => Effect.gen(function* () {
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [{ duration: 3484, remarks: THREE.remarks.slice(0, 2), exit: { code: 1, signal: null } }, { remarks: [], blockLaunch: true }],
    });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForLaunches(r, 2);
    yield* within(r.cli(["stop"]));
    const result = yield* Effect.result(within(Fiber.join(running)));

    expect(Result.isSuccess(result)).toBe(true);
    expect(r.helpers.calls).toHaveLength(2);
    const dir = onlySession(r.sessionsDir);
    expect(remarksOf(logLines(dir)).map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(existsSync(join(dir, "map.md"))).toBe(true);
  }).pipe(Effect.scoped));

  it.live("最初の起動に失敗したら、起動し直さずに開始の失敗として返す", () => Effect.gen(function* () {
    const r = yield* resource({ ...THREE, failLaunch: true });
    const result = yield* Effect.result(within(r.cli(["recorded", r.file])));

    expect(Result.isFailure(result)).toBe(true);
    expect(r.helpers.calls).toHaveLength(1);
  }).pipe(Effect.scoped));

  it.live("サーバーとの接続が切れたら続けない。CLI は、途中までのセッションのフォルダと、もう一度 cli recorded を呼べば頭から組み直せることを出し、失敗で返る", () => Effect.gen(function* () {
    // 最初の発言を入れた差分更新が終わらないまま、サーバーが落ちる
    const r = yield* resource({ ...THREE, hold: true }, fakeUpdater(() => Effect.never));
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForRemarks(r.sessionsDir, 1);
    const dir = onlySession(r.sessionsDir);

    yield* r.server.close;
    const result = yield* Effect.result(within(Fiber.join(running)));

    expect(Result.isFailure(result)).toBe(true);
    expect(failureText(result)).toContain(dir);
    expect(failureText(result)).toContain("cli recorded");
  }).pipe(Effect.scoped));
});

// --realtime: 発言を音声の end、共有画面の変化を start の時刻まで待ってから入れる（play --realtime と同じ意味）。
// 実時間では待たず、サーバーと CLI の両方に TestClock を包んだ Clock を渡して、仮想時計を少しずつ進める
describe("cli recorded <file> --realtime", () => {
  // 本物のヘルパーが録画で流すのは相手のトラックだけ。相手の発言は話者を決める段で最大 3 秒の音声の時刻まで保留されるので、
  // 共有画面の変化の方が先に届く。それでも発言は end、変化は start の時刻に、時刻の順で入る
  const MIXED: Script = {
    duration: 20,
    remarks: [],
    events: [
      ...remarkEvents({ start: 0, end: 2, text: "最初の発言です" }),
      { type: "screen", start: 6, image: SCREEN_IMAGE, lines: ["画面の文字"] },
      { type: "screen-off", start: 8, reason: "許可なし" },
      ...remarkEvents({ start: 10, end: 12, text: "次の発言です" }),
    ],
  };

  const isRemark = (id: string) => (l: Line) => l.type === "remark" && (l.remark as { id: string }).id === id;

  it.effect("起動し直しを諦めると、時刻を待っている溜まりの発言は入れない。仮想時計を進めなくても CLI は失敗で返り、入る発言は r1 だけ。map.* は書く", () => withVirtualClock((pending) => Effect.gen(function* () {
    // 1 回目: r1（0-2）と r2（10-12）を流して落ちる。2 回目: 何も流さず、テストが落とすまで居続ける。3 回目: すぐ落ちる
    const r = yield* resource(
      { remarks: [], hold: true },
      fakeUpdater(),
      { attempts: [
        { duration: 20, remarks: [], events: [...remarkEvents({ start: 0, end: 2, text: "最初の発言です" }), ...remarkEvents({ start: 10, end: 12, text: "次の発言です" })], exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], hold: true },
        { duration: 20, remarks: [], exit: { code: 1, signal: null } },
      ] },
    );
    let finished = false;
    const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.ensuring(Effect.sync(() => { finished = true; })), Effect.forkChild);

    yield* advanceTo(pending, 2000, () => has(r.sessionsDir, isRemark("r1")));
    // r2 は、仮想時刻 12000 ms を待つ溜まりに入っている。時計を進めない限り、入れる側からは解けない
    yield* eventually(() => pending.includes(12000), "r2 が仮想時刻 12000 ms の待ちに入る");
    yield* eventually(() => r.helpers.calls.length === 2, "2 回目のヘルパーが起動する");
    yield* r.helpers.crash;

    // 仮想時計は 2000 ms のまま。諦めた CLI が溜まりを入れ切ろうとして 12000 ms を待つなら、ここで終わらない
    yield* eventually(() => finished, "仮想時計を進めなくても CLI が終わる");
    const result = yield* Effect.result(Fiber.join(running));

    expect(Result.isFailure(result)).toBe(true);
    expect(yield* virtualNow).toBe(2000);
    expect(r.helpers.calls).toHaveLength(3);
    const dir = onlySession(r.sessionsDir);
    expect(logLines(dir).filter((l) => l.type === "intake-gave-up")).toHaveLength(1);
    expect(remarksOf(logLines(dir)).map((x) => x.id)).toEqual(["r1"]);
    expect(existsSync(join(dir, "map.md"))).toBe(true);
  })).pipe(Effect.scoped), 30_000);

  it.effect("発言は end、画面の変化は start の仮想時刻ちょうどに入り、差分更新の終わりは待たない", () => withVirtualClock((pending) => Effect.gen(function* () {
    // 1 回目の差分更新は、最後まで終わらない（等速は、呼び出しの終わりを待たずに次を入れる）
    const gate = yield* Deferred.make<void>();
    const r = yield* resource(MIXED, fakeUpdater((_input, call) => call === 1 ? Deferred.await(gate) : Effect.void));
    const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.forkChild);

    yield* advanceTo(pending, 2000, () => has(r.sessionsDir, isRemark("r1")));
    // r1 の後でも、変化の start（6 秒）の手前では screen の行は無い
    expect(has(r.sessionsDir, (l) => l.type === "screen")).toBe(false);
    yield* advanceTo(pending, 6000, () => has(r.sessionsDir, (l) => l.type === "screen" && l.start === 6));
    // 変化は発言の待ちに足されるのではなく、同じ時計に乗る
    expect(has(r.sessionsDir, (l) => l.type === "screen-off")).toBe(false);
    yield* advanceTo(pending, 8000, () => has(r.sessionsDir, (l) => l.type === "screen-off" && l.start === 8));
    expect(has(r.sessionsDir, isRemark("r2"))).toBe(false);
    yield* advanceTo(pending, 12000, () => has(r.sessionsDir, isRemark("r2")));
    // 1 回目の差分更新は終わっていないまま、r2 まで入った
    expect(r.updater.inputs).toHaveLength(1);

    yield* Deferred.succeed(gate, undefined);
    yield* runToEnd(Fiber.join(running));
    const lines = sessionLog(r.sessionsDir);
    expect(lines.filter((l) => l.type === "remark" || l.type === "screen" || l.type === "screen-off").map((l) => l.type)).toEqual(["remark", "screen", "screen-off", "remark"]);
    expect(lines.find((l) => l.type === "screen")).toMatchObject({ start: 6, lines: ["画面の文字"] });
    expect(lines.find((l) => l.type === "screen-off")).toMatchObject({ start: 8, reason: "許可なし" });
    expect(remarksOf(lines).map((x) => ({ id: x.id, end: x.end }))).toEqual([{ id: "r1", end: 2 }, { id: "r2", end: 12 }]);
  })).pipe(Effect.scoped), 30_000);

  it.effect("すでに過ぎた時刻の発言は待たずに入れ、時計を戻さない。次の発言は、時計の現在からの差だけ待つ", () => withVirtualClock((pending) => Effect.gen(function* () {
    const r = yield* resource({
      remarks: [],
      events: [
        ...remarkEvents({ start: 4, end: 5, text: "五秒の発言です" }, "自分"),
        ...remarkEvents({ start: 1, end: 3, text: "過ぎた時刻の発言です" }, "自分"),
        ...remarkEvents({ start: 6, end: 7, text: "七秒の発言です" }, "自分"),
      ],
    });
    const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.forkChild);

    yield* advanceTo(pending, 5000, () => has(r.sessionsDir, isRemark("r1")));
    // 3 秒は時計の 5 秒より前なので、時計を進めずに続けて入る
    yield* eventually(() => has(r.sessionsDir, isRemark("r2")), "過ぎた時刻の発言は、時計を進めなくても入る");
    expect(yield* virtualNow).toBe(5000);
    // 時計は戻らない: 次の待ちは 5 秒から 7 秒までの 2 秒（3 秒に戻っていれば 9000 に終わる）
    yield* advanceTo(pending, 7000, () => has(r.sessionsDir, isRemark("r3")));
    yield* runToEnd(Fiber.join(running));
    expect(remarksOf(sessionLog(r.sessionsDir)).map((x) => x.text)).toEqual(["五秒の発言です", "過ぎた時刻の発言です", "七秒の発言です"]);
  })).pipe(Effect.scoped), 30_000);

  it.effect("最後の発言より後の画面の変化も、自然な終わりで取りこぼさず、その start の仮想時刻に入る", () => withVirtualClock((pending) => Effect.gen(function* () {
    const r = yield* resource({
      remarks: [],
      events: [
        ...remarkEvents({ start: 0, end: 2, text: "最初の発言です" }),
        { type: "screen", start: 20, image: SCREEN_IMAGE, lines: ["画面の文字"] },
      ],
    });
    const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.forkChild);
    yield* advanceTo(pending, 2000, () => has(r.sessionsDir, isRemark("r1")));
    yield* advanceTo(pending, 20000, () => has(r.sessionsDir, (l) => l.type === "screen" && l.start === 20));
    yield* runToEnd(Fiber.join(running));
    expect(sessionLog(r.sessionsDir).filter((l) => l.type === "remark" || l.type === "screen").map((l) => l.type)).toEqual(["remark", "screen"]);
  })).pipe(Effect.scoped), 30_000);

  // 行の at は書いた壁時計の時刻なので比べない（発言の中身だけを比べる）
  const withoutWallClock = ({ at: _at, ...rest }: Line) => rest;

  it.effect("同じファイルなら、待ち時間なしと --realtime で、発言の行（id・track・speaker・start・end・text・raw）と共有画面の行が、同じ順の同じ列になる。確定結果の無い途中結果も同じに締まる", () => withVirtualClock(() => Effect.gen(function* () {
    // 確定結果の無い途中結果（0〜2 秒）は、後ろの結果の音声の時刻が 1 秒以上進んだところで締まる
    const script: Script = {
      duration: 40,
      remarks: [],
      events: [
        { type: "partial", track: "相手", start: 0, end: 2, text: "確定結果のない発言です" },
        { type: "screen", start: 6, image: SCREEN_IMAGE, lines: ["画面の文字"] },
        { type: "screen-off", start: 8, reason: "許可なし" },
        ...remarkEvents({ start: 10, end: 12, text: "確定した発言です" }),
        { type: "screen", start: 15, image: SCREEN_IMAGE, lines: ["別の画面の文字"] },
        ...remarkEvents({ start: 20, end: 22, text: "自分の発言です" }, "自分"),
        ...remarkEvents({ start: 30, end: 32, text: "最後の発言です" }),
      ],
    };
    const immediate = yield* resource(script);
    yield* immediate.cli(["recorded", immediate.file]);
    const timeline = (dir: string) => sessionLog(dir).filter((l) => l.type === "remark" || l.type === "screen" || l.type === "screen-off").map(withoutWallClock);
    const immediateRemarks = timeline(immediate.sessionsDir);
    // 発言（話者を含む）と共有画面の変化が、音声の時刻の順に並ぶ
    expect(immediateRemarks.map((l) => l.type)).toEqual(["remark", "screen", "screen-off", "remark", "screen", "remark", "remark"]);

    expect(immediateRemarks.filter((l) => l.type === "remark").map((l) => (l.remark as { text: string }).text)).toEqual(expect.arrayContaining(["確定結果のない発言です", "確定した発言です", "自分の発言です", "最後の発言です"]));

    const realtime = yield* resource(script);
    yield* runToEnd(realtime.cli(["recorded", realtime.file, "--realtime"]));
    const realtimeRemarks = timeline(realtime.sessionsDir);

    expect(realtimeRemarks).toEqual(immediateRemarks);
  })).pipe(Effect.scoped), 30_000);

  // 補正に使う語彙は、発言を締めた時点で確定する。等速でも、入れる時刻を待つ間に届いた語彙で直し直さない
  // 読みの取得を止めたまま r1 を締め、読みが返ってから r2 を締める。screenLines があれば、読みを止めている間に共有画面の変化（6 秒）も届ける
  const vocabularyRun = (realtime: boolean, pending: number[], source: "user" | "screen") => Effect.gen(function* () {
    // 前の実行が仮想時計を進めているので、この実行の起点を覚えておく
    const base = yield* virtualNow;
    const readings = fakeReadings({ 港南店: "kounanten" });
    readings.gate.current = yield* Deferred.make<void>();
    const r = yield* resource({ remarks: [], hold: true }, fakeUpdater(), { readings });
    const vocabFile = join(r.root, "vocab.txt");
    writeFileSync(vocabFile, "港南店\n");
    const argv = ["recorded", r.file, ...(source === "user" ? ["--vocab", vocabFile] : []), ...(realtime ? ["--realtime"] : [])];
    const running = yield* r.cli(argv).pipe(Effect.forkChild);
    yield* eventually(() => r.helpers.calls.length === 1, "ヘルパーが起動する");
    if (source === "screen") {
      r.helpers.feed({ type: "screen", start: 6, image: SCREEN_IMAGE, lines: ["港南店"] });
      r.helpers.feed({ type: "screen-off", start: 8, reason: "許可なし" });
    }
    // 読みの取得は始まっているが、返っていない
    yield* eventually(() => readings.calls.length === 1, "読みの取得が始まる");
    // r1（0〜2 秒）は、後ろの結果（10〜12 秒）の音声の時刻が進んで、読みが返る前に締まる
    for (const event of [garbledPartial(0, 2), garbledRemark(0, 2), garbledPartial(10, 12)]) r.helpers.feed(event);
    if (realtime) yield* eventually(() => pending.includes(base + 2000), "r1 は締まって、2 秒の待ちに入る");
    else yield* eventually(() => has(r.sessionsDir, isRemark("r1")), "r1 は締まって入る");
    // 読みが返る。画面の語彙も含め、vocab の行は等速の待ち（仮想時計）を進めずにできる
    yield* Deferred.succeed(readings.gate.current, undefined);
    yield* eventually(() => vocabLines(sessionLog(r.sessionsDir)).length === 1, "読みが返って vocab の行ができる");
    if (realtime) expect(yield* virtualNow).toBe(base);
    r.helpers.feed(garbledRemark(10, 12));
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));
    return sessionLog(r.sessionsDir);
  });

  it.effect.each<{ source: "user" | "screen" }>([{ source: "screen" }])(
    "補正に使う語彙は発言を締めた時点で確定し、待ち時間なしと --realtime で、発言の行（text・raw・words）が同じになる（語彙の出どころ: $source）",
    ({ source }) => withVirtualClock((pending) => Effect.gen(function* () {
      const immediate = yield* vocabularyRun(false, pending, source);
      const realtime = yield* vocabularyRun(true, pending, source);
      const remarks = (lines: Line[]) => lines.filter((l) => l.type === "remark").map(withoutWallClock);
      // 読みが返る前に締めた r1 は直らず（raw と同じ）、返った後に締めた r2 は直る。raw には直す前の本文、words には直す前の位置が残る
      expect(remarkTexts(immediate)).toEqual(["江南店に行きます", "港南店に行きます"]);
      expect(remarks(immediate).map((l) => l.raw)).toEqual(["江南店に行きます", "江南店に行きます"]);
      expect(remarks(immediate).map((l) => l.words)).toEqual([garbledWords, garbledWords]);
      expect(remarks(realtime)).toEqual(remarks(immediate));
      expect(vocabLines(realtime).map((l) => l.words)).toEqual(vocabLines(immediate).map((l) => l.words));
    })).pipe(Effect.scoped), 60_000);

  type Halt = (r: { cli: (argv: string[]) => Effect.Effect<void, unknown, never> }, running: Fiber.Fiber<unknown, unknown>) => Effect.Effect<unknown, unknown>;
  it.effect.each<{ name: string; halt: Halt }>([
    { name: "stop", halt: (r) => r.cli(["stop"]) },
  ])("次の発言の時刻を待っている間の $name は、仮想時計を進めなくてもすぐ戻り、入れた分で map.* を書く。待っていた発言は入れない", ({ halt }) =>
    withVirtualClock((pending) => Effect.gen(function* () {
      const r = yield* resource({
        remarks: [],
        hold: true,
        events: [
          ...remarkEvents({ start: 0, end: 2, text: "最初の発言です" }, "自分"),
          ...remarkEvents({ start: 10, end: 12, text: "次の発言です" }, "自分"),
        ],
      });
      const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.forkChild);
      yield* advanceTo(pending, 2000, () => has(r.sessionsDir, isRemark("r1")));
      // 次の発言（12 秒）の待ちに入っている
      yield* eventually(() => pending.includes(12000), "仮想時刻 12000 ms に終わる sleep が登録される");

      let halted = false;
      yield* halt(r, running).pipe(Effect.ensuring(Effect.sync(() => { halted = true; })), Effect.forkChild);
      yield* eventually(() => halted, "仮想時計を進めなくても、停止の要求が戻る");
      let ended = false;
      yield* Fiber.await(running).pipe(Effect.ensuring(Effect.sync(() => { ended = true; })), Effect.forkChild);
      yield* eventually(() => ended, "仮想時計を進めなくても、recorded の CLI が戻る");

      expect(yield* virtualNow).toBe(2000);
      const dir = onlySession(r.sessionsDir);
      expect(remarksOf(logLines(dir)).map((x) => x.id)).toEqual(["r1"]);
      for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
    })).pipe(Effect.scoped), 30_000);

  // 差分更新の応答を待つ間に音声の時刻が来る発言が 3 件以上あっても、セッションに入って処理を待つ発言は 1 回分（2 件）まで。
  // 相手の最後の発言は drain まで保留されるので、r4 を置いて r3 を締める
  const FOUR: Script = {
    remarks: [],
    hold: true,
    events: [
      ...remarkEvents({ start: 0, end: 2, text: "一つ目の発言です" }),
      ...remarkEvents({ start: 10, end: 12, text: "二つ目の発言です" }),
      ...remarkEvents({ start: 20, end: 22, text: "三つ目の発言です" }),
      ...remarkEvents({ start: 30, end: 32, text: "四つ目の発言です" }),
    ],
  };
  // r1 と r2 が入った状態（1 回目の差分更新は未完了）にして、r3（22 秒）の時刻を過ぎるまで仮想時計を進める
  const reachThirdRemark = (r: { sessionsDir: string; updater: { inputs: unknown[] } }, pending: number[]) => Effect.gen(function* () {
    yield* advanceTo(pending, 2000, () => has(r.sessionsDir, isRemark("r1")));
    yield* advanceTo(pending, 12000, () => has(r.sessionsDir, isRemark("r2")));
    yield* eventually(() => pending.includes(22000), "r3 の音声の時刻の待ちに入る");
    yield* TestClock.adjust(18_000);
    yield* realDelay(300);
  });
  const realDelay = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  it.effect("差分更新の応答を待つ間は、処理を待つ発言が 2 件になった時点で次の発言を入れず、応答が終わると残りが順に 1 回ずつ入る", () => withVirtualClock((pending) => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const r = yield* resource(FOUR, fakeUpdater((_input, call) => call === 1 ? Deferred.await(gate) : Effect.void));
    const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.forkChild);

    yield* reachThirdRemark(r, pending);
    // 30 秒の時点でも r3 は入らない
    expect(remarksOf(sessionLog(r.sessionsDir)).map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(r.updater.inputs).toHaveLength(1);

    yield* Deferred.succeed(gate, undefined);
    yield* eventually(() => has(r.sessionsDir, isRemark("r3")), "応答が終わると r3 が入る");
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));
    expect(remarksOf(sessionLog(r.sessionsDir)).map((x) => x.id)).toEqual(["r1", "r2", "r3", "r4"]);
    const fed = r.updater.inputs.flatMap((input) => input.fresh.map((remark) => remark.id));
    expect([...fed].sort()).toEqual(["r1", "r2", "r3", "r4"]);
    expect(r.updater.state.overlaps).toBe(0);
  })).pipe(Effect.scoped), 30_000);

  it.effect("処理を待つ発言の数が上限で待っている間の Ctrl-C は、仮想時計を進めなくてもすぐ戻り、待っていた発言は入れず、入れた分で map.* を書く", () => withVirtualClock((pending) => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const r = yield* resource(FOUR, fakeUpdater((_input, call) => call === 1 ? Deferred.await(gate) : Effect.void));
    const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.forkChild);

    yield* reachThirdRemark(r, pending);
    expect(remarksOf(sessionLog(r.sessionsDir)).map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(r.updater.inputs).toHaveLength(1);
    const beforeStop = yield* virtualNow;
    yield* Fiber.interrupt(running).pipe(Effect.forkChild);
    let ended = false;
    yield* Fiber.await(running).pipe(Effect.ensuring(Effect.sync(() => { ended = true; })), Effect.forkChild);
    // backlog の破棄より先に更新を解放すると、停止要求が届く前に r3 が入る。
    yield* Effect.gen(function* () {
      const deadline = Date.now() + 5000;
      while (!Deferred.isDoneUnsafe(r.helpers.stopSeen)) {
        if (Date.now() >= deadline) throw new Error("backlog 破棄後の helper 停止通知が届かない");
        yield* realDelay(5);
      }
    }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)));
    yield* eventually(() => ended, "recorded の CLI が戻る");

    expect(yield* virtualNow).toBe(beforeStop);
    const dir = onlySession(r.sessionsDir);
    expect(remarksOf(logLines(dir)).map((x) => x.id)).toEqual(["r1", "r2"]);
    for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
  })).pipe(Effect.scoped), 30_000);

  it.effect("処理を待つ発言の数が上限で待っている間に差分更新が stopped になっても、待ちは解け、残りの発言が入って CLI が戻る", () => withVirtualClock((pending) => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const r = yield* resource(FOUR, fakeUpdater((_input, call) => call === 1
      ? Effect.andThen(Deferred.await(gate), Effect.fail({ _tag: "DiffUpdateStopped", message: "再起動の上限" } satisfies UpdateFailure))
      : Effect.void));
    const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.forkChild);

    yield* reachThirdRemark(r, pending);
    expect(remarksOf(sessionLog(r.sessionsDir)).map((x) => x.id)).toEqual(["r1", "r2"]);

    yield* Deferred.succeed(gate, undefined);
    yield* eventually(() => has(r.sessionsDir, isRemark("r3")), "stopped になると r3 が入る");
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));
    expect(remarksOf(sessionLog(r.sessionsDir)).map((x) => x.id)).toEqual(["r1", "r2", "r3", "r4"]);
  })).pipe(Effect.scoped), 30_000);
});

// 動画の映像を共有画面として使う（Issue #1090）。本物のヘルパーは、映像の判定と OCR を文字起こしと並べて先に済ませるので、
// 共有画面の変化と screen-off は、発言よりも先に届く。それでも発言と同じ音声の時刻の順でセッションに入り、語彙も映った後の発言から効く
describe("cli recorded <file> 動画の映像", () => {
  const stderrLines = (r: { deps: { stderr: string[] } }) => r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((l) => l.trim() !== "");

  it.live("画面の変化が発言より先に届いても、音声の時刻の順（画面は start、発言は end）でログに入り、差分更新には、その呼び出しの発言までに映り始めた画面が添えられる", () => Effect.gen(function* () {
    const r = yield* resource({
      duration: 20,
      remarks: [],
      events: [
        { type: "screen", start: 1, image: SCREEN_IMAGE, lines: ["最初の画面"] },
        { type: "screen", start: 11, image: SCREEN_IMAGE, lines: ["次の画面"] },
        ...remarkEvents({ start: 0, end: 2, text: "最初の発言です" }),
        ...remarkEvents({ start: 10, end: 12, text: "次の発言です" }),
      ],
    });
    yield* r.cli(["recorded", r.file]);

    const lines = logLines(onlySession(r.sessionsDir));
    expect(lines.filter((l) => l.type === "remark" || l.type === "screen").map((l) => l.type === "screen" ? `screen@${String(l.start)}` : `remark:${(l.remark as { text: string }).text}`))
      .toEqual(["screen@1", "remark:最初の発言です", "screen@11", "remark:次の発言です"]);
    // 1 回目の差分更新（最初の発言、end 2 秒）には 1 秒の画面、2 回目（end 12 秒）には 11 秒の画面だけ（10 秒以上離れている）
    expect(r.updater.inputs.map((input) => input.fresh.map((remark) => remark.id))).toEqual([["r1"], ["r2"]]);
    expect(r.updater.inputs.map((input) => (input.screens ?? []).map((screen) => screen.start))).toEqual([[1], [11]]);
  }).pipe(Effect.scoped));

  it.live("映像が読めない（screen-off）ことは、標準エラーに知らせの 1 行がちょうど 1 回出る。発言は入る", () => Effect.gen(function* () {
    const r = yield* resource({
      duration: 20,
      remarks: [],
      events: [
        { type: "screen-off", start: 0, reason: "許可なし" },
        ...remarkEvents({ start: 0, end: 2, text: "最初の発言です" }),
        ...remarkEvents({ start: 10, end: 12, text: "次の発言です" }),
      ],
    });
    yield* r.cli(["recorded", r.file]);

    const notice = formatScreenOffNotice();
    expect(notice).toContain("映像");
    expect(stderrLines(r).filter((l) => l === notice)).toHaveLength(1);
    expect(remarkTexts(logLines(onlySession(r.sessionsDir)))).toEqual(["最初の発言です", "次の発言です"]);
  }).pipe(Effect.scoped));

  it.live("screen-off が無ければ、映像が読めないという知らせは出ない", () => Effect.gen(function* () {
    const r = yield* resource({
      duration: 20,
      remarks: [],
      events: [
        { type: "screen", start: 1, image: SCREEN_IMAGE, lines: ["画面の文字"] },
        ...remarkEvents({ start: 0, end: 2, text: "最初の発言です" }),
      ],
    });
    yield* r.cli(["recorded", r.file]);

    expect(stderrLines(r).filter((l) => l === formatScreenOffNotice())).toHaveLength(0);
  }).pipe(Effect.scoped));

});

// 差分更新が利用上限で一時停止している間（Issue #1092）、録画からのセッションは溜まっている発言をセッションへ入れず、ヘルパーにもファイルを読み進めさせない。
// 次に試す時刻に再試行が成功したら、止めた続きから入れる。再試行がまた一時停止しても諦めず、待っている間の stop・Ctrl-C は入れた分で終える。
// ヘルパーは台本のイベント（r1〜r3）を、一時停止の前にすべて流し終えている（先に読んで溜まっている分を入れないことを見る）。
describe("cli recorded <file> 差分更新の一時停止", () => {
  const CHATGPT = "ChatGPT の利用上限";
  const CLAUDE = "Claude の利用上限";
  const stderrLines = (r: { deps: { stderr: string[] } }) => r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((l) => l.trim() !== "");
  // 進み具合の行が出す「次に試す時刻」（地方時の時:分）。時は 1 桁でも 2 桁でも含まれる
  const localClock = (ms: number) => {
    const date = new Date(ms);
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  const pausedLine = (r: { deps: { stderr: string[] } }, reason: string, retryAt: number) =>
    stderrLines(r).some((line) => line.includes(reason) && line.includes(localClock(retryAt)));
  const paused = (reason: typeof CHATGPT | typeof CLAUDE, retryAt?: number) =>
    Effect.fail(new DiffUpdatePaused({ reason, message: reason, ...(retryAt === undefined ? {} : { retryAt }) }));
  const realDelay = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readingPauses = (r: { helpers: { sent: { type: string; paused: boolean }[] } }) => r.helpers.sent.filter((s) => s.type === "reading-pause");
  const remarkIds = (r: { sessionsDir: string }) => remarksOf(sessionLog(r.sessionsDir)).map((x) => x.id);
  const isRemark = (id: string) => (l: Line) => l.type === "remark" && (l.remark as { id: string }).id === id;
  const pauseLogged = (r: { sessionsDir: string }) => has(r.sessionsDir, (l) => l.type === "diff-update-paused");

  // 1 回目の差分更新（r1）が一時停止する。時刻は仮想時計の 0 から数える
  const RETRY_AT = 2 * 3_600_000 + 37 * 60_000;

  it.effect("一時停止の間は、先に読んで溜まっている r2・r3 を入れず、差分更新も呼ばない。ヘルパーへ読み取りの停止を送り、進み具合に理由と次に試す時刻を出す。次に試す時刻に成功したら、続きから r2・r3 の順で 1 回ずつ入り、再開を送り、進み具合から理由が消える", () => withVirtualClock((pending) => Effect.gen(function* () {
    const updater = fakeUpdater((_input, call) => call === 1 ? paused(CHATGPT, RETRY_AT) : Effect.void);
    const r = yield* resource({ ...THREE, hold: true }, updater);
    const running = yield* r.cli(["recorded", r.file]).pipe(Effect.forkChild);

    yield* eventually(() => pauseLogged(r), "1 回目の差分更新が一時停止する");
    yield* eventually(() => readingPauses(r).length > 0, "ヘルパーへ読み取りの停止が送られる");
    yield* eventually(() => pausedLine(r, CHATGPT, RETRY_AT), "進み具合の行に、理由と次に試す時刻が出る");
    yield* realDelay(300); // 一時停止の間に、溜まっている分が入らないことを実時間で見る
    // 一時停止の間は増えない: 発言は r1 だけ、差分更新の呼び出しも 1 回のまま
    expect(remarkIds(r)).toEqual(["r1"]);
    expect(updater.inputs).toHaveLength(1);
    // 停止の指示は 1 回目の一時停止で送られ、再開の指示はまだ送られない
    expect(readingPauses(r)[0]).toEqual({ type: "reading-pause", paused: true });
    expect(readingPauses(r).some((s) => !s.paused)).toBe(false);

    // 次に試す時刻の直前まで進めても、入らない。時刻に着いて再試行が成功すると、続きから入る
    yield* advanceTo(pending, RETRY_AT, () => has(r.sessionsDir, isRemark("r2")));
    // 最後の相手の発言は、話者を決める段が保留するので、ヘルパーの終わり（drain）で出る
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));

    expect(remarkIds(r)).toEqual(["r1", "r2", "r3"]);
    // 再試行（r1 をもう一度）の後は、r2・r3 が 1 回ずつ、重ならずに呼ばれる
    expect(updater.inputs.map((input) => input.fresh.map((remark) => remark.id))).toEqual([["r1"], ["r1"], ["r2"], ["r3"]]);
    expect(updater.state.overlaps).toBe(0);
    // 再開の指示は、停止の指示の後に送られ、最後の状態は再開
    expect(readingPauses(r).at(0)?.paused).toBe(true);
    expect(readingPauses(r).at(-1)).toEqual({ type: "reading-pause", paused: false });
    // 再開した後の進み具合の行には、理由が出ない
    const lines = stderrLines(r);
    expect(lines.at(-1)).toBe("12:30 / 58:04  マップの更新 3 回");
    expect(lines.at(-1)).not.toContain(CHATGPT);
  })).pipe(Effect.scoped), 60_000);

  it.effect("--realtime でも、一時停止の間は音声の時刻が過ぎても次の発言を入れず、差分更新を呼ばない。次に試す時刻に成功したら続きから入る", () => withVirtualClock((pending) => Effect.gen(function* () {
    const RT_RETRY_AT = 100_000;
    const updater = fakeUpdater((_input, call) => call === 1 ? paused(CHATGPT, RT_RETRY_AT) : Effect.void);
    const r = yield* resource({
      remarks: [],
      hold: true,
      events: [
        ...remarkEvents({ start: 0, end: 2, text: "最初の発言です" }),
        ...remarkEvents({ start: 10, end: 12, text: "次の発言です" }),
        ...remarkEvents({ start: 20, end: 22, text: "三つ目の発言です" }),
      ],
    }, updater);
    const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.forkChild);

    yield* advanceTo(pending, 2000, () => has(r.sessionsDir, isRemark("r1")));
    yield* eventually(() => pauseLogged(r), "r1 の差分更新が一時停止する");
    yield* eventually(() => readingPauses(r).length > 0, "ヘルパーへ読み取りの停止が送られる");
    // r2・r3 の音声の時刻（12・22 秒）をとうに過ぎるまで仮想時計を進めても、次に試す時刻の前なら入らない
    yield* TestClock.adjust(30_000);
    yield* realDelay(300);
    expect(remarkIds(r)).toEqual(["r1"]);
    expect(updater.inputs).toHaveLength(1);

    yield* TestClock.adjust(RT_RETRY_AT - 32_000);
    yield* eventually(() => has(r.sessionsDir, isRemark("r2")), "次に試す時刻に成功して、r2 が入る");
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));
    expect(remarkIds(r)).toEqual(["r1", "r2", "r3"]);
    expect(readingPauses(r).at(-1)).toEqual({ type: "reading-pause", paused: false });
  })).pipe(Effect.scoped), 60_000);

  it.effect("--realtime で、一時停止の行の書き込みを待っている間に次の発言の音声の時刻が過ぎても、次の発言を入れず、差分更新を呼ばない。書き込みが終わっても、次に試す時刻まで入らない", () => withVirtualClock((pending) => Effect.gen(function* () {
    const RT_RETRY_AT = 100_000;
    const stall = stallingLogWrite((content) => content.includes('"type":"diff-update-paused"'));
    const updater = fakeUpdater((_input, call) => call === 1 ? paused(CHATGPT, RT_RETRY_AT) : Effect.void);
    const r = yield* resource({
      remarks: [],
      hold: true,
      events: [
        ...remarkEvents({ start: 0, end: 2, text: "最初の発言です" }),
        ...remarkEvents({ start: 10, end: 12, text: "次の発言です" }),
        ...remarkEvents({ start: 20, end: 22, text: "三つ目の発言です" }),
      ],
    }, updater, { fileSystem: stall.layer });
    const running = yield* r.cli(["recorded", r.file, "--realtime"]).pipe(Effect.forkChild);

    yield* advanceTo(pending, 2000, () => Deferred.isDoneUnsafe(stall.entered));
    // r2・r3 の音声の時刻（12・22 秒）をとうに過ぎるまで、一時停止の行の書き込みを保留したまま仮想時計を進める
    yield* TestClock.adjust(30_000);
    yield* realDelay(300);
    yield* Deferred.succeed(stall.release, undefined);
    yield* eventually(() => readingPauses(r).length > 0, "ヘルパーへ読み取りの停止が送られる");
    yield* realDelay(300);
    expect(remarkIds(r)).toEqual(["r1"]);
    expect(updater.inputs).toHaveLength(1);

    yield* TestClock.adjust(RT_RETRY_AT - 32_000);
    yield* eventually(() => has(r.sessionsDir, isRemark("r2")), "次に試す時刻に成功して、r2 が入る");
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));
    expect(remarkIds(r)).toEqual(["r1", "r2", "r3"]);
    expect(readingPauses(r).at(-1)).toEqual({ type: "reading-pause", paused: false });
  })).pipe(Effect.scoped), 60_000);

  it.effect("再試行がもう一度一時停止しても自動では諦めず、止めは解かない。進み具合は新しい理由と次に試す時刻に更新される。次の試しで成功したら続きから入る", () => withVirtualClock((pending) => Effect.gen(function* () {
    const FIRST = 3_600_000 + 23 * 60_000;
    const SECOND = FIRST + 300_000; // 再試行でも戻らなければ 5 分ごと
    const updater = fakeUpdater((_input, call) => call === 1 ? paused(CHATGPT, FIRST) : call === 2 ? paused(CLAUDE) : Effect.void);
    const r = yield* resource({ ...THREE, hold: true }, updater);
    const running = yield* r.cli(["recorded", r.file]).pipe(Effect.forkChild);

    yield* eventually(() => pausedLine(r, CHATGPT, FIRST), "進み具合に 1 回目の理由と次に試す時刻が出る");
    // 1 回目の試しの時刻に着くと再試行が呼ばれ、また一時停止する。それでも r2 は入らず、再開は送られない
    yield* eventually(() => pending.includes(FIRST), "次に試す時刻の sleep が登録される");
    yield* TestClock.adjust(FIRST);
    yield* eventually(() => updater.inputs.length === 2, "再試行が呼ばれる");
    yield* eventually(() => pausedLine(r, CLAUDE, SECOND), "進み具合が、新しい理由と新しい次に試す時刻に更新される");
    yield* realDelay(300);
    expect(remarkIds(r)).toEqual(["r1"]);
    expect(readingPauses(r).some((s) => !s.paused)).toBe(false);
    expect(running.pollUnsafe()).toBeUndefined(); // CLI は戻らない

    yield* advanceTo(pending, SECOND, () => has(r.sessionsDir, isRemark("r2")));
    // 最後の相手の発言は、話者を決める段が保留するので、ヘルパーの終わり（drain）で出る
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));
    expect(remarkIds(r)).toEqual(["r1", "r2", "r3"]);
    expect(updater.inputs.map((input) => input.fresh.map((remark) => remark.id))).toEqual([["r1"], ["r1"], ["r1"], ["r2"], ["r3"]]);
    expect(readingPauses(r).at(-1)).toEqual({ type: "reading-pause", paused: false });
  })).pipe(Effect.scoped), 60_000);

  type Halt = (r: { cli: (argv: string[]) => Effect.Effect<void, unknown, never> }, running: Fiber.Fiber<unknown, unknown>) => Effect.Effect<unknown, unknown>;
  it.effect.each<{ name: string; halt: Halt }>([
    { name: "stop", halt: (r) => r.cli(["stop"]) },
  ])("一時停止で待っている間の $name は、仮想時計を進めなくてもすぐ戻り、入れた分（r1）で map.* を書く。溜まっていた分は入れず、status はセッションなしになる", ({ halt }) =>
    withVirtualClock(() => Effect.gen(function* () {
      const updater = fakeUpdater((_input, call) => call === 1 ? paused(CHATGPT, RETRY_AT) : Effect.void);
      const r = yield* resource({ ...THREE, hold: true }, updater);
      const running = yield* r.cli(["recorded", r.file]).pipe(Effect.forkChild);
      yield* eventually(() => pauseLogged(r), "1 回目の差分更新が一時停止する");
      yield* eventually(() => readingPauses(r).length > 0, "ヘルパーへ読み取りの停止が送られる");
      yield* realDelay(200);

      let halted = false;
      yield* halt(r, running).pipe(Effect.ensuring(Effect.sync(() => { halted = true; })), Effect.forkChild);
      yield* eventually(() => halted, "仮想時計を進めなくても、停止の要求が戻る");
      let ended = false;
      yield* Fiber.await(running).pipe(Effect.ensuring(Effect.sync(() => { ended = true; })), Effect.forkChild);
      yield* eventually(() => ended, "仮想時計を進めなくても、recorded の CLI が戻る");

      expect(yield* virtualNow).toBe(0);
      const dir = onlySession(r.sessionsDir);
      expect(remarksOf(logLines(dir)).map((x) => x.id)).toEqual(["r1"]);
      for (const name of ["map.md", "map.json", "map.drawnix"]) expect(existsSync(join(dir, name))).toBe(true);
      const after = cliDependencies(r.sessionsDir, r.server.port);
      yield* runCli(["status"]).pipe(Effect.provide(after.layer));
      expect(after.stdout.join("")).toContain("セッションなし");
    })).pipe(Effect.scoped), 60_000);

  const readingPausesOf = (r: { helpers: { sentByAttempt: { attempt: number; type: string; paused: boolean }[] } }, attempt: number) =>
    r.helpers.sentByAttempt.filter((s) => s.type === "reading-pause" && s.attempt === attempt).map((s) => s.paused);

  it.effect("起動し直した後に一時停止へ入ると、読み取りの停止は 2 回目のヘルパーへ届く。再開もその回へ届き、1 回目には何も送られない", () => withVirtualClock((pending) => Effect.gen(function* () {
    const updater = fakeUpdater((_input, call) => call === 1 ? paused(CHATGPT, RETRY_AT) : Effect.void);
    // 1 回目は何も流さず落ちる。2 回目（hold）が r1 を流し、その差分更新が一時停止する
    const r = yield* resource({ ...THREE, hold: true }, updater, { attempts: [{ duration: 3484, remarks: [], exit: { code: 1, signal: null } }] });
    const running = yield* r.cli(["recorded", r.file]).pipe(Effect.forkChild);

    yield* eventually(() => pauseLogged(r), "2 回目のヘルパーが流した r1 の差分更新が一時停止する");
    yield* eventually(() => readingPausesOf(r, 1).length > 0, "2 回目のヘルパーへ読み取りの停止が送られる");
    expect(r.helpers.calls).toHaveLength(2);
    expect(readingPausesOf(r, 1)).toEqual([true]);
    expect(readingPausesOf(r, 0)).toEqual([]);

    yield* advanceTo(pending, RETRY_AT, () => has(r.sessionsDir, isRemark("r2")));
    expect(readingPausesOf(r, 1)).toEqual([true, false]);
    expect(readingPausesOf(r, 0)).toEqual([]);
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));
    expect(remarkIds(r)).toEqual(["r1", "r2", "r3"]);
  })).pipe(Effect.scoped), 60_000);

  it.effect("一時停止の間にヘルパーが落ちて起動し直すと、2 回目のヘルパーへ接続した直後に読み取りの停止が届く。再開もその回へ届く", () => withVirtualClock((pending) => Effect.gen(function* () {
    const updater = fakeUpdater((_input, call) => call === 1 ? paused(CHATGPT, RETRY_AT) : Effect.void);
    // 1 回目（hold）が r1 を流して一時停止し、その間に落ちる。2 回目（hold）は何も流さず居続ける
    const r = yield* resource({ ...THREE, hold: true }, updater, { attempts: [{ ...THREE, hold: true }, { duration: 3484, remarks: [], hold: true }] });
    const running = yield* r.cli(["recorded", r.file]).pipe(Effect.forkChild);

    yield* eventually(() => pauseLogged(r), "1 回目の差分更新が一時停止する");
    yield* eventually(() => readingPausesOf(r, 0).length > 0, "1 回目のヘルパーへ読み取りの停止が送られる");
    yield* r.helpers.crash;
    yield* eventually(() => r.helpers.calls.length === 2, "2 回目のヘルパーが起動する");
    yield* eventually(() => readingPausesOf(r, 1).length > 0, "2 回目のヘルパーへ読み取りの停止が届く");
    expect(readingPausesOf(r, 0)).toEqual([true]);
    expect(readingPausesOf(r, 1)).toEqual([true]);
    expect(remarkIds(r)).toEqual(["r1"]);

    yield* advanceTo(pending, RETRY_AT, () => readingPausesOf(r, 1).length > 1);
    expect(readingPausesOf(r, 0)).toEqual([true]);
    expect(readingPausesOf(r, 1)).toEqual([true, false]);
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));
  })).pipe(Effect.scoped), 60_000);

  it.live("一時停止がなければ、ヘルパーへ読み取りの停止は送らず、進み具合に理由は出ない", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* r.cli(["recorded", r.file]);
    expect(readingPauses(r)).toEqual([]);
    expect(stderrLines(r).some((line) => line.includes("利用上限"))).toBe(false);
  }).pipe(Effect.scoped));
});

// Issue #1094: 録画の `相手` を話者分離にかける。ヘルパーの speaker 系のイベントを話者の付与へ渡し、speaker-off では保留せず話者なしで出す
describe("cli recorded <file> 話者分離（Issue #1094）", () => {
  const stderrLines = (r: { deps: { stderr: string[] } }) => r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((l) => l.trim() !== "");
  const eventually = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion, { timeout: 10_000 }));
  const remarkLines = (sessionsDir: string) => sessionLog(sessionsDir).filter((l) => l.type === "remark").map((l) => l.remark as { text: string; speaker?: string });
  const speakerSegment = (start: number, end: number, slot = 0) => ({ type: "speaker", track: "相手", start, end, slot, final: true });
  const settled = (to: number) => ({ type: "speaker-settled", track: "相手", to });

  it.live("ヘルパーの speaker・speaker-settled の台本から、1 本の録音の `相手` の発言に話者のラベル（相手 A）が付く。自分の声も特別に扱わない（`自分` にならない）", () => Effect.gen(function* () {
    const first = { start: 0, end: 2, text: "最初の発言です" };
    const r = yield* resource({ remarks: [], events: [{ type: "file-duration", duration: 20 }, speakerSegment(0, 2), settled(2.5), ...remarkEvents(first)] });
    yield* r.cli(["recorded", r.file]);

    expect(remarksOf(logLines(onlySession(r.sessionsDir))).map((x) => ({ track: x.track, text: x.text }))).toEqual([{ track: "相手", text: "最初の発言です" }]);
    expect(remarkLines(r.sessionsDir)).toEqual([expect.objectContaining({ text: "最初の発言です", speaker: "相手 A" })]);
  }).pipe(Effect.scoped));

  it.live("別の枠（slot 1）の区間に重なる発言には、別のラベル（相手 B）が付く", () => Effect.gen(function* () {
    const a = { start: 0, end: 2, text: "一人目の発言です" };
    const b = { start: 2, end: 4, text: "二人目の発言です" };
    const r = yield* resource({
      remarks: [],
      events: [{ type: "file-duration", duration: 20 }, speakerSegment(0, 2, 0), speakerSegment(2, 4, 1), settled(4.5), ...remarkEvents(a), ...remarkEvents(b)],
    });
    yield* r.cli(["recorded", r.file]);

    expect(remarkLines(r.sessionsDir).map((x) => [x.text, x.speaker])).toEqual([["一人目の発言です", "相手 A"], ["二人目の発言です", "相手 B"]]);
  }).pipe(Effect.scoped));

  it.live("speaker-off では、`相手` の発言を 3 秒保留せずに（ヘルパーが動いている間に）話者なしで出し、端末に「話者分離なしで続ける」知らせを 1 回だけ出す", () => Effect.gen(function* () {
    const first = { start: 0, end: 2, text: "最初の発言です" };
    const second = { start: 2, end: 4, text: "二つ目の発言です" };
    const r = yield* resource({ remarks: [], hold: true, events: [{ type: "file-duration", duration: 20 }, { type: "speaker-off", start: 0, reason: "モデルなし" }, ...remarkEvents(first)] });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    // ヘルパーは終わらない。drain（終わり）まで待たずに、発言がセッションに入る
    yield* waitForRemarks(r.sessionsDir, 1);
    expect(remarkLines(r.sessionsDir)).toEqual([expect.objectContaining({ text: "最初の発言です" })]);
    expect(remarkLines(r.sessionsDir)[0]!.speaker).toBeUndefined();
    // 2 回目の speaker-off（起動し直しの流し直しなど）が来ても、知らせは増えない
    r.helpers.feed({ type: "speaker-off", start: 0, reason: "モデルなし" });
    for (const event of remarkEvents(second)) r.helpers.feed(event);
    yield* waitForRemarks(r.sessionsDir, 2);
    yield* eventually(() => { expect(stderrLines(r).filter((l) => l === formatSpeakerOffNotice("モデルなし"))).toHaveLength(1); });
    expect(stderrLines(r).filter((l) => l.includes("話者分離なしで続け"))).toHaveLength(1);
    expect(remarkLines(r.sessionsDir).map((x) => x.speaker)).toEqual([undefined, undefined]);

    yield* r.cli(["stop"]);
    yield* Fiber.join(running).pipe(Effect.ignore);
  }).pipe(Effect.scoped));

  it.live("話者分離が使えるときは、`話者分離なしで続ける` 知らせを出さない", () => Effect.gen(function* () {
    const first = { start: 0, end: 2, text: "最初の発言です" };
    const r = yield* resource({ remarks: [], events: [{ type: "file-duration", duration: 20 }, speakerSegment(0, 2), settled(2.5), ...remarkEvents(first)] });
    yield* r.cli(["recorded", r.file]);
    expect(stderrLines(r).some((l) => l.includes("話者分離なしで続け"))).toBe(false);
  }).pipe(Effect.scoped));

  it.live("録画からのセッションでも、ライブと同じ POST /session/speaker-name で振られたラベルに名前を付けられる（204）。log.jsonl に手入力の名前が残る", () => Effect.gen(function* () {
    const first = { start: 0, end: 2, text: "最初の発言です" };
    const r = yield* resource({ remarks: [], hold: true, events: [{ type: "file-duration", duration: 20 }, speakerSegment(0, 2), settled(2.5), ...remarkEvents(first)] });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForRemarks(r.sessionsDir, 1);
    expect(remarkLines(r.sessionsDir)[0]!.speaker).toBe("相手 A");

    const post = () => fetch(`http://127.0.0.1:${r.server.port}/session/speaker-name`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "相手 A", name: "田中" }),
    });
    const response = yield* Effect.promise(post);
    expect(response.status).toBe(204);
    expect(sessionLog(r.sessionsDir).filter((l) => l.type === "speaker-name").map((l) => [l.label, l.name, l.source])).toEqual([["相手 A", "田中", "手入力"]]);

    yield* r.cli(["stop"]);
    yield* Fiber.join(running).pipe(Effect.ignore);
  }).pipe(Effect.scoped));

  it.live("ヘルパーを起動し直した後の新しい世代の slot 0 に、前のラベル（相手 A）を引き継がない（重心で照らし合わせるまで話者なし）。起動し直す前の世代の発言は 相手 A のまま", () => Effect.gen(function* () {
    const first = { start: 0, end: 2, text: "起動し直す前の発言です" };
    const second = { start: 3, end: 5, text: "起動し直した後の発言です" };
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        { duration: 20, remarks: [], events: [speakerSegment(0, 2), settled(2.5), ...remarkEvents(first)], exit: { code: 1, signal: null } },
        { duration: 20, remarks: [], events: [speakerSegment(3, 5), settled(5.5), ...remarkEvents(second)] },
      ],
    });
    yield* r.cli(["recorded", r.file]);

    expect(r.helpers.calls).toHaveLength(2);
    expect(remarkLines(r.sessionsDir).map((x) => [x.text, x.speaker])).toEqual([
      ["起動し直す前の発言です", "相手 A"],
      ["起動し直した後の発言です", undefined],
    ]);
  }).pipe(Effect.scoped));
});

// Issue #1095: 録画でヘルパーが落ちて読み直したとき、話者のラベルをライブと同じつなぎ直し（Issue #1025）でつなぐ。
// 同じ cli recorded の 1 回の中で「落ちる前 → 落ちる → 読み直した後」を続けて見る
describe("cli recorded <file> 起動し直しをまたいだ話者のつなぎ直し（Issue #1095）", () => {
  const remarkLines = (sessionsDir: string) => sessionLog(sessionsDir).filter((l) => l.type === "remark").map((l) => l.remark as { text: string; speaker?: string });
  const speakerSegment = (start: number, end: number, slot: number) => ({ type: "speaker", track: "相手", start, end, slot, final: true });
  const settled = (to: number) => ({ type: "speaker-settled", track: "相手", to });
  const centroid = (slot: number, vector: readonly number[]) => ({ type: "speaker-centroid", track: "相手", slot, centroid: [...vector] });
  // 4 次元の単位ベクトル 4 本。互いの cos は 0
  const UNIT = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] as const;
  // UNIT[i] と cos 0.95、ほかの UNIT とは 0.6 未満になる重心
  const near = (i: number): number[] => UNIT[i]!.map((v, k) => (k === i ? 0.95 : k === (i + 1) % 4 ? Math.sqrt(1 - 0.95 ** 2) : 0));
  const speak = (slot: number, start: number, text: string) => [speakerSegment(start, start + 2, slot), settled(start + 2.5), ...remarkEvents({ start, end: start + 2, text })];

  it.live("落ちる前にラベルが付いた 2 人は、読み直した後に枠の番号が入れ替わっても同じラベルで出る。重心が届くまでの発言は話者なしで、起動し直す前の発言のラベルは変わらない", () => Effect.gen(function* () {
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        // 1 回目: 枠 0 = 相手 A の声、枠 1 = 相手 B の声。重心は発言より前に届く
        { duration: 40, remarks: [], events: [centroid(0, UNIT[0]), centroid(1, UNIT[1]), ...speak(0, 0, "一人目の発言です"), ...speak(1, 2, "二人目の発言です")], exit: { code: 1, signal: null } },
        // 2 回目: 枠の番号が逆。重心が届く前の枠 1 の発言は話者なし。届いた後は、枠 1 = A の声、枠 0 = B の声
        { duration: 40, remarks: [], events: [...speak(1, 4, "分かる前の発言です"), centroid(1, near(0)), centroid(0, near(1)), ...speak(1, 6, "A に戻った発言です"), ...speak(0, 8, "B に戻った発言です")] },
      ],
    });
    yield* r.cli(["recorded", r.file]);

    expect(r.helpers.calls).toHaveLength(2);
    expect(remarkLines(r.sessionsDir).map((x) => [x.text, x.speaker])).toEqual([
      ["一人目の発言です", "相手 A"],
      ["二人目の発言です", "相手 B"],
      ["分かる前の発言です", undefined],
      ["A に戻った発言です", "相手 A"],
      ["B に戻った発言です", "相手 B"],
    ]);
  }).pipe(Effect.scoped));

  it.live("4 人が枠を入れ替えて戻っても、会議全体のラベルは 相手 A〜D のまま増えない（相手 E は出ない）。各発言は声に対応するラベルで出る", () => Effect.gen(function* () {
    const r = yield* resource(THREE, fakeUpdater(), {
      attempts: [
        {
          duration: 40, remarks: [], exit: { code: 1, signal: null },
          events: [...UNIT.map((v, slot) => centroid(slot, v)), ...speak(0, 0, "一"), ...speak(1, 2, "二"), ...speak(2, 4, "三"), ...speak(3, 6, "四")],
        },
        {
          duration: 40, remarks: [],
          // 枠 0 = D、枠 1 = A、枠 2 = B、枠 3 = C の声
          events: [centroid(0, near(3)), centroid(1, near(0)), centroid(2, near(1)), centroid(3, near(2)), ...speak(0, 8, "五"), ...speak(1, 10, "六"), ...speak(2, 12, "七"), ...speak(3, 14, "八")],
        },
      ],
    });
    yield* r.cli(["recorded", r.file]);

    expect(remarkLines(r.sessionsDir).map((x) => [x.text, x.speaker])).toEqual([
      ["一", "相手 A"], ["二", "相手 B"], ["三", "相手 C"], ["四", "相手 D"],
      ["五", "相手 D"], ["六", "相手 A"], ["七", "相手 B"], ["八", "相手 C"],
    ]);
    expect([...new Set(remarkLines(r.sessionsDir).map((x) => x.speaker))].sort()).toEqual(["相手 A", "相手 B", "相手 C", "相手 D"]);
  }).pipe(Effect.scoped));
});
