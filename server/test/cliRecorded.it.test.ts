import { StartupChecks } from "../src/startupChecks.ts";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Console, Context, Deferred, Effect, Fiber, Layer, Result, Stream, type Scope } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { MapCapture } from "../src/capture.ts";
import { runCli } from "../src/cli.ts";
import { ReviewBuild } from "../src/review.ts";
import { DiffUpdatePaused, formatAudioTracksNotice, formatRecordedPosition, formatScreenOffNotice, formatSpeakerOffNotice, type DiffInput } from "../src/core/index.ts";
import { fakeHelpers, remarkEvents, type Script } from "./fixtures/recordedHelper.ts";
import { SessionSinks } from "../src/sessionSinks.ts";
import { availableApple, unusedApple } from "./fixtures/appleIntelligence.ts";
import { missingKeyNotice, type JudgeModel } from "../src/judgeSelection.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import type { UpdatePlan } from "../src/updatePlan.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { fakeScreenJpeg } from "./fixtures/screenJpeg.ts";
import { fakeExportServices } from "./fixtures/exportServices.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";
import { startedServer } from "./fixtures/startedServer.ts";
import { eventually, runToEnd, trackingClock } from "./fixtures/virtualTime.ts";
import { FAKE_TUNNEL_HOST, fakeTunnel } from "./fixtures/tunnel.ts";

// CLI の HTTP 要求と出力を観測する。話者分離の既存テストは #1323 の移管対象外。

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-cli-recorded-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

type UpdateScript = (input: DiffInput, call: number) => Effect.Effect<void, UpdateFailure>;

function fakeUpdater(before: UpdateScript = () => Effect.void) {
  let calls = 0;
  const layer = updaterLayer((input: DiffInput) => Effect.gen(function* () {
    yield* before(input, ++calls);
    return { ops: [] };
  }));
  return { layer };
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

type CliOptions = { env?: Record<string, string | undefined>; httpClient?: Layer.Layer<HttpClient.HttpClient>; apple?: typeof unusedApple };

function cliDependencies(sessionsDir: string, port: number, options: CliOptions = {}) {
  const env: Record<string, string> = {
    HOME: join(sessionsDir, "home"), LIVE_MINDMAP_CONFIG: join(sessionsDir, "absent.config.json"), LIVE_MINDMAP_JUDGE: "off",
    LIVE_MINDMAP_SESSIONS: sessionsDir, LIVE_MINDMAP_PORT: String(port),
  };
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  const consoleService: Console.Console = {
    ...console,
    log: (...args: unknown[]) => { stdout.push(args.map(String).join(" ") + "\n"); },
    error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); },
  };
  const layer = Layer.mergeAll(
    NodeServices.layer, options.apple ?? unusedApple, readyManagedDeps, options.httpClient ?? NodeHttpClient.layerUndici,
    Layer.succeed(MapCapture, MapCapture.of({ capture: () => Effect.die("CLI は撮影しない") })),
    Layer.succeed(ReviewBuild, ReviewBuild.of({ build: Effect.die("CLI は見返しを作らない") })),
    fakeAudioMix().layer, fakeScreenJpeg().layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
    Layer.succeed(Console.Console, consoleService),
  );
  return { layer, stdout, stderr };
}

type RecordedSink = Effect.Success<ReturnType<SessionSinks["Service"]["openRecorded"]>>;

const resource = Effect.fnUntraced(function* (script: Script, updater: ReturnType<typeof fakeUpdater> = fakeUpdater(), options: { fileName?: string; viewing?: ReturnType<typeof fakeTunnel>["viewing"]; cli?: CliOptions; attempts?: ReadonlyArray<Script>; notice?: string; wrapRecorded?: (sink: RecordedSink) => Effect.Effect<RecordedSink, never, Scope.Scope> } = {}) {
  const root = yield* temporaryDirectory;
  const sessionsDir = join(root, "sessions");
  const file = join(root, options.fileName ?? "meeting.m4a");
  writeFileSync(file, "audio");
  // --self に渡す、自分用の録音
  const selfFile = join(root, "me.m4a");
  writeFileSync(selfFile, "self audio");
  const helpers = fakeHelpers(script, options.attempts);
  const prepared: UpdatePlan[] = [];
  const server = yield* startedServer({ port: 0, sessionsDir }, {
    helpers: helpers.layer, managedDeps: readyManagedDeps, ...(options.viewing === undefined ? {} : { viewing: options.viewing }),
    sessionSinks: SessionSinks.layer.pipe(
      Layer.provide(fakeExportServices()),
      Layer.flatMap((context) => {
        const sinks = Context.get(context, SessionSinks);
        return Layer.succeed(SessionSinks, SessionSinks.of({ ...sinks, openRecorded: (args) =>
          Effect.flatMap(sinks.openRecorded(args), (sink) => options.wrapRecorded === undefined ? Effect.succeed(sink) : options.wrapRecorded(sink)),
        }));
      }),
    ), startupChecks: StartupChecks.layer({ prepareUpdater: (plan) => Effect.sync(() => {
      prepared.push(plan);
      return { layer: updater.layer, ...(options.notice === undefined ? {} : { notice: options.notice }) };
    }) }),
  });
  const requests: { url: string; body: unknown }[] = [];
  const requestClient = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.tapRequest(client, (request) => Effect.sync(() => {
      requests.push({ url: request.url, body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined });
    })))).pipe(Layer.provide(options.cli?.httpClient ?? NodeHttpClient.layerUndici));
  const deps = cliDependencies(sessionsDir, server.port, { ...options.cli, httpClient: requestClient });
  const cli = (argv: string[]) => runCli(argv).pipe(Effect.provide(deps.layer));
  return { root, sessionsDir, file, selfFile, helpers, server, deps, cli, requests, prepared };
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

describe("共有画面の OCR 失敗の終了通知", () => {
  const notices = (r: { deps: { stderr: string[] } }) => r.deps.stderr.join("").replaceAll("\r", "\n").split("\n")
    .filter((line) => line.startsWith("共有画面の文字を読めなかった画面:"));
  const screens = [
    { type: "screen", start: 1, image: SCREEN_IMAGE, ocrFailed: true },
    { type: "screen", start: 2, image: SCREEN_IMAGE, lines: [] },
    { type: "screen", start: 3, image: null },
  ];
  const first = { start: 4, end: 6, text: "共有画面を確認します" };

  it.live.each([
    ["自然終了", false], ["自然終了", true],
    ["再起動断念", false], ["再起動断念", true],
    ["別CLI stop", false], ["別CLI stop", true],
  ] as const)("%s が終了処理を所有した後も終了通知を一度受け取る（Ctrl-C=%s）", ([owner, interrupt]) => Effect.gen(function* () {
    const exporting = yield* Deferred.make<void>();
    const releaseExport = yield* Deferred.make<void>();
    const stopRejected = yield* Deferred.make<void>();
    let exports = 0;
    let closes = 0;
    const client = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, (http) =>
      HttpClient.tap(http, (response) => response.request.url.endsWith("/session/stop") && response.status === 409
        ? Effect.asVoid(Deferred.succeed(stopRejected, undefined)) : Effect.void))).pipe(Layer.provide(NodeHttpClient.layerUndici));
    const script: Script = { remarks: [], events: [...screens, ...remarkEvents(first), ...remarkEvents({ start: 10, end: 12, text: "次の発言です" })], hold: owner === "別CLI stop",
      ...(owner === "再起動断念" ? { exit: { code: 1, signal: null } } : {}) };
    const r = yield* resource(script, fakeUpdater(), {
      cli: { httpClient: client },
      ...(owner === "再起動断念" ? { attempts: [script, { remarks: [], failLaunch: true }, { remarks: [], failLaunch: true }] } : {}),
      wrapRecorded: (sink) => Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => { closes++; }));
        return { ...sink,
          drainForRestart: Effect.tap(sink.drainForRestart, () => Effect.promise(() => vi.waitFor(() =>
            expect(logLines(sink.dir).filter((line) => line.type === "screen")).toHaveLength(3), { timeout: 10_000 }))),
          end: (ending) => Effect.map(sink.end(ending), ({ writeOut }) => ({
            writeOut: Effect.gen(function* () {
              exports++;
              yield* Deferred.succeed(exporting, undefined);
              yield* Deferred.await(releaseExport);
              return yield* writeOut;
            }),
          })),
        };
      }),
    });
    const running = yield* Effect.forkChild(Effect.result(r.cli(["recorded", r.file])));
    yield* Effect.promise(() => vi.waitFor(() => expect(sessionLog(r.sessionsDir).filter((line) => line.type === "screen")).toHaveLength(3), { timeout: 10_000 }));
    const stopping = owner === "別CLI stop" ? yield* Effect.forkChild(r.cli(["stop"])) : undefined;
    yield* Deferred.await(exporting);
    expect(sessionLog(r.sessionsDir).filter((line) => line.type === "screen")).toHaveLength(3);
    expect(notices(r)).toEqual([]);
    const interrupted = interrupt ? yield* Effect.forkChild(Fiber.interrupt(running)) : undefined;
    if (interrupt) yield* Deferred.await(stopRejected);
    yield* Deferred.succeed(releaseExport, undefined);
    if (interrupted !== undefined) yield* Fiber.join(interrupted);
    else {
      const result = yield* Fiber.join(running);
      expect(Result.isFailure(result)).toBe(owner === "再起動断念");
    }
    if (stopping !== undefined) yield* Fiber.join(stopping);
    expect(notices(r)).toEqual(["共有画面の文字を読めなかった画面: 1 / 2 枚"]);
    expect(exports).toBe(1);
    yield* Effect.promise(() => vi.waitFor(() => expect(closes).toBe(1)));
  }).pipe(Effect.scoped));

  it.live("録画の自然終了で失敗数と画像数を一度だけ知らせ、失敗画像も保存する", () => Effect.gen(function* () {
    const r = yield* resource({ remarks: [], events: screens });
    yield* r.cli(["recorded", r.file]);
    const dir = onlySession(r.sessionsDir);
    const saved = logLines(dir).filter((line) => line.type === "screen");
    expect(saved).toHaveLength(3);
    expect.soft(saved[0]).toMatchObject({ start: 1, ocrFailed: true });
    expect(saved[0]).not.toHaveProperty("lines");
    expect(saved[1]).toMatchObject({ start: 2, lines: [] });
    expect(saved[1]).not.toHaveProperty("ocrFailed");
    const name = saved[0]!.image;
    if (typeof name !== "string") throw new Error("画像の保存先が必要");
    expect(readFileSync(join(dir, "screens", name))).toEqual(Buffer.from("jpeg-bytes"));
    expect(notices(r)).toEqual(["共有画面の文字を読めなかった画面: 1 / 2 枚"]);
  }).pipe(Effect.scoped));

  it.live("ライブの stop で失敗数を知らせ、新しいセッションへ数を持ち越さない", () => Effect.gen(function* () {
    const script: Script = { remarks: [], hold: true, events: screens };
    const r = yield* resource(script, fakeUpdater(), { attempts: [script, { remarks: [], hold: true }] });
    yield* r.cli(["start", "--app", "us.zoom.xos", "--no-audio"]);
    yield* Effect.promise(() => vi.waitFor(() => expect(sessionLog(r.sessionsDir).filter((line) => line.type === "screen")).toHaveLength(3)));
    yield* r.cli(["stop"]);
    expect.soft(notices(r)).toEqual(["共有画面の文字を読めなかった画面: 1 / 2 枚"]);
    r.deps.stderr.length = 0;
    yield* r.cli(["start", "--app", "us.zoom.xos", "--no-audio", "--no-screen"]);
    yield* r.cli(["stop"]);
    expect(notices(r)).toEqual([]);
  }).pipe(Effect.scoped));

  it.live.each(["stop", "Ctrl-C"] as const)("録画を %s で終えると保存前の先読み画像を数えず、一度だけ知らせる", (ending) => Effect.gen(function* () {
    const updating = yield* Deferred.make<void>();
    const stopRequested = yield* Deferred.make<void>();
    const client = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, (http) =>
      HttpClient.tapRequest(http, (request) => request.url.endsWith("/session/stop")
        ? Effect.asVoid(Deferred.succeed(stopRequested, undefined)) : Effect.void))).pipe(Layer.provide(NodeHttpClient.layerUndici));
    const r = yield* resource({
      remarks: [], hold: true,
      events: [...screens, { type: "screen", start: 100, image: SCREEN_IMAGE, ocrFailed: true },
        ...remarkEvents(first), ...remarkEvents({ start: 10, end: 12, text: "次の発言です" })],
    }, fakeUpdater(() => Effect.gen(function* () {
      yield* Deferred.succeed(updating, undefined);
      yield* Deferred.await(stopRequested);
    })), { cli: { httpClient: client } });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* Deferred.await(updating);
    if (ending === "stop") {
      yield* r.cli(["stop"]);
      yield* Fiber.join(running);
    } else {
      yield* Fiber.interrupt(running);
    }
    expect(sessionLog(r.sessionsDir).filter((line) => line.type === "screen").map((line) => line.start)).toEqual([1, 2, 3]);
    expect(notices(r)).toEqual(["共有画面の文字を読めなかった画面: 1 / 2 枚"]);
  }).pipe(Effect.scoped));

  it.live.each(["recorded", "live"] as const)("%s で OCR 失敗が無ければ終了通知を出さない", (mode) => Effect.gen(function* () {
    const events = [{ type: "screen", start: 1, image: SCREEN_IMAGE, lines: [] }];
    const r = yield* resource({ remarks: [], events, hold: mode === "live" });
    if (mode === "recorded") yield* r.cli(["recorded", r.file]);
    else {
      yield* r.cli(["start", "--app", "us.zoom.xos", "--no-audio"]);
      yield* Effect.promise(() => vi.waitFor(() => expect(sessionLog(r.sessionsDir).filter((line) => line.type === "screen")).toHaveLength(1)));
      yield* r.cli(["stop"]);
    }
    expect(sessionLog(r.sessionsDir).filter((line) => line.type === "screen")).toHaveLength(1);
    expect(notices(r)).toEqual([]);
  }).pipe(Effect.scoped));
});

describe("cli recorded <file>", () => {
  it.live("recorded --criteria は空行を除いた記載順の軸をモデル入力と開始ログへ渡す", () => Effect.gen(function* () {
    const calls: DiffInput[] = [];
    const r = yield* resource(THREE, fakeUpdater((input) => Effect.sync(() => { calls.push(input); })));
    const file = join(r.root, "criteria.txt");
    writeFileSync(file, " 採用のしやすさ \r\n\r\n運用負荷\n");
    yield* r.cli(["recorded", r.file, "--criteria", file]);
    const criteria = ["採用のしやすさ", "運用負荷"];
    expect(calls.length).toBeGreaterThan(0);
    for (const input of calls) expect(input).toHaveProperty("criteria", criteria);
    expect(logLines(onlySession(r.sessionsDir)).find((line) => line.type === "start")).toHaveProperty("criteria", criteria);
  }).pipe(Effect.scoped));

  it.live("ファイルを渡すと、進み具合の行と、フォルダとmap.*のパスが出る", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    // 相対パスで渡しても、サーバー（作業フォルダが違う）には絶対パスで渡る
    yield* r.cli(["recorded", relative(process.cwd(), r.file)]);

    const dir = onlySession(r.sessionsDir);

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

    it.live("音声のトラックが 2 本あると、最初のトラックだけを使ったことと --self を使えることを標準エラーに 1 回出す", () => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, audioTracks: 2 }, fakeUpdater(), { fileName: "meeting.mp4" });
      yield* r.cli(["recorded", r.file]);

      const notice = formatAudioTracksNotice(2);
      // 文面は本番の formatter とは別に確かめる（最初のトラックだけを使ったことと、--self を使えること）
      expect(notice).toContain("最初のトラックだけを使いました");
      expect(notice).toContain("--self");
      expect(stderrLines(r).filter((l) => l === "音声のトラックが 2 本あります。最初のトラックだけを使いました（分けたいときは --self を使えます）")).toHaveLength(1);
      expect(stderrLines(r).filter((l) => l === notice)).toHaveLength(1);
    }).pipe(Effect.scoped));

    it.live("音声のトラックが 1 本なら、知らせは出ない", () => Effect.gen(function* () {
      const r = yield* resource({ ...THREE, audioTracks: 1 }, fakeUpdater(), { fileName: "meeting.mp4" });
      yield* r.cli(["recorded", r.file]);

      const output = r.deps.stderr.join("");
      expect(output).not.toContain("--self");
      expect(output).not.toContain(formatAudioTracksNotice(2));
    }).pipe(Effect.scoped));
  });

  describe("--self（自分用の録音を足して、ライブと同じ 2 トラックで組む）", () => {
    type SpokenRemark = { start: number; end: number; text: string };
    // ヘルパーは、録画の文字起こしでは partial → remark の順に出す。duplicate は 自分 の重複の印
    const spoken = (track: "相手" | "自分", r: SpokenRemark, duplicate = false): unknown[] => [
      { type: "partial", track, ...r, duplicate },
      { type: "remark", track, ...r, duplicate },
    ];

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

    it.live("--self とメインの相対パスを絶対パスにして HTTP 要求へ渡す", () => Effect.gen(function* () {
      const r = yield* resource(INTERLEAVED);
      yield* r.cli(["recorded", relative(process.cwd(), r.file), "--self", relative(process.cwd(), r.selfFile)]);

      expect(r.requests.filter((request) => request.url.endsWith("/session/recorded")).map((request) => request.body)).toEqual([
        expect.objectContaining({ file: resolve(r.file), selfFile: resolve(r.selfFile) }),
      ]);
    }).pipe(Effect.scoped));

    it.live("--self だけを渡す（メインのファイルが無い）と断る。引数の誤りとして返る", () => Effect.gen(function* () {
      const r = yield* resource(INTERLEAVED);
      const result = yield* Effect.result(r.cli(["recorded", "--self", r.selfFile]));

      expect(Result.isFailure(result)).toBe(true);
    }).pipe(Effect.scoped));

    it.live("--self に存在しないファイルを渡すと断る。引数の誤りとして返る", () => Effect.gen(function* () {
      const r = yield* resource(INTERLEAVED);
      const result = yield* Effect.result(r.cli(["recorded", r.file, "--self", join(r.root, "absent.m4a")]));

      expect(Result.isFailure(result)).toBe(true);
    }).pipe(Effect.scoped));
  });

  it.live("--title を HTTP 要求の題名へ渡す", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* r.cli(["recorded", r.file, "--title", "週次会議"]);
    expect(r.requests.find((request) => request.url.endsWith("/session/recorded"))?.body).toMatchObject({ title: "週次会議" });
  }).pipe(Effect.scoped));

  it.live("--title を省くと、HTTP 要求の題名も省く", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* r.cli(["recorded", r.file]);
    const body = r.requests.find((request) => request.url.endsWith("/session/recorded"))?.body;
    expect(body).toMatchObject({ file: resolve(r.file) });
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("selfFile");
  }).pipe(Effect.scoped));

  it.live.each([0, 1])("ヘルパーが接続前コード%sで落ち続けて諦めると、CLIは進んだ位置と最後の標準エラーを出して失敗する", (code) => Effect.gen(function* () {
    const updating = yield* Deferred.make<void>();
    const releaseUpdate = yield* Deferred.make<void>();
    const first: Script = { ...THREE, remarks: THREE.remarks.slice(0, 2), exit: { code: 1, signal: null } };
    const r = yield* resource(first, fakeUpdater(() => Effect.andThen(Deferred.succeed(updating, undefined), Deferred.await(releaseUpdate))), {
      attempts: [first, { remarks: [], failLaunch: true, launchExit: { code, signal: null } }, { remarks: [], failLaunch: true, launchExit: { code, signal: null } }],
    });
    const running = yield* Effect.forkChild(Effect.result(r.cli(["recorded", r.file])));
    yield* Deferred.await(updating);
    yield* Effect.promise(() => vi.waitFor(() => expect(sessionLog(r.sessionsDir).some((line) => line.type === "intake-gave-up")).toBe(true)));
    yield* Deferred.succeed(releaseUpdate, undefined);
    const result = yield* Fiber.join(running);
    const dir = onlySession(r.sessionsDir);
    expect(Result.isFailure(result)).toBe(true);
    expect(r.deps.stdout.join("")).toContain(join(dir, "map.md"));
    expect(r.deps.stderr.join("")).toContain("起動できない");
    expect(failureText(result)).toContain(`（${code}）`);
    expect(failureText(result)).toContain(formatRecordedPosition(600, 3484));
    expect(failureText(result)).toContain("文字起こしのヘルパーが落ち続け、起動し直しを諦めました");
  }).pipe(Effect.scoped));

  it.live("Ctrl-Cで/session/stopを送り、map.*のパスを出し、statusはセッションなしになる", () => Effect.gen(function* () {
    const requests: string[] = [];
    const stopRequested = yield* Deferred.make<void>();
    const client = Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, (http) =>
      HttpClient.tapRequest(http, (request) => Effect.gen(function* () {
        requests.push(request.url);
        if (request.url.endsWith("/session/stop")) yield* Deferred.succeed(stopRequested, undefined);
      })))).pipe(Layer.provide(NodeHttpClient.layerUndici));
    // 2 回目の差分更新は、stop の印が立つまで終わらない。3 発言目は溜まったまま
    const updater = fakeUpdater((_input, call) => call === 2 ? Effect.suspend(() => Deferred.await(stopRequested)) : Effect.void);
    const r = yield* resource(THREE, updater, { cli: { httpClient: client } });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForRemarks(r.sessionsDir, 2);
    // 実行中のセッションは status に出る（フォルダつき）
    const dir = onlySession(r.sessionsDir);
    const during = cliDependencies(r.sessionsDir, r.server.port);
    yield* runCli(["status"]).pipe(Effect.provide(during.layer));
    expect(during.stdout.join("")).toContain("動いている");
    expect(during.stdout.join("")).toContain(`セッションのフォルダ: ${dir}`);

    yield* Fiber.interrupt(running);

    expect(requests.filter((url) => url.endsWith("/session/stop"))).toHaveLength(1);
    expect(r.deps.stdout.join("")).toContain(join(dir, "map.md"));
    const after = cliDependencies(r.sessionsDir, r.server.port);
    yield* runCli(["status"]).pipe(Effect.provide(after.layer));
    expect(after.stdout.join("")).toContain("セッションなし");
  }).pipe(Effect.scoped));

  it.live("ライブのセッションの最中は、先にstopを求める文面で断る", () => Effect.gen(function* () {
    const r = yield* resource({ remarks: [], hold: true });
    yield* r.cli(["start", "--app", "us.zoom.xos", "--no-audio", "--no-screen"]);
    const result = yield* Effect.result(r.cli(["recorded", r.file]));
    expect(Result.isFailure(result)).toBe(true);
    expect(String(Result.isFailure(result) ? result.failure : "")).toContain("セッションが進行中です（先に stop）");

    yield* r.cli(["stop"]);
  }).pipe(Effect.scoped));

  it.live("録画からのセッションの最中は、ライブの start も別の recorded も断る。resume も断る", () => Effect.gen(function* () {
    const stopSeen = { current: undefined as Deferred.Deferred<void> | undefined };
    // 最初の差分更新が終わらず、セッションが続いている間に別の入口を試す
    const updater = fakeUpdater(() => Effect.suspend(() => Deferred.await(stopSeen.current!)));
    const r = yield* resource({ ...THREE, hold: true }, updater);
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

    yield* r.cli(["stop"]);
    yield* Fiber.join(running).pipe(Effect.ignore);
  }).pipe(Effect.scoped));
  it.live("--vocab の空行と空白を除き、解決したモデルと HTTP 要求へ渡す", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    const vocab = join(r.root, "vocab.txt");
    writeFileSync(vocab, "ヤマダ商事\n\n  アルファ \n");
    yield* r.cli(["recorded", r.file, "--vocab", vocab]);
    expect(r.requests.find((request) => request.url.endsWith("/session/recorded"))?.body).toMatchObject({ vocab: ["ヤマダ商事", "アルファ"], model: { route: "claude", local: false } });
  }).pipe(Effect.scoped));

  it.live("進み具合はセッションに入れた位置を出し、先読みした位置は出さない", () => Effect.gen(function* () {
    const gate = Effect.runSync(Deferred.make<void>());
    const updater = fakeUpdater((_input, call) => call === 1 ? Deferred.await(gate) : Effect.void);
    const r = yield* resource({ ...THREE, hold: true }, updater);
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForRemarks(r.sessionsDir, 1);
    const eventually = (assertion: () => void) => Effect.promise(() => vi.waitFor(assertion, { timeout: 10_000 }));
    // 1 つ目の差分更新が終わらない間に、先の発言の途中結果と、その後ろの全体の長さが届く。サーバーは 1 件ずつ順に処理するので、
    // 全体の長さの進み具合が標準エラーに出たなら、その前の途中結果の処理は終わっている
    r.helpers.feed({ type: "partial", track: "相手", start: 800, end: 810, text: "先読みの途中結果です" });
    r.helpers.feed({ type: "file-duration", duration: 3485 });
    yield* eventually(() => { expect(r.deps.stderr.join("")).toContain("/ 58:05"); });

    const early = r.deps.stderr.join("").replaceAll("\r", "\n");
    expect(early).not.toContain("10:00 /");
    expect(early).not.toContain("12:30 /");
    yield* Deferred.succeed(gate, undefined);
    yield* waitForRemarks(r.sessionsDir, 3);
    yield* eventually(() => { expect(r.deps.stderr.join("").replaceAll("\r", "\n")).toContain("12:30 / 58:05  マップの更新 3 回"); });
    yield* r.cli(["stop"]);
    yield* Fiber.join(running).pipe(Effect.ignore);
  }).pipe(Effect.scoped));

  it.live("finishedが無いままイベント列が閉じたら、CLIは失敗の文面を出す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    writeFileSync(join(root, "meeting.m4a"), "audio");
    const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ type: "started", dir: root, warnings: [] }) + "\n"))));
    const deps = cliDependencies(root, 0, { httpClient: Layer.succeed(HttpClient.HttpClient, client) });
    const result = yield* Effect.result(within(runCli(["recorded", join(root, "meeting.m4a")]).pipe(Effect.provide(deps.layer))));
    expect(Result.isFailure(result)).toBe(true);
    expect(failureText(result)).toContain("録画からのセッションが終わる前に接続が終了しました");
  }).pipe(Effect.scoped));

  it.live("開始の応答を受け取った後、started を読む前の Ctrl-C でも、停止を求めて map.* を書き出し、status はセッションなしになる", () => Effect.gen(function* () {
    const stalled = stalledRecordedBody();
    const r = yield* resource({ ...THREE, hold: true }, fakeUpdater(), { cli: { httpClient: stalled.layer } });
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* Deferred.await(stalled.bodyRequested).pipe(Effect.timeout("10 seconds"));
    yield* Fiber.interrupt(running);

    const dir = onlySession(r.sessionsDir);
    const after = cliDependencies(r.sessionsDir, r.server.port);
    yield* runCli(["status"]).pipe(Effect.provide(after.layer));
    expect(after.stdout.join("")).toContain("セッションなし");
    // started を読めていないので、フォルダは出さず map.* のパスだけを出す
    expect(r.deps.stdout.join("")).toContain(join(dir, "map.md"));
  }).pipe(Effect.scoped));

  it.live("--model は名前で解決したモデルを HTTP 要求へ渡す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const config = join(root, "named.config.json");
    writeFileSync(config, JSON.stringify({ models: { fast: { route: "claude", model: "claude-haiku-5-5" } } }));
    const r = yield* resource(THREE, fakeUpdater(), { cli: { env: { LIVE_MINDMAP_CONFIG: config } } });
    yield* r.cli(["recorded", r.file, "--model", "fast"]);
    expect(r.requests.find((request) => request.url.endsWith("/session/recorded"))?.body).toMatchObject({ model: { name: "fast", route: "claude", model: "claude-haiku-5-5", local: false } });
  }).pipe(Effect.scoped));

  it.live("--judge は環境変数と設定より優先され、解決した判定のモデルを HTTP 越しに準備へ渡す", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const config = join(root, "judge.config.json");
    const judge: JudgeModel = { name: "meeting-judge", route: "system-one", apiKeyEnv: "MEETING_JUDGE_KEY", url: "https://judge.invalid/systemone", model: "meeting", timeoutMs: 3500 };
    const { name, ...definition } = judge;
    writeFileSync(config, JSON.stringify({ judge: "jev", judges: { [name]: definition } }));
    const r = yield* resource(THREE, fakeUpdater(), { cli: { env: { LIVE_MINDMAP_CONFIG: config, LIVE_MINDMAP_JUDGE: "clef" } } });
    yield* r.cli(["recorded", r.file, "--judge", name]);

    expect(r.requests.filter((request) => request.url.endsWith("/session/recorded")).map((request) => request.body)).toEqual([
      expect.objectContaining({ model: defaultClaude, judge }),
    ]);
    expect(r.prepared).toEqual([{ kind: "routed", judge }]);
  }).pipe(Effect.scoped));

  it.live("--judge off は環境変数の判定を使わず、judge の無い本文で録画を完了する", () => Effect.gen(function* () {
    const r = yield* resource(THREE, fakeUpdater(), { cli: { env: { LIVE_MINDMAP_JUDGE: "clef" } } });
    yield* r.cli(["recorded", r.file, "--judge", "off"]);

    const bodies = r.requests.filter((request) => request.url.endsWith("/session/recorded")).map((request) => request.body);
    expect(bodies).toEqual([expect.objectContaining({ model: defaultClaude })]);
    expect(bodies[0]).not.toHaveProperty("judge");
    expect(r.prepared).toEqual([{ kind: "single", model: defaultClaude }]);
    expect(r.deps.stdout.join("")).toContain(join(onlySession(r.sessionsDir), "map.md"));
  }).pipe(Effect.scoped));

  it.live("判定を省くと jev を送り、準備の鍵なし通知を開始時に 1 行だけ表示して録画を完了する", () => Effect.gen(function* () {
    const notice = missingKeyNotice({ name: "jev" }, ["TYPESAFE_AI_API_KEY"]);
    const r = yield* resource(THREE, fakeUpdater(), { notice, cli: { env: { LIVE_MINDMAP_JUDGE: undefined } } });
    yield* r.cli(["recorded", r.file]);

    expect(r.requests.filter((request) => request.url.endsWith("/session/recorded")).map((request) => request.body)).toEqual([
      expect.objectContaining({ judge: { name: "jev", route: "system-one", apiKeyEnv: "TYPESAFE_AI_API_KEY", timeoutMs: 1000 } }),
    ]);
    const lines = r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((line) => line.trim() !== "");
    expect(lines.filter((line) => line === notice)).toHaveLength(1);
    expect(lines[0]).toBe(notice);
    expect(r.deps.stdout.join("")).toContain(join(onlySession(r.sessionsDir), "map.md"));
  }).pipe(Effect.scoped));

  it.live("ローカルモードで環境変数にクラウドの判定を明示すると、録画の開始要求を送る前に断る", () => Effect.gen(function* () {
    const r = yield* resource(THREE, fakeUpdater(), { cli: { apple: availableApple, env: { LIVE_MINDMAP_JUDGE: "jev" } } });
    const result = yield* Effect.result(r.cli(["recorded", r.file, "--local"]));

    expect(Result.isFailure(result)).toBe(true);
    expect(r.requests.filter((request) => request.url.endsWith("/session/recorded"))).toEqual([]);
    expect(r.prepared).toEqual([]);
  }).pipe(Effect.scoped));

  it.live("ローカルモードで判定を省くと、Apple の single で録画を完了する", () => Effect.gen(function* () {
    const r = yield* resource(THREE, fakeUpdater(), { cli: { apple: availableApple, env: { LIVE_MINDMAP_JUDGE: undefined } } });
    yield* r.cli(["recorded", r.file, "--local"]);

    const model = { name: "apple", route: "apple", local: true };
    const bodies = r.requests.filter((request) => request.url.endsWith("/session/recorded")).map((request) => request.body);
    expect(bodies).toEqual([expect.objectContaining({ model })]);
    expect(bodies[0]).not.toHaveProperty("judge");
    expect(r.prepared).toEqual([{ kind: "single", model }]);
    expect(r.deps.stdout.join("")).toContain(join(onlySession(r.sessionsDir), "map.md"));
  }).pipe(Effect.scoped));

  it.live("判断軸のあるローカル録画は軸を保存し、関係づけを行わないことを開始時に一度知らせる", () => Effect.gen(function* () {
    const r = yield* resource(THREE, fakeUpdater(), { cli: { apple: availableApple, env: { LIVE_MINDMAP_JUDGE: undefined } } });
    const file = join(r.root, "criteria.txt");
    writeFileSync(file, "採用のしやすさ\n");
    yield* r.cli(["recorded", r.file, "--local", "--criteria", file]);
    expect(r.deps.stderr.join("").split("\n").filter((line) => line.includes("判断軸"))).toHaveLength(1);
    expect(logLines(onlySession(r.sessionsDir)).find((line) => line.type === "start")).toHaveProperty("criteria", ["採用のしやすさ"]);
  }).pipe(Effect.scoped));

  it.live("share は録画からのセッションの最中も URL を出す", () => Effect.gen(function* () {
    const tunnel = fakeTunnel();
    const stopSeen = { current: undefined as Deferred.Deferred<void> | undefined };
    const updater = fakeUpdater(() => Effect.suspend(() => Deferred.await(stopSeen.current!)));
    const r = yield* resource({ ...THREE, hold: true }, updater, { viewing: tunnel.viewing });
    stopSeen.current = r.helpers.stopSeen;
    const running = yield* Effect.forkChild(r.cli(["recorded", r.file]));
    yield* waitForRemarks(r.sessionsDir, 1);

    const shared = cliDependencies(r.sessionsDir, r.server.port);
    yield* runCli(["share", "--anyone"]).pipe(Effect.provide(shared.layer));
    expect(shared.stdout.join("")).toContain(FAKE_TUNNEL_HOST);

    yield* r.cli(["stop"]);
    yield* Fiber.join(running).pipe(Effect.ignore);
  }).pipe(Effect.scoped));
});

// ヘルパーだけが落ちたときの起動し直し（Issue #1093）。ライブと同じ判断（60 秒・3 回）で、サーバーが最後に作った発言の end から読み直す。
// 偽のヘルパーは、起動の回ごとの台本（attempts）に従って流す。偽の読み直しは頭から全部を流すので、
// 開始位置（--from）より前の結果をサーバーが捨てることを、発言が重ならず抜けもないことで確かめる
describe("cli recorded <file> ヘルパーが落ちたとき", () => {
  const stderrLines = (r: { deps: { stderr: string[] } }) => r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((line) => line.trim() !== "");
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

    expect(stderrLines(r).filter((l) => l === formatAudioTracksNotice(2))).toHaveLength(1);
    expect(stderrLines(r).filter((l) => l === formatScreenOffNotice())).toHaveLength(1);
  }).pipe(Effect.scoped));

  it.live("最初の起動に失敗したら、CLI は開始の失敗を返す", () => Effect.gen(function* () {
    const r = yield* resource({ ...THREE, failLaunch: true });
    const result = yield* Effect.result(within(r.cli(["recorded", r.file])));

    expect(Result.isFailure(result)).toBe(true);
    expect(failureText(result)).toContain("起動できない");
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

// 動画の映像を共有画面として使う（Issue #1090）。本物のヘルパーは、映像の判定と OCR を文字起こしと並べて先に済ませるので、
// 共有画面の変化と screen-off は、発言よりも先に届く。それでも発言と同じ音声の時刻の順でセッションに入り、語彙も映った後の発言から効く
describe("cli recorded <file> 動画の映像", () => {
  const stderrLines = (r: { deps: { stderr: string[] } }) => r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((l) => l.trim() !== "");

  it.live("映像が読めない（screen-off）ことは、標準エラーに知らせの 1 行がちょうど 1 回出る", () => Effect.gen(function* () {
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
  const stderrLines = (r: { deps: { stderr: string[] } }) => r.deps.stderr.join("").replaceAll("\r", "\n").split("\n").filter((l) => l.trim() !== "");
  // 進み具合の行が出す「次に試す時刻」（地方時の時:分）。時は 1 桁でも 2 桁でも含まれる
  const localClock = (ms: number) => {
    const date = new Date(ms);
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  const pausedLine = (r: { deps: { stderr: string[] } }, reason: string, retryAt: number) =>
    stderrLines(r).some((line) => line.includes(reason) && line.includes(localClock(retryAt)));

  // 1 回目の差分更新（r1）が一時停止する。時刻は仮想時計の 0 から数える
  const RETRY_AT = 2 * 3_600_000 + 37 * 60_000;

  it.effect("一時停止の進み具合に理由と次に試す時刻が出て、再開すると理由が消える", () => withVirtualClock((pending) => Effect.gen(function* () {
    const updater = fakeUpdater((_input, call) => call === 1 ? Effect.fail(new DiffUpdatePaused({ reason: CHATGPT, message: CHATGPT, retryAt: RETRY_AT })) : Effect.void);
    const r = yield* resource({ ...THREE, hold: true }, updater);
    const running = yield* r.cli(["recorded", r.file]).pipe(Effect.forkChild);

    yield* eventually(() => pausedLine(r, CHATGPT, RETRY_AT), "進み具合の行に、理由と次に試す時刻が出る");
    yield* eventually(() => pending.includes(RETRY_AT), "再試行の時刻待ち");
    yield* TestClock.adjust(RETRY_AT);
    yield* r.helpers.end;
    yield* runToEnd(Fiber.join(running));
    // 再開した後の進み具合の行には、理由が出ない
    const lines = stderrLines(r);
    expect(lines.at(-1)).toBe("12:30 / 58:04  マップの更新 3 回");
    expect(lines.at(-1)).not.toContain(CHATGPT);
  })).pipe(Effect.scoped), 60_000);

  it.live("一時停止がなければ、進み具合に理由は出ない", () => Effect.gen(function* () {
    const r = yield* resource(THREE);
    yield* r.cli(["recorded", r.file]);
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
