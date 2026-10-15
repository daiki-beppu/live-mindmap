import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { WebSocket } from "ws";
import { Clock, ConfigProvider, Console, Deferred, Effect, FileSystem, Fiber, Layer, Queue, Result, Stream, type Cause } from "effect";
import { HttpClient } from "effect/http";
import { vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import { formatAudioTracksNotice, formatScreenOffNotice, type DiffInput } from "../src/core/index.ts";
import { AudioMix } from "../src/audioMix.ts";
import { Helpers, type HelperExitInfo } from "../src/helpers.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { unusedApple } from "./fixtures/appleIntelligence.ts";
import { embeddedAudio, FAKE_MIX_BYTES, fakeAudioMix, type FakeMix } from "./fixtures/audioMix.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { fakeReadings, type FakeReadings } from "./fixtures/readings.ts";
import { readyHelperChecks } from "./fixtures/helperCheck.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { updaterLayer } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { advanceTo, eventually, runToEnd, trackingClock, virtualNow } from "./fixtures/virtualTime.ts";
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

function fakeHelpers(script: Script) {
  const calls: string[][] = [];
  const stopSeen = Effect.runSync(Deferred.make<void>());
  // 起動した後に、テストからヘルパーのイベントを足す
  const live: { queue: Queue.Queue<string, Cause.Done> | undefined; end: Effect.Effect<void> | undefined } = { queue: undefined, end: undefined };
  const feed = (event: unknown) => { Queue.offerUnsafe(live.queue!, JSON.stringify(event)); };
  // hold のヘルパーを、自然な終わり（code 0）で終わらせる
  const end = Effect.suspend(() => live.end!);
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
    // --self-file のときは、自分用の音声も書く（待ち受けの前に 相手.m4a と 自分.m4a の両方を書き終える）
    if (args.includes("--self-file") && audioDir !== undefined) writeFileSync(join(audioDir, "自分.m4a"), HELPER_SELF_AUDIO);
    const queue = yield* Queue.make<string, Cause.Done>();
    live.queue = queue;
    const exited = yield* Deferred.make<HelperExitInfo>();
    const finish = (info: HelperExitInfo) => Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, info)));
    live.end = finish({ code: 0, signal: null });
    const stop = finish({ code: null, signal: "SIGTERM" });
    yield* Effect.addFinalizer(() => stop);
    yield* Effect.forkScoped(Effect.andThen(Deferred.await(stopRequested), Deferred.succeed(stopSeen, undefined)));
    for (const event of events(script)) Queue.offerUnsafe(queue, JSON.stringify(event));
    if (script.hold !== true) yield* finish(script.exit ?? { code: 0, signal: null });
    return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed(["helper stderr"]), send: () => Effect.void };
  });
  const layer = Layer.succeed(Helpers, Helpers.of({ ...readyHelperChecks, apps: Effect.succeed([]), creationDate, launch }));
  return { calls, creationDateCalls, stopSeen, layer, feed, end };
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

const resource = Effect.fnUntraced(function* (script: Script, updater: ReturnType<typeof fakeUpdater> = fakeUpdater(), options: { fileName?: string; viewing?: ReturnType<typeof fakeTunnel>["viewing"]; fileSystem?: Layer.Layer<FileSystem.FileSystem>; cli?: CliOptions; mix?: FakeMix; readings?: FakeReadings } = {}) {
  // 実行準備（prepareUpdater）へ届いたモデル
  const models: ExecutableModel[] = [];
  const root = yield* temporaryDirectory;
  const sessionsDir = join(root, "sessions");
  const file = join(root, options.fileName ?? "meeting.m4a");
  writeFileSync(file, "audio");
  // --self に渡す、自分用の録音
  const selfFile = join(root, "me.m4a");
  writeFileSync(selfFile, "self audio");
  const helpers = fakeHelpers(script);
  const server = yield* startedServer({ port: 0, sessionsDir }, {
    helpers: helpers.layer, managedDeps: readyManagedDeps, ...(options.viewing === undefined ? {} : { viewing: options.viewing }),
    sessionSinks: SessionSinks.layer({ prepareUpdater: (model) => { models.push(model); return Effect.succeed(updater.layer); } }).pipe(Layer.provide(fakeExportServices({ ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }), ...(options.mix === undefined ? {} : { mix: options.mix }), ...(options.readings === undefined ? {} : { readings: options.readings }) }))),
  });
  const deps = cliDependencies(sessionsDir, server.port, unusedApple, options.cli);
  const cli = (argv: string[]) => runCli(argv).pipe(Effect.provide(deps.layer));
  const localDeps = cliDependencies(sessionsDir, server.port, Layer.succeed(AppleIntelligence, AppleIntelligence.of({
    availability: Effect.succeed({ osVersion: "27.0", availability: { status: "available" } }),
    launch: Effect.die("CLI は Apple を起動しない"),
  })));
  return { root, sessionsDir, file, selfFile, helpers, updater, server, deps, cli, models, localDeps };
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

    it.live("自分 の確定結果が、先の時刻の 相手 の発言より後に届いても（ヘルパーの重複の保留で遅れた形）、音声の時刻の順に並ぶ。届いた順のままにしない", () => Effect.gen(function* () {
      const r = yield* resource({
        duration: 12,
        remarks: [],
        events: [
          ...spoken("相手", { start: 0, end: 2, text: "相手の一つ目" }),
          ...spoken("相手", { start: 4.5, end: 6, text: "相手の二つ目" }),
          // 相手 の音声の時計が進み、二つ目も話者の保留を終えた後に、遅れた 自分 の確定結果が届く
          ...spoken("相手", { start: 10, end: 11, text: "相手の三つ目" }),
          ...spoken("自分", { start: 2.5, end: 4, text: "自分の発言" }),
        ],
      });
      yield* r.cli(["recorded", r.file, "--self", r.selfFile]);

      const dir = onlySession(r.sessionsDir);
      expect(idsAndTracks(dir).map((x) => [x.id, x.track, x.end])).toEqual([
        ["r1", "相手", 2], ["r2", "自分", 4], ["r3", "相手", 6], ["r4", "相手", 11],
      ]);
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

    it.live("自分.m4a もセッションのフォルダに残り、map-audio.html ができる。mix を呼んだ時点で 相手.m4a と 自分.m4a の両方がフォルダにある。元のファイルはコピーしない", () => Effect.gen(function* () {
      const fake = fakeAudioMix();
      const foldersAtMix: string[][] = [];
      const recording = Layer.effect(AudioMix, Effect.gen(function* () {
        const inner = yield* AudioMix;
        return AudioMix.of({ mix: (session, out, track) => { foldersAtMix.push(readdirSync(session).sort()); return inner.mix(session, out, track); } });
      })).pipe(Layer.provide(fake.layer));
      const r = yield* resource(INTERLEAVED, fakeUpdater(), { mix: { ...fake, layer: recording } });
      yield* r.cli(["recorded", r.file, "--self", r.selfFile]);

      const dir = onlySession(r.sessionsDir);
      expect(readFileSync(join(dir, "相手.m4a"), "utf8")).toBe(HELPER_AUDIO);
      expect(readFileSync(join(dir, "自分.m4a"), "utf8")).toBe(HELPER_SELF_AUDIO);
      expect(fake.calls.map((call) => call.session)).toEqual([dir]);
      expect(foldersAtMix).toHaveLength(1);
      expect(foldersAtMix[0]).toEqual(expect.arrayContaining(["相手.m4a", "自分.m4a"]));
      expect(embeddedAudio(readFileSync(join(dir, "map-audio.html"), "utf8"))).toEqual(FAKE_MIX_BYTES);
      expect(readdirSync(dir)).not.toContain(basename(r.file));
      expect(readdirSync(dir)).not.toContain(basename(r.selfFile));
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

  // 偽の時計をサーバーにも CLI にも渡す（resource の中のサーバーの起動も、この Clock の下で行う）
  const withVirtualClock = <A, E, R>(body: (pending: number[]) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const pending: number[] = [];
      const clock = yield* trackingClock(pending);
      return yield* body(pending).pipe(Effect.provideService(Clock.Clock, clock));
    });

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

  it.effect.each<{ source: "user" | "screen" }>([{ source: "user" }, { source: "screen" }])(
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
    { name: "Ctrl-C", halt: (_r, running) => Fiber.interrupt(running) },
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

  // 画面（6 秒）の語彙は、読みが返った後でも、その画面より前に終わる発言（0〜2 秒）は直さず、後に終わる発言（10〜12 秒）から直す
  it.live("画面の OCR の語彙は、画面が映った後に終わる発言だけを直す。映る前に終わった発言は、語彙が先に届いていても直さない", () => Effect.gen(function* () {
    const readings = fakeReadings({ 港南店: "kounanten" });
    const r = yield* resource({ remarks: [], hold: true }, fakeUpdater(), { readings });
    const running = yield* r.cli(["recorded", r.file]).pipe(Effect.forkChild);
    yield* eventually(() => r.helpers.calls.length === 1, "ヘルパーが起動する");
    // 画面が先に届き、読みが返って vocab の行ができてから、発言を流す
    r.helpers.feed({ type: "screen", start: 6, image: SCREEN_IMAGE, lines: ["港南店"] });
    yield* eventually(() => has(r.sessionsDir, (l) => l.type === "vocab"), "読みが返って vocab の行ができる");
    expect(readings.calls).toHaveLength(1);
    for (const event of [garbledPartial(0, 2), garbledRemark(0, 2), garbledPartial(10, 12), garbledRemark(10, 12)]) r.helpers.feed(event);
    yield* r.helpers.end;
    yield* Fiber.join(running);

    const lines = sessionLog(r.sessionsDir);
    expect(remarkTexts(lines)).toEqual(["江南店に行きます", "港南店に行きます"]);
  }).pipe(Effect.scoped), 30_000);
});
