#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
// 使い方は各 Command・Flag の withDescription が正本で、`live-mindmap --help` で読む（ADR 0010）。
import { basename, dirname, join, resolve } from "node:path";
import { NodeChildProcessSpawner, NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { AppleIntelligence, appleCommand } from "./appleIntelligence.ts";
import { Clock, Console, Effect, FileSystem, Layer, Option, PlatformError, Predicate, Result, Schedule, Schema, Stream, type Runtime } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { Argument, Command, Flag } from "effect/cli";
import { AudioMix } from "./audioMix.ts";
import { MapCapture } from "./capture.ts";
import { Playwright } from "./playwright.ts";
import { cloudflareAccountIdConfig, cloudflareApiTokenConfig, depsDirConfig, portConfig, sessionsDirConfig, shareAllowConfig } from "./config.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { StdoutIsTty, withoutFinalNewline } from "./consoleText.ts";
import { loginChatgpt } from "./chatgptAuth.ts";
import { logoutChatgpt, ChatgptUnavailable } from "./chatgptAuthStore.ts";
import { needsTransferToken, planBody, planLayer, planModel, resolvePlan, type UpdatePlan } from "./updatePlan.ts";
import { UpdaterUnavailable } from "./updaterUnavailable.ts";
import { configuredModels, ModelRefused, resolveModelCandidate } from "./modelConfig.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { MODEL_TRANSFER_HEADER, readModelTransferToken } from "./modelTransferToken.ts";
import {
  formatIntakeStatus,
  formatShareAlreadyOpen,
  formatShareOpened,
  formatShareStatus,
  SHARE_OPEN_OUTCOME_HEADER,
  ShareOpenOutcome,
  formatPoolTable,
  formatTable,
  forgetPoolWord,
  DiffEvent,
  DiffUpdater,
  fromTranscript,
  JsonExport,
  LogEvent,
  RecordedEvent,
  RemarkEvent,
  formatAudioTracksNotice,
  formatScreenOffNotice,
  formatSpeakerOffNotice,
  formatRecordedPosition,
  formatRecordedProgress,
  type RecordedProgress,
  ScreenEvent,
  ScreenOffEvent,
  StartEvent,
  PUBLISH_DEFAULT_DAYS,
  PUBLISH_MAX_ASSET_BYTES,
  PUBLISH_CONTENTS,
  PUBLISH_MAX_DAYS,
  formatPublishList,
  type PublishRecord,
  selectListedRecords,
  expiredPublishedRecords,
  publishConfirmationMessage,
  generatePassphrase,
  lockedPublishPage,
  publishWorkerScript,
  sealWithPassphrase,
  replaceHeadForPublish,
  VocabEvent,
  SessionLog,
  playback,
  type PlaybackRemark,
  type PlaybackScreen,
  restoreSession,
  restoreState,
  toMarkdown,
  TranscriptFile,
  type IntakeStatusReport,
  type Run,
  type Snapshot,
  type DiffUpdateFrame,
} from "./core/index.ts";
import { COMMON_WORDS_PATH, loadCommonWords } from "./commonWords.ts";
import { withReplayCorrection } from "./replayCorrection.ts";
import { openListener, serveFeed } from "./http.ts";
import { resolveHelperPath } from "./helperPath.ts";
import { BrokenLogLine, readLogLines } from "./logLines.ts";
import { poolUnavailableMessage, readPool, updatePoolFromLog, vocabularyPoolPath, writePool } from "./vocabularyPool.ts";
import { accountSubdomain, CloudflareFailed, deleteWorker, deployWorker, describeCloudflareFailure, listWorkerNames, newWorkerName, workerUrl, type CloudflareCredentials } from "./cloudflareWorkers.ts";
import { appendPublishRecord, markRecordStatus, readPublishRecords } from "./publishRecords.ts";
import { renderReviewPages, ReviewBuild, type ReviewVariant, writeReviewPages } from "./review.ts";
import { ScreenJpeg } from "./screenJpeg.ts";
import { parseSlides, slideChanges } from "./screenSlides.ts";
import {
  createSessionDir,
  EXPORT_FILE,
  LOG_FILE,
  openLoggedSession,
  SCREENS_DIR,
  reviewVariants,
  reviewWarning,
  selfReviewVariants,
  writeExportsAndCapture,
  writeReviews,
} from "./sessionFiles.ts";
import { describe, fileReason, formatIssues, InvalidTruthFile, oneLine, readScreenTruthFile, readTextFile, readTruthFile } from "./truthFile.ts";
import { Viewers } from "./viewers.ts";
import { StartupRefusal } from "./managedDepsProtocol.ts";
import { ServerRoutes, type ServerRoute } from "./serverProtocol.ts";
import { checkManagedDeps, requireStartupDeps, startupPreparationFailure } from "./managedDepsCheck.ts";
import { exitCodeTeardown, reportEntryFailure } from "./entryFailure.ts";
import { StartupDepsMissing } from "./startupDepsMissing.ts";
import { planServerStop, readServerPid, removeServerPid, ServerProcess } from "./serverProcess.ts";

// server/package.json は private で version を持たないので、--version の正本はここに置く
const VERSION = "0.1.0";

/* ----------------------------------------------------------------------------
 * 失敗: サブコマンドの中身の失敗はタグ付きにし、入口の表 1 つで日本語の 1 行に変える
 * -------------------------------------------------------------------------- */

class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()("ServerUnreachable", {}) {}
class ServerFailed extends Schema.TaggedError<ServerFailed>()("ServerFailed", { message: Schema.String }) {}
// NDJSON を読んでいる最中に、サーバーとの接続が失われた。入口の失敗の表には載せず、読んだ側（recorded・install）が自分の失敗に変える
class ServerStreamClosed extends Schema.TaggedError<ServerStreamClosed>()("ServerStreamClosed", { reason: Schema.String }) {}
class RequiredDepsMissing extends Schema.TaggedError<RequiredDepsMissing>()("RequiredDepsMissing", {}) {}
class NoSession extends Schema.TaggedError<NoSession>()("NoSession", { sessionsDir: Schema.String }) {}
class MissingRunExport extends Schema.TaggedError<MissingRunExport>()("MissingRunExport", { path: Schema.String }) {}
class InvalidTranscriptFile extends Schema.TaggedError<InvalidTranscriptFile>()("InvalidTranscriptFile", {
  path: Schema.String,
  reason: Schema.String,
}) {}
// 下位のモジュール（配信・再生・ファイルの読み書き）の失敗。message はそのまま入口の 1 行になる
class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", { message: Schema.String }) {}

// ログの行を type で選ぶ集合（decode は LogEvent のまま）
const typesOf = (events: readonly { readonly fields: { readonly type: { readonly literal: string } } }[]): ReadonlySet<string> => new Set(events.map((event) => event.fields.type.literal));
const hasLoggedType = (types: ReadonlySet<string>) => (event: unknown): event is { readonly type: string } =>
  Predicate.isObject(event) && "type" in event && Predicate.isString(event.type) && types.has(event.type);
// 録音済みセッションを読むとき（題名・発言・画面）
const isReplayedEvent = hasLoggedType(typesOf([StartEvent, RemarkEvent, VocabEvent, ScreenEvent, ScreenOffEvent]));
// evaluate が読むとき（題名・発言・差分）
const isEvalEvent = hasLoggedType(typesOf([StartEvent, RemarkEvent, DiffEvent]));

// 入口で 1 行にする失敗の class
const CLI_FAILURES = [
  ServerUnreachable,
  ServerFailed,
  NoSession,
  MissingRunExport,
  InvalidTruthFile,
  InvalidTranscriptFile,
  BrokenLogLine,
  CommandFailed,
  UpdaterUnavailable,
  ChatgptUnavailable,
] as const;
type CliFailure = InstanceType<(typeof CLI_FAILURES)[number]>;

// 入口の表。タグ付きの失敗を、今までと同じ日本語の 1 行にする（表示はここだけが持つ）
const failureLine = (failure: CliFailure): string => {
  switch (failure._tag) {
    case "ServerUnreachable":
      return "サーバーにつながりません（pnpm dev で起動）";
    case "ServerFailed":
      return failure.message;
    case "NoSession":
      return `セッションがありません: ${failure.sessionsDir}`;
    case "MissingRunExport":
      return `セッションのマップがありません: ${failure.path}`;
    case "InvalidTruthFile":
      return `正解ファイルが不正です: ${failure.path}（${failure.reason}）`;
    case "InvalidTranscriptFile":
      return `文字起こしファイルが不正です: ${failure.path}（${failure.reason}）`;
    case "BrokenLogLine":
      return `${LOG_FILE} の ${failure.line} 行目が JSON として読めません: ${failure.reason}`;
    case "CommandFailed":
    case "UpdaterUnavailable":
    case "ChatgptUnavailable":
      return failure.message;
  }
};

const isCliFailure = (failure: unknown): failure is CliFailure => CLI_FAILURES.some((C) => failure instanceof C);

// decode の失敗を 1 行の理由にする。stop の paths のように [配列の名前, 件目, ...] の形で場所が分かるときは
// 「<名前>」の <n> 件目 を先頭に置く（人が直す場所を日本語で示す）
const decodeReason = (error: Schema.SchemaError): string =>
  oneLine(
    formatIssues(error.issue)
      .issues.map(({ message, path }) => {
        const keys = (path ?? []).map((segment) => (Predicate.isObject(segment) ? segment.key : segment));
        const [kind, index, ...rest] = keys;
        const item = Predicate.isString(kind) && Predicate.isNumber(index) ? `「${kind}」の ${index + 1} 件目` : undefined;
        const where = (item === undefined ? keys : rest).map(String).join(".");
        const at = [item, where === "" ? undefined : where].filter((part) => part !== undefined).join(" ");
        return at === "" ? message : `${at}: ${message}`;
      })
      .join(" / "),
  );

/* ----------------------------------------------------------------------------
 * 境界: 設定・標準出力・ファイル読み込み
 * -------------------------------------------------------------------------- */

// 標準出力。Console.log が末尾に改行を足すので、改行の規則（withoutFinalNewline）で末尾の 1 つを外して渡す
const write = (text: string) => Console.log(withoutFinalNewline(text));
const writeWarnings = (warnings: ReadonlyArray<string>) => Effect.forEach(warnings, (warning) => Console.error(warning), { discard: true });

// ファイル操作の失敗（PlatformError）を入口の 1 行にする。理由は OS のエラー（ENOENT など）の文面
const fileFailed = (e: PlatformError.PlatformError) => new CommandFailed({ message: fileReason(e) });
const orFileFailed = <A, E, R>(effect: Effect.Effect<A, E | PlatformError.PlatformError, R>) =>
  effect.pipe(Effect.catchIf(PlatformError.isPlatformError, (e) => Effect.fail(fileFailed(e))));

// 待ち受けの失敗（ServeError は message を持たないので cause から作る）を入口の 1 行にする
const listenFailed = (port: number, e: { readonly cause: unknown }) =>
  new CommandFailed({
    message: Predicate.hasProperty(e.cause, "code") && e.cause.code === "EADDRINUSE"
      ? `ポート ${port} は別のプロセスが使っています（LIVE_MINDMAP_PORT で変えられます）`
      : `ポート ${port} で待ち受けられません: ${describe(e.cause)}`,
  });

// パスの存在判定。親が通常ファイル（ENOTDIR）のときは「存在しない」。それ以外の失敗は PlatformError のまま返す
const pathExists = (fs: FileSystem.FileSystem, path: string) =>
  fs.exists(path).pipe(
    Effect.catchIf(
      (e) => PlatformError.isPlatformError(e) && Predicate.hasProperty(e.cause, "code") && e.cause.code === "ENOTDIR",
      () => Effect.succeed(false),
    ),
  );

// セッションのフォルダ（名前は開始時刻）のうち、file を持つ最新のもの
const latestSession = Effect.fn("latestSession")(function* (sessionsDir: string, file: string) {
  const fs = yield* FileSystem.FileSystem;
  const latest = (yield* pathExists(fs, sessionsDir))
    ? (yield* Effect.filter(yield* fs.readDirectory(sessionsDir), (d) => pathExists(fs, join(sessionsDir, d, file)))).sort().at(-1)
    : undefined;
  return latest === undefined ? yield* new NoSession({ sessionsDir }) : latest;
}, orFileFailed);

/* ----------------------------------------------------------------------------
 * セッションの保存・公開（ライブのセッションとも共有する）
 * -------------------------------------------------------------------------- */

/* ----------------------------------------------------------------------------
 * 常駐サーバーへの依頼（HTTP の境界）
 * -------------------------------------------------------------------------- */

const ServerErrorBody = Schema.Struct({ error: Schema.optionalKey(Schema.String) });
// 要求に添えるもの。本文は、記述が本文の Schema を持つ経路でだけ必須で、その Encoded 型で書く（欄を書き間違えると型エラー）。
// query は URL の ? 以降、headers は要求のヘッダー
type ServerRequestOptions<R extends ServerRoute> =
  & (R extends { readonly body: infer B extends Schema.Top } ? { readonly body: B["Encoded"] } : { readonly body?: never })
  & { readonly query?: Record<string, string>; readonly headers?: Record<string, string> };

// 本文を持つ経路では options を省けない（本文の型保証を、引数の省略で迂回させない）
type ServerRequestArgs<R extends ServerRoute> = R extends { readonly body: Schema.Top } ? [options: ServerRequestOptions<R>] : [options?: ServerRequestOptions<R>];

const executeServerRequest = Effect.fnUntraced(function* <R extends ServerRoute>(
  port: number,
  route: R,
  ...[options]: ServerRequestArgs<NoInfer<R>>
) {
  const client = yield* HttpClient.HttpClient;
  const query = options?.query === undefined ? "" : `?${new URLSearchParams(options.query).toString()}`;
  const base = HttpClientRequest.make(route.method)(`http://127.0.0.1:${port}${route.path}${query}`, { headers: options?.headers });
  const request = options?.body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, options.body);
  const response = yield* client.execute(request).pipe(Effect.mapError(() => new ServerUnreachable()));
  if (response.status < 200 || response.status >= 300) {
    // 応答の本文が JSON でなくても、状態コードから作る 1 行で伝えられるようにする
    const raw = yield* response.json.pipe(Effect.orElseSucceed((): unknown => ({})));
    const refusal = Schema.decodeUnknownResult(StartupRefusal)(raw);
    if (Result.isSuccess(refusal)) return yield* new StartupDepsMissing({ items: refusal.success.items });
    const reported = yield* Schema.decodeUnknownEffect(ServerErrorBody)(raw).pipe(
      Effect.orElseSucceed((): { readonly error?: string } => ({})),
    );
    return yield* new ServerFailed({ message: reported.error ?? `サーバーがエラーを返しました: ${response.status}` });
  }
  return response;
});

// 成功応答の本文を各コマンドの Schema で読む
const decodeServerBody = Effect.fnUntraced(function* <S extends Schema.Decoder<unknown>>(response: HttpClientResponse.HttpClientResponse, schema: S): Effect.fn.Return<S["Type"], ServerFailed, S["DecodingServices"]> {
  // 2xx でも、本文が JSON として読めなければ {} として各コマンドの Schema で読む（変更前の規則）。JSON の null は null のまま
  const parsed = yield* response.text.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.orElseSucceed((): unknown => ({})),
  );
  return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError((e) => new ServerFailed({ message: `サーバーの応答が読めません: ${decodeReason(e)}` })),
  );
});

// 常駐サーバーへ経路の記述で依頼を送り、成功応答を記述の response の Schema で読む
const requestServer = <R extends ServerRoute & { readonly response: Schema.Decoder<unknown> }>(
  port: number,
  route: R,
  ...args: ServerRequestArgs<NoInfer<R>>
): Effect.Effect<R["response"]["Type"], ServerUnreachable | ServerFailed | StartupDepsMissing, HttpClient.HttpClient> =>
  executeServerRequest(port, route, ...args).pipe(Effect.flatMap((response) => decodeServerBody(response, route.response)));

// 常駐サーバーが NDJSON で流す経過（1 行 1 イベント）を、届いた順に 1 件ずつ handle へ渡す。読めない行は ServerFailed、通信の失敗は ServerStreamClosed
const forEachServerEvent = <A, R>(
  response: HttpClientResponse.HttpClientResponse,
  route: { readonly response: Schema.Decoder<A> },
  handle: (event: A) => Effect.Effect<void, ServerFailed, R>,
) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) => Schema.decodeEffect(Schema.fromJsonString(route.response))(line).pipe(
      Effect.mapError((error) => new ServerFailed({ message: `サーバーの応答が読めません: ${decodeReason(error)}` })),
      Effect.flatMap(handle),
    )),
    Effect.catchIf((error) => !(error instanceof ServerFailed), (error) => Effect.fail(new ServerStreamClosed({ reason: String(error) }))),
  );

/* ----------------------------------------------------------------------------
 * サブコマンド
 * -------------------------------------------------------------------------- */

// slides.tsv を読み、行ごとの画像を JPEG にして play の Scope の一時フォルダへ 1 件ずつ書く。
// 変化の列は、再生が入れる直前にその一時ファイルを読む形で返す（全画像のバイト列を再生の終わりまで持たない）
const loadScreens = Effect.fn("loadScreens")(function* (tsv: string) {
  const text = yield* readTextFile(tsv).pipe(Effect.mapError((e) => new CommandFailed({ message: `${tsv} が読めません: ${fileReason(e)}` })));
  const rows = yield* Effect.fromResult(parseSlides(text)).pipe(Effect.mapError((reason) => new CommandFailed({ message: `${tsv} が不正です: ${reason}` })));
  const converter = yield* ScreenJpeg;
  const fs = yield* FileSystem.FileSystem;
  const jpegFailed = (path: string, reason: string) => new CommandFailed({ message: `${path} を JPEG にできません: ${reason}` });
  const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "live-mindmap-screens-" }).pipe(Effect.mapError((e) => new CommandFailed({ message: describe(e) })));
  const jpegPath = (index: number) => join(tmp, `${index}.jpg`);
  for (const [i, row] of rows.entries()) {
    const path = resolve(dirname(tsv), row.image);
    const bytes = yield* converter.toJpeg(path).pipe(Effect.mapError((e) => jpegFailed(path, e.message)));
    yield* fs.writeFile(jpegPath(i), bytes).pipe(Effect.mapError((e) => jpegFailed(path, e.message)));
  }
  return slideChanges(rows, (i) => fs.readFile(jpegPath(i)).pipe(Effect.mapError((e) => new CommandFailed({ message: `${jpegPath(i)} が読めません: ${e.message}` }))));
});

// raw と words が両方そろう行だけ、直し直す元として運ぶ（無い古い行は直さずに流す）
const replayableRemark = (decoded: (typeof RemarkEvent)["Type"]): PlaybackRemark =>
  decoded.raw !== undefined && decoded.words !== undefined ? { ...decoded.remark, raw: decoded.raw, words: decoded.words } : decoded.remark;

const recordedScreen = (fs: FileSystem.FileSystem, dir: string, decoded: (typeof ScreenEvent)["Type"], lineNo: number): Effect.Effect<PlaybackScreen<CommandFailed>, CommandFailed> => {
  const { start, image } = decoded;
  const recordedLines = decoded.lines === undefined ? {} : { lines: decoded.lines };
  if (image === null) return Effect.succeed({ start, image: null, ...recordedLines });
  // ログ由来の image は、screens/ 直下の単一のファイル名だけを認める（外のファイルを読まない）
  const screensDir = resolve(dir, SCREENS_DIR);
  const path = resolve(screensDir, image);
  // basename 比較で区切り文字を含む値（絶対パス・../・./）を、dirname 比較で ""・.・.. を拒否する
  if (basename(image) !== image || dirname(path) !== screensDir) {
    return Effect.fail(new CommandFailed({ message: `${LOG_FILE} ${lineNo} 行目の image が screens/ 直下のファイル名ではありません: ${image}` }));
  }
  return Effect.succeed({
    start,
    ...recordedLines,
    image: {
      id: image,
      load: fs.readFile(path).pipe(Effect.mapError((e) => new CommandFailed({ message: `${path} が読めません: ${e.message}` }))),
    },
  });
};

// セッションのフォルダ（log.jsonl を持つフォルダ）のログから、再生に渡す題名・発言・共有画面の変化を読む。
// 流すのは start（題名）・remark・screen・screen-off だけで、ほかの行（intake-*・diff など）は読み飛ばす。
// 画像は元のフォルダの screens/ から、入れる直前に読む。変化の時刻はログの start をそのまま使う
const loadSessionLog = Effect.fn("loadSessionLog")(function* (dir: string) {
  const logPath = join(dir, LOG_FILE);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* pathExists(fs, logPath).pipe(orFileFailed))) return yield* new CommandFailed({ message: `${LOG_FILE} がありません: ${logPath}` });
  const { lines, events } = yield* readLogLines(logPath).pipe(orFileFailed);
  let title: string | undefined;
  const remarks: PlaybackRemark[] = [];
  const vocabulary: (typeof VocabEvent)["Type"][] = [];
  const screens: PlaybackScreen<CommandFailed>[] = [];
  for (const [i, event] of events.entries()) {
    if (!isReplayedEvent(event)) continue;
    const decoded = yield* Schema.decodeUnknownEffect(LogEvent)(event).pipe(
      Effect.mapError((e) => new BrokenLogLine({ line: lines[i]?.no ?? 1, reason: decodeReason(e) })),
    );
    switch (decoded.type) {
      case "start":
        title ??= decoded.title;
        break;
      case "remark":
        remarks.push(replayableRemark(decoded));
        break;
      case "vocab":
        vocabulary.push(decoded);
        break;
      case "screen":
        screens.push(yield* recordedScreen(fs, dir, decoded, lines[i]?.no ?? 1));
        break;
      case "screen-off":
        screens.push({ start: decoded.start, reason: decoded.reason });
        break;
      case "diff":
        break;
    }
  }
  if (title === undefined) return yield* new CommandFailed({ message: `${LOG_FILE} に start の行がありません: ${logPath}` });
  return { title, remarks, screens, vocabulary };
});

const readTranscriptRemarks = Effect.fn("readTranscriptRemarks")(function* (transcript: string) {
  const text = yield* readTextFile(transcript).pipe(Effect.mapError((e) => new InvalidTranscriptFile({ path: transcript, reason: fileReason(e) })));
  const file = yield* Schema.decodeEffect(Schema.fromJsonString(TranscriptFile))(text).pipe(
    Effect.mapError((e) => new InvalidTranscriptFile({ path: transcript, reason: decodeReason(e) })),
  );
  return [...fromTranscript(file)];
});

// 無いパスは false（ファイルを渡す play の入口でも失敗にしない）
const isDirectory = Effect.fn("isDirectory")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(path)) && (yield* fs.stat(path)).type === "Directory";
}, orFileFailed);

const judgeFlag = Flag.String("judge").pipe(
  Flag.withDescription("判定のモデルの名前、または off（判定を使わない）。環境変数 LIVE_MINDMAP_JUDGE・設定の judge より優先。開始時に決め、途中で変えない"),
  Flag.optional,
);
const modelFlag = Flag.String("model").pipe(Flag.withDescription("設定した差分更新モデルの名前（環境変数・設定の既定値より優先）"), Flag.optional);
const localFlag = Flag.Boolean("local").pipe(Flag.withDescription("ローカルモードを求める（Apple Intelligence の子プロセスだけを使い、会議の中身を Mac の外に出さない。--model は apple だけ組み合わせられる）"), Flag.withDefault(false));

const recordPlayback = Effect.fn("recordPlayback")(function* (
  input: { title: string; remarks: Iterable<PlaybackRemark>; screens: Iterable<PlaybackScreen<CommandFailed>>; realtime: boolean; vocabulary?: ReadonlyArray<(typeof VocabEvent)["Type"]> },
  model: ExecutableModel,
  publish: (snapshot: Snapshot) => Effect.Effect<void>,
  diffUpdate?: (frame: DiffUpdateFrame) => Effect.Effect<void>,
) {
  const sessionsDir = yield* sessionsDirConfig;
  const dir = yield* createSessionDir(sessionsDir).pipe(Effect.mapError((e) => new CommandFailed({ message: describe(e) })));
  const { session, appendLog } = yield* openLoggedSession({ dir, title: input.title, publish, model, ...(diffUpdate ? { diffUpdate } : {}) });
  // 過去のセッションのフォルダを再生するときだけ、今の規則で直し直す（読みのサブコマンドもモデルも呼ばない）
  const replaying = input.vocabulary === undefined
    ? session
    : yield* withReplayCorrection(session, {
        vocab: input.vocabulary,
        commonWords: yield* loadCommonWords(COMMON_WORDS_PATH).pipe(Effect.orDie),
        appendLog,
      });
  yield* playback(replaying, input.remarks, { ...(input.realtime ? { sleep: (ms: number) => Effect.sleep(ms) } : {}), screens: input.screens });
  const paths = yield* writeExportsAndCapture(dir, yield* session.snapshot, describe, new Map()).pipe(
    Effect.mapError((e) => new CommandFailed({ message: e.message })),
  );
  return { dir, paths };
});

const play = Command.make(
  "play",
  {
    model: modelFlag,
    judge: judgeFlag,
    local: localFlag,
    transcript: Argument.String("source").pipe(
      Argument.withDescription(
        "再生する文字起こしファイル（kanary transcribe の JSON）、または過去のセッションのフォルダ（log.jsonl を持つフォルダ）。"
          + "フォルダのときは、ログの発言と共有画面の変化（screen・screen-off）を元の時刻のまま流し、画像は元のフォルダの screens/ から読む。題名は元の start の行から取る。"
          + "発言は、ログの vocab の行（読み）・screen の lines・発言の raw と words から今の補正の規則で直し直す（読みのサブコマンドもモデルも呼ばない。raw と words の無い古い発言は直さない）",
      ),
    ),
    realtime: Flag.Boolean("realtime").pipe(
      Flag.withDescription("発言と共有画面の変化の時刻どおりに等速で再生する（既定は待ち時間なし）"),
      Flag.withDefault(false),
    ),
    screen: Flag.File("screen", { mustExist: true }).pipe(
      Flag.withDescription(
        "共有画面の一覧 slides.tsv（1 行目は見出し、列は start end slide image。start・end は会議の秒、image は tsv のあるフォルダからの PNG の相対パス）。"
          + "画面が変わった時刻の画像（隙間と最後の行の後は「なし」）を、発言より前に Claude へのメッセージへ添え、セッションのフォルダの screens/ とログに残す。"
          + "セッションのフォルダを渡したときは一緒に使えない",
      ),
      Flag.optional,
    ),
  },
  Effect.fn("play")(
    function* ({ realtime, screen, transcript, model, judge, local }) {
      const plan = yield* resolvePlan({ model: Option.getOrUndefined(model), judge: Option.getOrUndefined(judge), local });
      const selected = planModel(plan);
      const warnings = yield* requireStartupDeps("play", selected.route);
      const { layer: updaterLayer, notice } = yield* planLayer(plan).pipe(Effect.mapError(startupPreparationFailure));
      yield* writeWarnings(notice === undefined ? warnings : [...warnings, notice]);
      return yield* Effect.gen(function* () {
        const port = yield* portConfig;
        const folder = yield* isDirectory(transcript);
        if (folder && Option.isSome(screen)) {
          return yield* new CommandFailed({ message: "セッションのフォルダと --screen は一緒に使えません" });
        }
        // セッションのフォルダはログを再生の前にすべて読む。壊れていれば何も始めずに失敗する（画像は入れる直前に読む）
        const recorded = folder ? yield* loadSessionLog(resolve(transcript)) : undefined;
        // 共有画面は再生を始める前にすべて読み、JPEG にする。読めなければ何も始めずに失敗する
        const screens: Iterable<PlaybackScreen<CommandFailed>> = recorded
          ? recorded.screens
          : Option.isSome(screen) ? yield* loadScreens(screen.value) : [];
        // 配信は play の Scope が持つ。再生と書き出しが終わって Scope を閉じるときに、待受けも閉じる
        const listener = yield* openListener(port).pipe(
          Effect.mapError((e) => listenFailed(port, e)),
        );
        // 配信の開始と、待受けを閉じる前に最後のスナップショットを接続中のクライアントへ渡し切る登録を、受け取った Context への 1 回の provide で行う
        const viewers = yield* Effect.gen(function* () {
          yield* serveFeed;
          const viewers = yield* Viewers;
          yield* Effect.addFinalizer(() => viewers.drained);
          return viewers;
        }).pipe(Effect.provide(listener));
        const remarks = recorded ? recorded.remarks : yield* readTranscriptRemarks(transcript);
        yield* viewers.sessionMode({ type: "session-mode", local: selected.local });
        const { paths } = yield* recordPlayback({
          title: recorded ? recorded.title : basename(transcript).replace(/\.transcript\.json$/, ""),
          remarks, screens, realtime, ...(recorded ? { vocabulary: recorded.vocabulary } : {}),
        }, selected, viewers.publish, viewers.diffUpdate).pipe(Effect.ensuring(viewers.sessionMode({ type: "session-mode", local: false })));
        yield* write(paths.map((path) => `${path}\n`).join(""));
      }).pipe(Effect.provide(updaterLayer));
    },
    Effect.scoped,
  ),
).pipe(
  Command.withDescription(
    "録音サンプルの文字起こし、または過去のセッションのフォルダ（log.jsonl を持つフォルダ）を再生し、マップを組み立てる（既定は待ち時間なし、--realtime で等速）。"
      + "フォルダのときは、ログの発言と共有画面の変化を元の時刻のまま流し、新しいセッションのフォルダにライブと同じ形でログと screens/ を書く（発言は今の補正の規則で直し直す）。"
      + "再生中は WebSocket で、反映のたびにマップ全体をブラウザへ送る。"
      + "終わると、セッションのフォルダに map.md・map.json・map.drawnix・map.png・map.html を書き出し、そのパスを出す（play のセッションには録音が無いので map-audio.html は作らない）。"
      + "管理依存は入れる前に利用者に確認する",
  ),
);

const models = Command.make("models", {}, Effect.fn("models")(function* () {
  const entries = yield* configuredModels();
  const routes = { claude: "Claude", apple: "子プロセス", "openai-compatible": "OpenAI 互換", chatgpt: "ChatGPT" };
  yield* write(["名前  経路  ローカル  使えるか", ...entries.map((model) =>
    `${model.name}  ${routes[model.route]}  ${model.local ? "はい" : "-"}  ${model.reason === undefined ? "はい" : `いいえ: ${model.reason}`}`,
  )].join("\n") + "\n");
})).pipe(Command.withDescription("モデルの名前・経路・ローカル可否・現在の利用可否を一覧する"));

const apps = Command.make(
  "apps",
  {},
  Effect.fn("apps")(function* () {
    const port = yield* portConfig;
    // 一覧の中身は CLI が使わないので、形を決めずにそのまま出す
    const list = yield* requestServer(port, ServerRoutes.apps);
    yield* write(JSON.stringify(list, null, 2) + "\n");
  }),
).pipe(Command.withDescription("会議アプリの一覧（JSON）を出す。常駐サーバー（pnpm dev）に頼む"));

// --vocab のファイル（1 行に 1 語、空行は無視）を語の一覧にする。足さなければ空。start と recorded が共有する
const vocabFlag = Flag.File("vocab", { mustExist: true }).pipe(
  Flag.withDescription("利用者が足す語のファイル（1 行に 1 語、空行は無視）。この語で発言を直す。足せるのは開始時だけ（resume では受け取らない）"),
  Flag.optional,
);
const titleFlag = Flag.String("title").pipe(Flag.withDescription("会議の名前（省略するとセッションの開始時刻）"), Flag.optional);
const readVocabulary = Effect.fnUntraced(function* (vocab: Option.Option<string>) {
  if (Option.isNone(vocab)) return [];
  const text = yield* readTextFile(vocab.value).pipe(Effect.mapError((e) => new CommandFailed({ message: `${vocab.value} が読めません: ${fileReason(e)}` })));
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
});

// 転送用トークンが要る計画（needsTransferToken）のときだけ、トークンを読んで要求のヘッダーにする。start と recorded が共有する
const modelTransferHeaders = Effect.fnUntraced(function* (plan: UpdatePlan, port: number) {
  if (!needsTransferToken(plan)) return undefined;
  const sessionsDir = yield* sessionsDirConfig;
  const token = yield* readModelTransferToken(sessionsDir, port).pipe(
    Effect.mapError(() => new ServerFailed({ message: "モデル・判定の転送用トークンを読めません\nサーバーを起動し、保存先設定が CLI と同じか確かめてください" })),
  );
  if (!token) return yield* new ServerFailed({ message: "モデル・判定の転送用トークンが空です\nサーバーを起動し直してください" });
  return { [MODEL_TRANSFER_HEADER]: token };
});

const start = Command.make(
  "start",
  {
    model: modelFlag,
    judge: judgeFlag,
    local: localFlag,
    app: Flag.String("app").pipe(Flag.withDescription("会議アプリの bundle id（例 us.zoom.xos）")),
    title: titleFlag,
    noAudio: Flag.Boolean("no-audio").pipe(
      Flag.withDescription("トラックごとの録音（相手.m4a・自分.m4a）をセッションのフォルダに残さない（既定は残す）"),
      Flag.withDefault(false),
    ),
    noScreen: Flag.Boolean("no-screen").pipe(
      Flag.withDescription("共有画面を AI に渡さない（取り込まない）"),
      Flag.withDefault(false),
    ),
    vocab: vocabFlag,
  },
  Effect.fn("start")(function* ({ app, noAudio, noScreen, title, model, judge, local, vocab }) {
    const vocabulary = yield* readVocabulary(vocab);
    const plan = yield* resolvePlan({ model: Option.getOrUndefined(model), judge: Option.getOrUndefined(judge), local });
    const port = yield* portConfig;
    const headers = yield* modelTransferHeaders(plan, port);
    const { dir, warnings } = yield* requestServer(port, ServerRoutes.sessionStart, { body: {
      app,
      title: Option.getOrUndefined(title),
      audio: !noAudio,
      screen: !noScreen,
      ...(vocabulary.length > 0 ? { vocab: vocabulary } : {}),
      ...planBody(plan),
    }, headers });
    yield* writeWarnings(warnings ?? []);
    yield* write(`${dir}\n`);
  }),
).pipe(
  Command.withDescription(
    "ライブのセッションを開始する。サーバーがヘルパーを起動し、セッションのフォルダを出す。同時に 1 つだけ。"
      + "管理依存は入れる前に利用者に確認する",
  ),
);

// 録画からのセッションの経過（NDJSON）を読んで、進み具合を標準エラーに出し、終わりを返す。
// 端末なら同じ行を書き換え、端末でないときは変わるたびに 1 行出す
const followRecorded = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse, onStarted: (dir: string) => void) {
  const tty = yield* StdoutIsTty;
  let finished: Extract<RecordedEvent, { type: "finished" }> | undefined;
  let lastProgress: RecordedProgress | undefined;
  let drawing = false;
  // 知らせを 1 行出す。端末で進み具合を描いている最中なら、その行を消してから出す（次の進み具合は新しい行から描き直す）
  const notify = (text: string) => tty && drawing
    ? Effect.sync(() => {
      drawing = false;
      process.stderr.write(`\r\x1b[K${text}\n`);
    })
    : Console.error(text);
  yield* forEachServerEvent(response, ServerRoutes.sessionRecorded, (event) => Effect.gen(function* () {
    switch (event.type) {
      case "started":
        onStarted(event.dir);
        yield* writeWarnings(event.warnings);
        break;
      case "progress": {
        lastProgress = event;
        const text = formatRecordedProgress(event);
        if (tty) {
          drawing = true;
          yield* Effect.sync(() => { process.stderr.write(`\r\x1b[K${text}`); });
        } else {
          yield* Console.error(text);
        }
        break;
      }
      case "audio-tracks":
        yield* notify(formatAudioTracksNotice(event.count));
        break;
      case "screen-off":
        yield* notify(formatScreenOffNotice());
        break;
      case "speaker-off":
        yield* notify(formatSpeakerOffNotice(event.reason));
        break;
      case "finished":
        finished = event;
        break;
    }
  })).pipe(Effect.ensuring(Effect.suspend(() => drawing ? Effect.sync(() => { process.stderr.write("\n"); }) : Effect.void)));
  return { finished, lastProgress };
});

// 録画からのセッションの途中で、サーバーとの接続が切れた。途中までのセッションのフォルダ（開始の応答を受け取っていれば）と、
// もう一度 cli recorded を呼べば頭から組み直せることを知らせる
const disconnectedFailure = (dir: string | undefined, reason: string | undefined) =>
  new ServerFailed({
    message: [
      `録画からのセッションが終わる前に接続が終了しました${reason === undefined ? "" : `: ${reason}`}`,
      ...(dir === undefined ? [] : [`途中までのセッションのフォルダ: ${dir}`]),
      "もう一度 cli recorded を呼べば、頭から組み直せます",
    ].join("\n"),
  });

const recordedTitleFlag = Flag.String("title").pipe(Flag.withDescription("会議の名前（省略するとファイル名。拡張子は除く）"), Flag.optional);

const recorded = Command.make(
  "recorded",
  {
    file: Argument.File("file", { mustExist: true }).pipe(Argument.withDescription("録画の音声（または動画）のファイル")),
    self: Flag.File("self", { mustExist: true }).pipe(
      Flag.withDescription("自分用の録音のファイル（音声または動画）。足すと、file を 相手、これを 自分 の 2 トラックで組む"),
      Flag.optional,
    ),
    model: modelFlag,
    local: localFlag,
    title: recordedTitleFlag,
    judge: judgeFlag,
    vocab: vocabFlag,
    realtime: Flag.Boolean("realtime").pipe(
      Flag.withDescription("発言と共有画面の変化を、音声の時刻どおりに等速で入れる（既定は待ち時間なし）"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("recorded")(function* ({ file, self, model, judge, local, title, vocab, realtime }) {
    const vocabulary = yield* readVocabulary(vocab);
    const plan = yield* resolvePlan({ model: Option.getOrUndefined(model), judge: Option.getOrUndefined(judge), local });
    const port = yield* portConfig;
    const headers = yield* modelTransferHeaders(plan, port);
    let dir: string | undefined;
    // Ctrl-C は、そこまでに入れた分で終えて map.* を書き出す（stop と同じ）。サーバーは接続が切れても書き出しを最後まで続ける。
    // 開始の応答（2xx）を受け取った後なら、started を読む前の中断でも止める
    const stopOnInterrupt = Effect.gen(function* () {
      const { paths } = yield* requestServer(port, ServerRoutes.sessionStop);
      yield* write([...(dir === undefined ? [] : [dir]), ...paths].map((line) => `${line}\n`).join(""));
    }).pipe(Effect.ignore);
    // 開始の要求が断られた（2xx 以外）ときは中断の対象に入れない。既存のセッションを止めないため
    const finished = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const response = yield* restore(executeServerRequest(port, ServerRoutes.sessionRecorded, { body: {
          file: resolve(file),
          ...(Option.isSome(self) ? { selfFile: resolve(self.value) } : {}),
          title: Option.getOrUndefined(title),
          ...(vocabulary.length > 0 ? { vocab: vocabulary } : {}),
          ...(realtime ? { realtime } : {}),
          ...planBody(plan),
        }, headers }));
        return yield* restore(followRecorded(response, (started) => { dir = started; })).pipe(Effect.onInterrupt(() => stopOnInterrupt));
      }),
    ).pipe(
      // サーバーが落ちた・接続が切れた。続けない（待ち続けない）。途中までのセッションのフォルダと、組み直し方を知らせて失敗にする
      Effect.catchTag("ServerStreamClosed", (closed) => Effect.fail(disconnectedFailure(dir, closed.reason))),
    );
    if (dir === undefined || finished.finished === undefined) return yield* disconnectedFailure(dir, undefined);
    yield* write([dir, ...finished.finished.paths].map((line) => `${line}\n`).join(""));
    if (finished.finished.failure !== undefined) {
      // ヘルパーの起動し直しを諦めて、入れた分で終えた。どこまで組めたかと、ヘルパーの標準エラーの末尾を出す
      const { code, signal, stderrTail } = finished.finished.failure;
      const position = formatRecordedPosition(finished.lastProgress?.position ?? 0, finished.lastProgress?.duration ?? null);
      yield* Console.error(stderrTail.join("\n"));
      return yield* new CommandFailed({ message: `文字起こしのヘルパーが落ち続け、起動し直しを諦めました（${code ?? signal ?? "不明"}）。${position} まで組めたところで終えました` });
    }
  }),
).pipe(
  Command.withDescription(
    "音声 1 本（--self で自分用の 2 本目も）の録画から、常駐サーバーでセッションを組む。終わるまで待ち、進み具合（入れた位置 / 全体の長さ・マップの更新回数）を標準エラーに出す。"
      + "終わったらセッションのフォルダと map.* のパスを出す。Ctrl-C ではそこまでの分で終える。同時に 1 つだけ。"
      + "<file> の 相手 は話者を分けて「相手 A」のようなラベルで呼ぶ（話者分離のモデルが無いときは、話者を分けずに続けると標準エラーに知らせる）。"
      + "話者のラベルは会議全体で 4 人（自分を含む）まで。1 本の録音では自分も 1 人に数える。確実に分けたいときは --self で自分用の録音を足す",
  ),
);

const stop = Command.make(
  "stop",
  {},
  Effect.fn("stop")(function* () {
    const port = yield* portConfig;
    const { paths } = yield* requestServer(port, ServerRoutes.sessionStop);
    yield* write(paths.map((path) => `${path}\n`).join(""));
  }),
).pipe(
  Command.withDescription(
    "ライブのセッションを終了し、map.md・map.json・map.drawnix・map.png・map.html（録音があれば、その後に音声つきの map-audio.html も）を書き出して、そのパスを出す",
  ),
);

const status = Command.make(
  "status",
  {},
  Effect.fn("status")(function* () {
    const port = yield* portConfig;
    const report: IntakeStatusReport = yield* requestServer(port, ServerRoutes.sessionStatus);
    const share = yield* requestServer(port, ServerRoutes.shareStatus);
    yield* write(formatIntakeStatus(report) + formatShareStatus(share));
  }),
).pipe(
  Command.withDescription(
    "取り込みの状態（動いている／途切れている／止まった／セッションなし）・セッションのフォルダ・"
      + "起動し直した回数・最後の途切れの時刻と、閲覧の共有の状態（共有中／切れた／無し）・URL・許可の範囲を出す",
  ),
);

// 許す範囲は 既定の許可 + 引数（重複は除く）。--anyone のときだけ「誰でも」。範囲が空なら {}（空の拒否はサーバーの判定順に任せる）
const shareOpenBody = (anyone: boolean, mails: readonly string[]): typeof ServerRoutes.shareOpen.body["Encoded"] =>
  anyone ? { anyone: true } : mails.length > 0 ? { mails: [...new Set(mails)] } : {};

const share = Command.make(
  "share",
  {
    mails: Argument.String("mail").pipe(
      Argument.withDescription("閲覧を許すメール（a@example.com）かドメイン（*@example.com）。LIVE_MINDMAP_SHARE_ALLOW の既定の許可に足される"),
      Argument.variadic(),
    ),
    anyone: Flag.Boolean("anyone").pipe(
      Flag.withDescription("URL を知っていれば誰でも見られる閲覧の共有を開く"),
      Flag.withDefault(false),
    ),
    stop: Flag.Boolean("stop").pipe(
      Flag.withDescription("閲覧の共有を閉じる（共有していなくても成功する）"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("share")(function* ({ mails, anyone, stop }) {
    if (stop && anyone) return yield* new CommandFailed({ message: "--stop と --anyone は一緒に指定できません" });
    if (stop && mails.length > 0) return yield* new CommandFailed({ message: "--stop とメール・ドメインは一緒に指定できません" });
    if (anyone && mails.length > 0) return yield* new CommandFailed({ message: "--anyone とメール・ドメインは一緒に指定できません" });
    const port = yield* portConfig;
    const defaults = yield* shareAllowConfig;
    if (stop) {
      yield* requestServer(port, ServerRoutes.shareClose);
      return;
    }
    // 拒否の判定順（共有中・セッション無し・ローカル・cloudflared 無し・範囲が空）はサーバーが持つ。
    // 新しく開いたか既存を返したかは、サーバーがロックの中で決めてヘッダーで返す
    const response = yield* executeServerRequest(port, ServerRoutes.shareOpen, { body: shareOpenBody(anyone, [...defaults, ...mails]) });
    const outcome = yield* Schema.decodeUnknownEffect(ShareOpenOutcome)(response.headers[SHARE_OPEN_OUTCOME_HEADER]).pipe(
      Effect.mapError(() => new ServerFailed({ message: "サーバーの応答が読めません: 共有の結果を示すヘッダーがありません" })),
    );
    const status = yield* decodeServerBody(response, ServerRoutes.shareOpen.response);
    if (outcome === "already-open") return yield* new CommandFailed({ message: formatShareAlreadyOpen(status).trimEnd() });
    yield* write(formatShareOpened(status));
  }),
).pipe(
  Command.withDescription(
    "閲覧の共有を開き、URL・許可の範囲・稼働の保証が無い旨を出す（cli share <メール・ドメイン...>。LIVE_MINDMAP_SHARE_ALLOW の既定の許可に足す。誰でも見られてよいなら --anyone）。--stop で閉じる。セッションの終了でも閉じる",
  ),
);

const resume = Command.make(
  "resume",
  {},
  Effect.fn("resume")(function* () {
    const port = yield* portConfig;
    const { warnings } = yield* requestServer(port, ServerRoutes.sessionResume);
    yield* writeWarnings(warnings ?? []);
  }),
).pipe(
  Command.withDescription(
    "止まった状態（起動し直しを諦めた状態）から、ヘルパーを起動し直して同じセッションを続ける。"
      + "管理依存は入れる前に利用者に確認する",
  ),
);

const exportCommand = Command.make(
  "export",
  {
    format: Flag.Literals("format", ["md", "json"]).pipe(
      Flag.withDescription("出す形式（md は Markdown、json は map.json と同じ内容）"),
      Flag.withDefault("md"),
    ),
  },
  Effect.fn("export")(function* ({ format }) {
    const sessionsDir = yield* sessionsDirConfig;
    const latest = yield* latestSession(sessionsDir, EXPORT_FILE);
    const path = join(sessionsDir, latest, EXPORT_FILE);
    const text = yield* readTextFile(path).pipe(Effect.mapError(fileFailed));
    if (format === "json") {
      // json はマップの形を使わないので、保存した値をそのまま出す（宣言していないキーも落とさない）
      const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError((e) => new CommandFailed({ message: `${path} が JSON として読めません: ${decodeReason(e)}` })),
      );
      yield* write(JSON.stringify(raw, null, 2) + "\n");
      return;
    }
    const exported = yield* Schema.decodeEffect(Schema.fromJsonString(JsonExport))(text).pipe(
      Effect.mapError((e) => new CommandFailed({ message: `${path} が読めません: ${decodeReason(e)}` })),
    );
    yield* write(toMarkdown(exported));
  }),
).pipe(Command.withDescription("最新のセッションのマップを標準出力に出す（既定は md。ファイルは作らない）"));

const restore = Command.make(
  "restore",
  {},
  Effect.fn("restore")(function* () {
    const sessionsDir = yield* sessionsDirConfig;
    const dir = join(sessionsDir, yield* latestSession(sessionsDir, LOG_FILE));
    const { lines, events } = yield* readLogLines(join(dir, LOG_FILE)).pipe(orFileFailed);
    // 復元では差分更新を呼ばない。呼ばれたら defect にする。ログは書き直さない。画像は差分更新に添えるときにだけ読むので、ここでは読まない
    const session = yield* restoreSession(events).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DiffUpdater)(DiffUpdater.of({ update: () => Effect.die("restore では差分更新を呼べません") })),
          Layer.succeed(SessionLog)(SessionLog.of({ write: () => Effect.void, writeScreen: () => Effect.void, readScreen: () => Effect.die("restore は共有画面を読まない") })),
        ),
      ),
      // 壊れた行は、空行を除く前の行番号の BrokenLogLine にする
      Effect.catchTag("InvalidLogEvent", (e) => Effect.fail(new BrokenLogLine({ line: lines[e.index]?.no ?? 1, reason: e.reason }))),
    );
    const exported = yield* session.exportJson;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(join(dir, EXPORT_FILE), JSON.stringify(exported)).pipe(orFileFailed);
    // 終了の処理を通らなかったセッションも、組み直した語を語彙の溜まりの更新に含める（ログの番号の行が無いセッションは何もしない）
    yield* updatePoolFromLog(sessionsDir, events);
    yield* write(`${dir}\n`);
  }, Effect.scoped),
).pipe(Command.withDescription("最新のセッションのログから、差分更新を呼ばずにマップを戻す。終了の処理を通らなかったセッションの語は、語彙の溜まりにも入れる"));

// 渡されたセッションのフォルダ（省略すると log.jsonl を持つ最新のセッション）と、その log.jsonl。log.jsonl が無ければ失敗にする
const sessionLog = Effect.fnUntraced(function* (session: Option.Option<string>) {
  const dir = Option.isSome(session)
    ? resolve(session.value)
    : yield* Effect.gen(function* () {
        const sessionsDir = yield* sessionsDirConfig;
        return resolve(sessionsDir, yield* latestSession(sessionsDir, LOG_FILE));
      });
  const logPath = join(dir, LOG_FILE);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* pathExists(fs, logPath).pipe(orFileFailed))) return yield* new CommandFailed({ message: `${LOG_FILE} がありません: ${logPath}` });
  return { dir, logPath };
});

const review = Command.make(
  "review",
  {
    session: Argument.String("session").pipe(
      Argument.withDescription("見返し用の map.html（録音があれば map-audio.html も）を作り直すセッションのフォルダ（省略すると log.jsonl を持つ最新のセッション）"),
      Argument.optional,
    ),
    selfOnly: Flag.Boolean("self-only").pipe(
      Flag.withDescription("`自分` の声だけを埋め込んだ map-audio-自分.html だけを作る（map.html・map-audio.html は触らない。自分*.m4a が無ければ失敗する）"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("review")(function* ({ session, selfOnly }) {
    const { dir, logPath } = yield* sessionLog(session);
    if (selfOnly) {
      const variants = yield* selfReviewVariants(dir).pipe(Effect.mapError((e) => new CommandFailed({ message: describe(e) })));
      if (variants.length === 0) return yield* new CommandFailed({ message: `自分の録音がありません: ${dir}` });
      const self = yield* writeReviewPages(dir, logPath, variants).pipe(
        Effect.mapError((e) => new CommandFailed({ message: reviewWarning("map-audio-自分.html", describe(e)) })),
      );
      // 見返し用に 自分 だけの版を頼まれているので、mix の失敗は警告で済ませず失敗にする
      for (const { file, reason } of self.skipped) return yield* new CommandFailed({ message: reviewWarning(file, reason) });
      yield* write(self.paths.map((path) => `${path}\n`).join(""));
      return;
    }
    const { paths, skipped } = yield* writeReviews(dir).pipe(
      Effect.mapError((e) => new CommandFailed({ message: reviewWarning("map.html", describe(e)) })),
    );
    // mix だけの失敗は、map.html を書いて成功のまま終える。書けなかった理由は標準エラーに出す
    for (const { file, reason } of skipped) yield* Console.error(reviewWarning(file, reason));
    yield* write(paths.map((path) => `${path}\n`).join(""));
  }),
).pipe(
  Command.withDescription(
    "セッションの log.jsonl から、見返し用の map.html を作り直してパスを出す。フォルダに録音（相手*.m4a・自分*.m4a）があれば、その後に音声つきの map-audio.html も作る。--self-only を付けると、自分*.m4a があるときだけ、自分の声だけを埋め込んだ map-audio-自分.html だけを作り（map.html・map-audio.html は触らない。上書きは確認しない。録音が無い・mix が失敗したら 0 以外で終わる）。--self-only なしでは、mix が失敗したら map-audio.html だけ諦めて、理由を標準エラーに出す。サーバーは要らない",
  ),
);

// 元ログを選んだモデルで再生し、新しいランのフォルダを返す（updater の layer などは呼び出し側の Scope が持つ）
const replayedRunDir = Effect.fnUntraced(function* (source: string, plan: UpdatePlan) {
  const recorded = yield* loadSessionLog(resolve(source));
  const { layer: updaterLayer, notice } = yield* planLayer(plan).pipe(Effect.mapError(startupPreparationFailure));
  yield* writeWarnings(notice === undefined ? [] : [notice]);
  return (yield* recordPlayback({ ...recorded, realtime: false }, planModel(plan), () => Effect.void).pipe(
    Effect.provide(updaterLayer),
  )).dir;
});

const evaluatedRun = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, dir: string) {
  const path = join(dir, EXPORT_FILE);
  if (!(yield* pathExists(fs, path).pipe(orFileFailed))) return yield* new MissingRunExport({ path });
  const text = yield* readTextFile(path).pipe(Effect.mapError(fileFailed));
  const exp = yield* Schema.decodeEffect(Schema.fromJsonString(JsonExport))(text).pipe(
    Effect.mapError((e) => new CommandFailed({ message: `${path} が読めません: ${decodeReason(e)}` })),
  );
  const logPath = join(dir, LOG_FILE);
  if (!(yield* pathExists(fs, logPath).pipe(orFileFailed))) return { name: basename(dir), title: exp.root.text, exp };
  // 検証は restore と同じ restoreState で行う。壊れた行は、どのランか分かるようにパスと行番号を添えて失敗にする
  const { lines, events } = yield* readLogLines(logPath).pipe(
    orFileFailed,
    Effect.catchTag("BrokenLogLine", (e) => Effect.fail(new CommandFailed({ message: `${logPath} の ${e.line} 行目が JSON として読めません: ${e.reason}` }))),
  );
  yield* restoreState(events).pipe(
    Effect.catchTag("InvalidLogEvent", (e) => Effect.fail(new CommandFailed({ message: `${logPath} の ${lines[e.index]?.no ?? 1} 行目が読めません: ${e.reason}` }))),
  );
  const log = yield* Effect.forEach(events.filter(isEvalEvent), (event) => Schema.decodeUnknownEffect(LogEvent)(event).pipe(Effect.orDie));
  return { name: basename(dir), title: exp.root.text, exp, log };
});

const evaluate = Command.make(
  "eval",
  {
    model: modelFlag,
    truth: Flag.File("truth").pipe(
      Flag.withDescription("正解ファイル（JSON）。形は core/evaluate.ts の Truth が正本"),
      Flag.optional,
    ),
    screenTruth: Flag.File("screen-truth").pipe(
      Flag.withDescription("共有画面の正解ファイル（JSON）。形は core/evaluate.ts の ScreenTruth が正本"),
      Flag.optional,
    ),
    sessions: Argument.String("session").pipe(
      Argument.withDescription("play で作ったセッションのフォルダ"),
      Argument.atLeast(1),
    ),
  },
  Effect.fn("eval")(function* ({ sessions, truth, screenTruth, model }) {
    const plan = Option.isSome(model) ? yield* resolvePlan({ model: model.value }) : undefined;
    // 正解ファイルの検証は共有の readTruthFile（段 1 の Truth の Schema）が持つ（Flag 側では検証しない）
    const expected = Option.isNone(truth) ? undefined : yield* readTruthFile(truth.value);
    const screen = Option.isNone(screenTruth) ? undefined : yield* readScreenTruthFile(screenTruth.value);
    const fs = yield* FileSystem.FileSystem;
    const runs: Run[] = [];
    for (const source of sessions) {
      const dir = plan === undefined ? source : yield* replayedRunDir(source, plan).pipe(Effect.scoped);
      runs.push(yield* evaluatedRun(fs, dir));
    }
    const table = yield* formatTable(runs, expected, screen).pipe(
      Effect.catchTag("InvalidLogEvent", (e) => Effect.fail(new CommandFailed({ message: `log.jsonl の指標が数えられません: ${e.reason}` }))),
    );
    yield* write(table);
  }),
).pipe(
  Command.withDescription(
    "play で作ったランの指標を 1 ラン 1 行の表で出す。log.jsonl があれば、本文の書き換えの回数÷発言の数・1 ノードの書き換えの最多・話し中の兄弟の最多も出す（無ければ -）。--truth を渡すと決定・TODO の再現率と種別違い（正解が別の種別のノードとして出た数）も、--screen-truth を渡すと指す発言・うち記憶・話だけ・出てはいけないの列も出す"
      + "（当たる条件と 1 対 1 の数え方は core/evaluate.ts の matches・recall が持つ）。"
      + "--model を明示したときだけ元ログを選んだモデルで再生し、新しいランを評価する。指定なしでは環境変数・設定の default に関係なく保存済み結果を集計する",
  ),
);

const checkCommand = Command.make(
  "check",
  { for: Flag.Literals("for", ["start", "resume", "play"]).pipe(Flag.withDefault("start")), noScreen: Flag.Boolean("no-screen").pipe(Flag.withDefault(false)) },
  Effect.fn("check")(function* ({ for: entry, noScreen }) {
    const report = yield* Effect.gen(function* () {
      if (entry === "resume") return yield* requestServer(yield* portConfig, ServerRoutes.check, { query: { for: "resume" } });
      const model = yield* resolveModelCandidate({});
      if (entry === "play") return yield* checkManagedDeps(entry, model.route);
      return yield* requestServer(yield* portConfig, ServerRoutes.check, { query: { for: entry, route: model.route, screen: String(!noScreen) } });
    });
    yield* write(JSON.stringify(report));
    if (report.items.some((item) => item.need === "required" && item.state !== "ready" && item.state !== "outdated")) return yield* new RequiredDepsMissing();
  }),
).pipe(Command.withDescription(
  "開始せず管理依存を JSON で確認する。--for start|resume|play（既定 start）。play はサーバーを使わず、resume は開始時モデルを使う。"
    + "管理依存は入れる前に利用者に確認する",
));

// /deps/install と /update は、同じ InstallEvent の NDJSON を流す。要求は呼び出し側が記述で組み、ここは経過を読む
const installFromServer = Effect.fnUntraced(function* (send: ReturnType<typeof executeServerRequest>) {
    // エージェント（標準出力が端末でない）にだけ出す。人の端末には要らない文
    if (!(yield* StdoutIsTty)) yield* Console.error("時間がかかるので run_in_background で呼んでよい");
    const response = yield* send;
    let result: Extract<typeof ServerRoutes.depsInstall.response.Type, { type: "result" }> | undefined;
    yield* forEachServerEvent(response, ServerRoutes.depsInstall, (event) => Effect.gen(function* () {
      if (result !== undefined) return yield* new ServerFailed({ message: "完了後にイベントを受信しました" });
      switch (event.type) {
        case "progress": yield* Console.error(oneLine(event.message)); break;
        case "error": return yield* new ServerFailed({ message: event.message });
        case "result": result = event; break;
      }
    })).pipe(Effect.catchTag("ServerStreamClosed", (closed) => Effect.fail(new ServerFailed({ message: closed.reason }))));
    if (result === undefined) return yield* new ServerFailed({ message: "導入結果を受信する前に接続が終了しました" });
    yield* write(JSON.stringify(result.items));
});

// 名前の検証は server（400）に任せる。引数は利用者の入力なので、ここだけ本文の型へ読み替える（CLI の拒否の経路を変えない）
const installCommand = Command.make(
  "install",
  { names: Argument.String("name").pipe(Argument.atLeast(1)) },
  Effect.fn("install")(function* ({ names }) {
    yield* installFromServer(executeServerRequest(yield* portConfig, ServerRoutes.depsInstall, { body: { names: names as typeof ServerRoutes.depsInstall.body["Encoded"]["names"] } }));
  }),
).pipe(Command.withDescription(
  "常駐サーバーに chromium・claude・cloudflared・speech-ja の導入を依頼し、進捗と導入した items を出す。"
    + "管理依存は入れる前に利用者に確認する",
));

const updateCommand = Command.make(
  "update",
  { names: Argument.Literals("name", ["chromium", "claude", "speech-ja"]).pipe(Argument.variadic()) },
  Effect.fn("update")(function* ({ names }) {
    const speech = names.includes("speech-ja");
    const managed = names.length === 0 ? ["chromium", "claude"] : names.filter((name) => name !== "speech-ja");
    if (managed.length > 0) {
      const port = yield* portConfig;
      const items = yield* requestServer(port, ServerRoutes.depsCheck, { query: { names: managed.join(",") } });
      const missing = names.length === 0 ? [] : items.filter((item) => item.state === "missing");
      if (missing.length > 0) return yield* new CommandFailed({ message: missing.map((item) => `未導入です。cli install ${item.name} で入れる`).join("\n") });
      const outdated = items.flatMap((item) => item.state === "outdated" && (item.name === "chromium" || item.name === "claude") ? [item.name] : []);
      if (outdated.length > 0) yield* installFromServer(executeServerRequest(port, ServerRoutes.update, { body: { names: outdated } }));
      else yield* write("[]");
    }
    if (speech) yield* Console.error("OS が更新するので不要");
  }),
).pipe(Command.withDescription("常駐サーバーに版違いの管理依存だけの更新を依頼する。名前を省くと全対象。speech-ja は OS が更新するので不要"));

// サーバーが SIGTERM の後に終わるのを待つ上限と、確かめる間隔
const SERVER_EXIT_TIMEOUT_MS = 15_000;
const SERVER_EXIT_POLL_MS = 100;

const serverStop = Command.make(
  "stop",
  {},
  Effect.fn("server stop")(function* () {
    const port = yield* portConfig;
    const sessionsDir = yield* sessionsDirConfig;
    const processes = yield* ServerProcess;
    const recorded = yield* orFileFailed(readServerPid(sessionsDir, port)).pipe(
      Effect.catchTag("BrokenServerPid", (e) => Effect.fail(new CommandFailed({ message: e.message }))),
    );
    const reported = yield* requestServer(port, ServerRoutes.server).pipe(
      Effect.map((identity): number | undefined => identity.pid),
      Effect.catchTags({
        ServerUnreachable: () => Effect.succeed(undefined),
        // PID を名乗る口が無いのは、この口より前の版のサーバー
        ServerFailed: () => Effect.fail(new CommandFailed({ message: `ポート ${port} のサーバーは server stop に対応していない版です。起動した端末で Ctrl-C で止めてください` })),
      }),
    );
    const plan = planServerStop({ reported, recorded, recordedAlive: recorded === undefined ? false : yield* processes.alive(recorded) });
    switch (plan.action) {
      case "not-running":
        if (plan.stale !== undefined) yield* orFileFailed(removeServerPid(sessionsDir, port));
        yield* write(`ポート ${port} のサーバーは動いていません\n`);
        return;
      case "unresponsive":
        return yield* new CommandFailed({
          message: `ポート ${port} のサーバーが応答しません。記録の pid ${plan.pid} が live-mindmap のサーバーか確かめてから止めてください（ps -p ${plan.pid} -o command=）`,
        });
      case "terminate": {
        // 止めるとセッションは書き出されずに終わるので、進行中なら断る
        const { status } = yield* requestServer(port, ServerRoutes.sessionStatus);
        if (status !== "none") return yield* new CommandFailed({ message: "セッションが進行中です。先に cli stop で書き出してから、もう一度 server stop を打ってください" });
        yield* processes.terminate(plan.pid);
        const exited = yield* processes.alive(plan.pid).pipe(
          Effect.repeat({ until: (alive) => !alive, schedule: Schedule.spaced(SERVER_EXIT_POLL_MS) }),
          Effect.timeoutOption(SERVER_EXIT_TIMEOUT_MS),
        );
        if (Option.isNone(exited)) return yield* new CommandFailed({ message: `サーバー（pid ${plan.pid}）が ${SERVER_EXIT_TIMEOUT_MS / 1000} 秒たっても終わりません` });
        yield* write(`サーバーを止めました（ポート ${port}、pid ${plan.pid}）\n`);
      }
    }
  }),
).pipe(Command.withDescription(
  "常駐サーバー（pnpm dev）を止める。LIVE_MINDMAP_PORT のポートで応答したサーバー自身の PID にだけ SIGTERM を送り、終わるまで待つ。"
    + "セッションが進行中なら断る（先に stop）。動いていなければ何もしない。pkill などで止めない",
));

const serverCommand = Command.make("server").pipe(
  Command.withDescription("常駐サーバー（pnpm dev）そのものの操作。止めるのは server stop"),
  Command.withSubcommands([serverStop]),
);

const login = Command.make("login").pipe(Command.withSubcommands([
  Command.make("chatgpt", {}, () => loginChatgpt).pipe(Command.withDescription("システムブラウザで ChatGPT にサインインする")),
]));
const logout = Command.make("logout").pipe(Command.withSubcommands([
  Command.make("chatgpt", {}, () => logoutChatgpt).pipe(Command.withDescription("ChatGPT の保存済み資格情報を削除する")),
]));

const vocab = Command.make("vocab").pipe(Command.withSubcommands([
  Command.make(
    "list",
    {},
    Effect.fn("vocab list")(function* () {
      const path = vocabularyPoolPath(yield* sessionsDirConfig);
      const pool = yield* readPool(path).pipe(Effect.mapError((e) => new CommandFailed({ message: poolUnavailableMessage(e) })));
      yield* write(formatPoolTable(pool));
    }),
  ).pipe(Command.withDescription("全セッションをまたぐ語彙の溜まり（vocabulary.json）の語を表で出す（表記・出どころ・最後に話されてからのセッション数）。サーバーは要らない。ファイルは変えない")),
  Command.make(
    "forget",
    { word: Argument.String("word").pipe(Argument.withDescription("溜まりから消す語（表記が完全一致するもの）")) },
    Effect.fn("vocab forget")(function* ({ word }) {
      const path = vocabularyPoolPath(yield* sessionsDirConfig);
      const pool = yield* readPool(path).pipe(Effect.mapError((e) => new CommandFailed({ message: poolUnavailableMessage(e) })));
      const forgotten = forgetPoolWord(pool, word);
      if (forgotten === undefined) return yield* new CommandFailed({ message: `溜まりにありません: ${word}` });
      yield* writePool(path, forgotten).pipe(Effect.mapError((e) => new CommandFailed({ message: poolUnavailableMessage(e) })));
      yield* write(`溜まりから消しました: ${word}`);
    }),
  ).pipe(Command.withDescription("語を語彙の溜まりから消す（表記の完全一致）。効くのは次のセッションから。今のセッションの語彙と字幕は変わらない。サーバーは要らない。消した語も、次のセッションで話されるか --vocab で足されれば溜まりに戻る")),
]));

const MISSING_CREDENTIALS_MESSAGE = [
  "CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN の両方を環境変数に設定してください。",
  "API トークンは Cloudflare のダッシュボードで、Workers Admin（Workers の編集）の権限を 1 つだけ付けて作ります。",
  "アカウントが要る理由: アカウント無しの一時の置き場は 60 分・5 MiB までで使えないので、あなた自身のアカウントの workers.dev に置きます。",
].join("\n");
const DAY_MS = 24 * 60 * 60 * 1000;

// 置く途中で失敗・中断（Ctrl-C など）されたら、作りかけの Worker を消す。失敗のときは消してから元の失敗で返し、消すのも失敗したら、元の失敗の文に残っているかもしれない旨を足す（元の失敗は置き換えない）。中断は catch に届かず、記録の無い Worker が残るので onInterrupt でも消す。消す処理自体は中断されない
const withWorkerRollback = <A, R>(credentials: CloudflareCredentials, name: string, place: Effect.Effect<A, CommandFailed, R>) =>
  place.pipe(
    Effect.onInterrupt(() =>
      deleteWorker(credentials, name).pipe(
        Effect.catch((cleanup) => Console.error(`Worker ${name} が残っているかもしれません。Cloudflare のダッシュボードで消してください（削除の失敗: ${cleanup.detail}）`)),
        Effect.uninterruptible,
      ),
    ),
    Effect.catch((failure) =>
      deleteWorker(credentials, name).pipe(
        Effect.uninterruptible,
        Effect.match({
          onSuccess: () => failure,
          onFailure: (cleanup) => new CommandFailed({ message: `${failure.message}\nWorker ${name} が残っているかもしれません。Cloudflare のダッシュボードで消してください（削除の失敗: ${cleanup.detail}）` }),
        }),
        Effect.flatMap((failed) => Effect.fail(failed)),
      ),
    ),
  );

const STILL_THERE = "取り下げられなかった物は、まだ置き場にあります。--anyone で置いた物は、期限まで URL を知る誰でも見られます";
const WORKER_PREFIX = "lmm-";

const readRecords = readPublishRecords().pipe(Effect.mapError((e) => new CommandFailed({ message: describe(e) })));

// 記録の 1 件の Worker を消す。消すのは記録のアカウントの Worker。環境変数のアカウントで消すと、別のアカウントの物は 404（成功扱い）になり、消えていないのに消せた扱いになる
const deleteRecordedWorker = (record: PublishRecord, token: string) =>
  deleteWorker({ accountId: record.accountId, token }, record.name).pipe(Effect.match({ onSuccess: () => undefined, onFailure: (e) => e }));

// publish・list・withdraw の最初に、期限が過ぎても公開中のままの Worker を消して「期限切れで消した」にする（行は残す）。
// 失敗（記録が読めない・資格情報が無い・失効・通信・書き換え）は標準エラーに出すだけで本来のコマンドを止めず、公開中のまま残して次の機会に消し直す
const sweepExpiredPublishes = (token: string | undefined) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const records = yield* readPublishRecords();
    const expired = expiredPublishedRecords(records, now);
    if (expired.length === 0) return;
    if (token === undefined) {
      yield* Console.error(`期限切れの後片付けができませんでした: 期限が過ぎた公開が ${expired.length} 件、置き場に残っています。資格情報が無いので消していません。次の公開・一覧・取り下げで消し直します。期限の後は 410 を返すので中身は見えません`);
      return;
    }
    const deleted: string[] = [];
    for (const record of expired) {
      const outcome = yield* deleteRecordedWorker(record, token);
      if (outcome === undefined) {
        deleted.push(record.name);
        yield* Console.error(`期限が過ぎたので置き場から消しました: ${record.url}`);
      } else {
        yield* Console.error(`期限切れの後片付けができませんでした: ${record.url}（${describeCloudflareFailure(outcome, "期限切れの後片付け")}）。次の公開・一覧・取り下げで消し直します`);
      }
    }
    if (deleted.length > 0) {
      yield* markRecordStatus(deleted, "expired").pipe(
        Effect.catch((e) => Console.error(`Worker は消しましたが、公開の記録を書き換えられませんでした。次の機会に直します: ${PlatformError.isPlatformError(e) ? fileReason(e) : describe(e)}`)),
      );
    }
  }).pipe(
    Effect.catch((e) => Console.error(`期限切れの後片付けができませんでした: ${describe(e)}`)),
  );

// 手元の記録だけから作る。資格情報があるときだけ、記録に無い lmm- の Worker を知らせる（消さない）
const publishList = Command.make(
  "list",
  { all: Flag.Boolean("all").pipe(Flag.withDescription("取り下げた物も含めて全部出す（既定は公開中だけ）"), Flag.withDefault(false)) },
  Effect.fn("publish list")(function* ({ all }) {
    const token = yield* cloudflareApiTokenConfig;
    yield* sweepExpiredPublishes(token);
    const records = yield* readRecords;
    const now = yield* Clock.currentTimeMillis;
    yield* write(formatPublishList(selectListedRecords(records, all), now, all));
    const accountId = yield* cloudflareAccountIdConfig;
    if (accountId === undefined || token === undefined) return;
    const known = new Set(records.map((record) => record.name));
    yield* listWorkerNames({ accountId, token }).pipe(
      Effect.flatMap((names) => writeWarnings(names.filter((name) => name.startsWith(WORKER_PREFIX) && !known.has(name)).map((name) => `記録に無い ${WORKER_PREFIX} の Worker がアカウントにあります（消していません）: ${name}`))),
      Effect.catch((e) => Console.error(`Worker の一覧を取れませんでした。記録に無い Worker は確かめていません: ${describeCloudflareFailure(e, "Worker の一覧の取得")}`)),
    );
  }),
).pipe(Command.withDescription("公開の記録（~/.live-mindmap/publish/records.jsonl）から、公開中の物を表で出す（URL・合言葉・期限・中身の段・元のセッション・状態）。--all で取り下げた物も出す。資格情報があれば、記録に無い lmm- の Worker を知らせるだけで消さない。サーバーもローカルモードも関係しない"));

// 引数の名前・URL を記録に突き合わせる。記録に無い物は stderr に出して数える
const matchWithdrawTargets = Effect.fnUntraced(function* (records: ReadonlyArray<PublishRecord>, targets: ReadonlyArray<string>) {
  const found = new Map<string, PublishRecord>();
  let unmatched = 0;
  for (const target of targets) {
    const wanted = target.replace(/\/$/, "");
    const record = records.find((r) => r.name === wanted || r.url === wanted);
    if (record === undefined) {
      unmatched += 1;
      yield* Console.error(`記録にありません: ${target}`);
    } else found.set(record.name, record);
  }
  return { found: [...found.values()], unmatched };
});

// 記録の Worker を 1 つずつ消す。消せた物の名前と、消せなかった数を返す
const deletePublishedWorkers = Effect.fnUntraced(function* (records: ReadonlyArray<PublishRecord>, token: string) {
  const withdrawn: string[] = [];
  let failed = 0;
  for (const record of records) {
    const outcome = yield* deleteRecordedWorker(record, token);
    if (outcome === undefined) {
      withdrawn.push(record.name);
      yield* write(`取り下げました: ${record.url}`);
    } else {
      failed += 1;
      yield* Console.error(`取り下げられませんでした: ${record.url}（${describeCloudflareFailure(outcome, "取り下げ")}）`);
    }
  }
  return { withdrawn, failed };
});

// 引数は名前か URL。まとめて取り下げる口・セッション単位の口は持たない
const publishWithdraw = Command.make(
  "withdraw",
  { targets: Argument.String("target").pipe(Argument.withDescription("取り下げる Worker の名前か URL（1 つ以上）"), Argument.atLeast(1)) },
  Effect.fn("publish withdraw")(function* ({ targets }) {
    const accountId = yield* cloudflareAccountIdConfig;
    const token = yield* cloudflareApiTokenConfig;
    if (accountId === undefined || token === undefined) return yield* new CommandFailed({ message: `${MISSING_CREDENTIALS_MESSAGE}\n${STILL_THERE}` });
    yield* sweepExpiredPublishes(token);
    const records = yield* readRecords;
    const { found: matched, unmatched } = yield* matchWithdrawTargets(records, targets);
    // 期限が過ぎて後片付けで消した物は、取り下げ（利用者がやめる操作）に書き換えない
    const found = matched.filter((record) => record.status !== "expired");
    for (const record of matched) {
      if (record.status === "expired") yield* write(`期限が過ぎたので既に消してあります: ${record.url}`);
    }
    const { withdrawn, failed } = yield* deletePublishedWorkers(found, token);
    if (withdrawn.length > 0) {
      // 残る物があるときは、記録の書き換えに失敗しても「まだ置き場にある」旨を落とさない
      const remaining = unmatched > 0 || failed > 0 ? `\n${STILL_THERE}` : "";
      yield* markRecordStatus(withdrawn, "withdrawn").pipe(
        Effect.mapError((e) => new CommandFailed({ message: `Worker は消しましたが、公開の記録を書き換えられませんでした: ${PlatformError.isPlatformError(e) ? fileReason(e) : describe(e)}${remaining}` })),
      );
    }
    if (unmatched > 0 || failed > 0) return yield* new CommandFailed({ message: STILL_THERE });
  }),
).pipe(Command.withDescription("公開した Worker を、期限の前にすぐ消す（引数は名前か URL。1 つ以上）。記録の行は残し、状態を「取り下げた」にする。Cloudflare 側に既に無い（404）物は成功。記録に無い名前・URL や消せなかった物があれば 0 以外で返す。まとめて取り下げる口・セッション単位の口は無い。CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN が要る。サーバーもローカルモードも関係しない"));
// remarks・audio の公開を、利用者の確認（--confirmed）なしに置こうとした。Cloudflare に何も送らずに止め、エージェントに利用者へ確かめさせる（終了コード 4）
export class ConfirmationRequired extends Schema.TaggedError<ConfirmationRequired>()("ConfirmationRequired", {
  content: Schema.Literals(["remarks", "audio"]),
  anyone: Schema.Boolean,
}) {
  override get message(): string {
    return publishConfirmationMessage({ content: this.content, anyone: this.anyone });
  }
}

// 中身の段ごとの版。mix の入力はセッションのフォルダ、置く HTML は index.html の名前で作る（どこにも書かない）
const publishVariant = (content: (typeof PUBLISH_CONTENTS)[number]): ReviewVariant =>
  content === "map" ? { file: "index.html", audio: false, mapOnly: true } : { file: "index.html", audio: content === "audio" };

// 置くセッションを決め、手元で分かる理由（log.jsonl が無い・ローカルモード・audio なのに録音が無い）で置けなければ失敗にする
const publishableSession = Effect.fnUntraced(function* (session: Option.Option<string>, content: (typeof PUBLISH_CONTENTS)[number]) {
  const { dir, logPath } = yield* sessionLog(session).pipe(Effect.catchTag("NoSession", (e) => Effect.fail(new CommandFailed({ message: failureLine(e) }))));
  const { events } = yield* readLogLines(logPath).pipe(orFileFailed);
  const start = events.find(hasLoggedType(new Set(["start"])));
  const decodedStart = start === undefined ? undefined : Schema.decodeUnknownResult(StartEvent)(start);
  if (decodedStart !== undefined && Result.isSuccess(decodedStart) && decodedStart.success.model?.local === true) {
    return yield* new CommandFailed({ message: "ローカルモードのセッションは公開できません。会議の中身を Mac の外に出さないためです" });
  }
  if (content === "audio") {
    const variants = yield* reviewVariants(dir).pipe(Effect.mapError((e) => new CommandFailed({ message: describe(e) })));
    if (!variants.some((variant) => variant.audio)) return yield* new CommandFailed({ message: `録音がありません: ${dir}` });
  }
  return { dir, logPath };
});

// 置く中身の段の見返しを作り、公開用の head にする（暗号化の前）
const publishedMapHtml = Effect.fnUntraced(function* (dir: string, logPath: string, content: (typeof PUBLISH_CONTENTS)[number]) {
  const rendered = yield* renderReviewPages(dir, logPath, [publishVariant(content)]).pipe(
    Effect.catchTag("ReviewPageFailed", (e) => Effect.fail(new CommandFailed({ message: e.message }))),
    Effect.catchIf((e) => e instanceof Error, (e) => Effect.fail(new CommandFailed({ message: e.message }))),
  );
  // 公開する中身の音声を作れなかったときは、音声なしで置かずに失敗にする（--self-only と同じ）
  for (const { file, reason } of rendered.skipped) return yield* new CommandFailed({ message: reviewWarning(file, reason) });
  return yield* Effect.try({ try: () => replaceHeadForPublish(rendered.pages[0]!.html), catch: (e) => new CommandFailed({ message: e instanceof Error ? e.message : String(e) }) });
});

const publish = Command.make(
  "publish",
  {
    session: Argument.String("session").pipe(
      Argument.withDescription("置くセッションのフォルダ（省略すると log.jsonl を持つ最新のセッション）"),
      Argument.optional,
    ),
    anyone: Flag.Boolean("anyone").pipe(Flag.withDescription("合言葉なしで、リンクを知る誰でも見られる形で置く（付けないと、製品が作った合言葉で暗号化して置き、URL と合言葉を出す）"), Flag.withDefault(false)),
    content: Flag.Literals("content", PUBLISH_CONTENTS).pipe(Flag.withDescription("置く中身の段（積み上げ式）。map = マップだけ（既定）、remarks = 発言の文字・共有画面の文字も、audio = 録音も（録音が無いセッションでは失敗）"), Flag.withDefault("map")),
    confirmed: Flag.Boolean("confirmed").pipe(Flag.withDescription("利用者に確かめて了解を得たことを示す。remarks・audio ではこれが無いと、何も置かずに終了コード 4 で止まる。map では効果がない"), Flag.withDefault(false)),
    days: Flag.String("days").pipe(Flag.withDescription(`置く期間の日数（1〜${PUBLISH_MAX_DAYS}）。省略すると ${PUBLISH_DEFAULT_DAYS} 日`), Flag.withDefault(String(PUBLISH_DEFAULT_DAYS))),
  },
  Effect.fn("publish")(function* ({ session, anyone, content, confirmed, days }) {
    const dayCount = /^\d+$/.test(days) ? Number(days) : Number.NaN;
    if (!(dayCount >= 1 && dayCount <= PUBLISH_MAX_DAYS)) return yield* new CommandFailed({ message: `--days は 1〜${PUBLISH_MAX_DAYS} の整数で指定してください: ${days}` });
    const { dir, logPath } = yield* publishableSession(session, content);
    const accountId = yield* cloudflareAccountIdConfig;
    const token = yield* cloudflareApiTokenConfig;
    if (accountId === undefined || token === undefined) return yield* new CommandFailed({ message: MISSING_CREDENTIALS_MESSAGE });
    const credentials: CloudflareCredentials = { accountId, token };
    // 手元で分かる失敗を出した後、ビルド・mix・Cloudflare への要求の前に止める。入口の teardown が終了コード 4 にする
    if (content !== "map" && !confirmed) return yield* new ConfirmationRequired({ content, anyone });
    yield* sweepExpiredPublishes(token);

    const mapHtml = yield* publishedMapHtml(dir, logPath, content);
    // 合言葉が既定。暗号化は資格情報の確認の後、Cloudflare への最初の要求（accountSubdomain）の前に行う
    const passphrase = anyone ? undefined : generatePassphrase();
    const html = passphrase === undefined
      ? mapHtml
      : lockedPublishPage(yield* Effect.tryPromise({ try: () => sealWithPassphrase(mapHtml, passphrase), catch: (e) => new CommandFailed({ message: `暗号化に失敗しました: ${describe(e)}` }) }));
    if (Buffer.byteLength(html, "utf8") > PUBLISH_MAX_ASSET_BYTES) {
      return yield* new CommandFailed({ message: `見返しの HTML が Cloudflare の上限（25 MiB）を超えています: ${Buffer.byteLength(html, "utf8")} バイト` });
    }

    const cloudflareFailed = (e: CloudflareFailed) => new CommandFailed({ message: describeCloudflareFailure(e) });
    const subdomain = yield* accountSubdomain(credentials).pipe(Effect.mapError(cloudflareFailed));
    const name = newWorkerName();
    const publishedAt = yield* Clock.currentTimeMillis;
    const expiresAt = publishedAt + dayCount * DAY_MS;
    const url = workerUrl(name, subdomain);
    yield* withWorkerRollback(
      credentials,
      name,
      Effect.gen(function* () {
        yield* deployWorker(credentials, name, html, publishWorkerScript(expiresAt)).pipe(Effect.mapError(cloudflareFailed));
        yield* appendPublishRecord({
          name, url, accountId, dir, level: content, anyone,
          ...(passphrase === undefined ? {} : { passphrase }),
          publishedAt: new Date(publishedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), status: "published",
        }).pipe(Effect.mapError((e) => new CommandFailed({ message: `公開の記録を書けませんでした: ${PlatformError.isPlatformError(e) ? fileReason(e) : describe(e)}` })));
      }),
    );
    yield* write(`${url}\n期限: ${new Date(expiresAt).toISOString()}（${dayCount} 日後。期限の後は 410 を返します）\nURL にはアカウントのサブドメイン（${subdomain}）が出ます\n${passphrase === undefined ? "" : `合言葉: ${passphrase}\nURL と合言葉は別々に渡してください（合言葉は公開の記録 ~/.live-mindmap/publish/records.jsonl にも残ります）\n`}`);
  }),
).pipe(
  Command.withDescription(
    `セッションの見返しを、あなたの Cloudflare アカウントの workers.dev に期限つきで置き、URL・期限・URL に出るアカウントのサブドメイン（合言葉つきなら合言葉も）を出す。既定では製品が作った合言葉で暗号化して置き（置いた中身は Cloudflare からも読めない）、URL と合言葉を出す。--anyone を付けると合言葉なしで、リンクを知る誰でも見られる。期限は既定 ${PUBLISH_DEFAULT_DAYS} 日、--days で 1〜${PUBLISH_MAX_DAYS}。`
      + "--content で中身の段を選ぶ（積み上げ式）。map = マップだけ（既定。発言の文字・共有画面の文字は含めない）、remarks = 発言の文字・共有画面の文字も（map.html と同じ中身）、audio = 録音も（map-audio.html と同じ中身。録音が無いセッションでは失敗）。"
      + "発言の文字・録音を含む公開は、実行する前に利用者に確かめる。remarks・audio で --confirmed が無いと、何も置かずに終了コード 4 で止まり、確かめる内容を出すので、利用者に聞いて了解を得てから --confirmed を付けて実行し直す。map では --confirmed の有無で振る舞いは変わらない。"
      + "CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN（Workers Admin の権限 1 つ）が要る。ローカルモードのセッションは拒む。サーバーは要らない。"
      + "サブコマンド: list（公開中の一覧）、withdraw（期限の前の取り下げ）",
  ),
  Command.withSubcommands([publishList, publishWithdraw]),
);

const root = Command.make("live-mindmap").pipe(
  Command.withDescription(
    "会議の文字起こし・ライブのセッションから、議論のマインドマップを組み立てる（ADR 0003）。"
      + "exit code 3 = 開始に要るものが未導入。exit code 4 = 発言の文字・録音を含む公開で、利用者の確認（--confirmed）が無い",
  ),
  Command.withSubcommands([login, logout, vocab, play, apps, start, recorded, stop, status, share, resume, exportCommand, restore, review, publish, evaluate, models, checkCommand, installCommand, updateCommand, serverCommand]),
);

// argv を受けて走らせるだけ。失敗の表示はしない（入口の reportFailure が 1 か所で持つ）
export const runCli = Command.runWith(root, { version: VERSION });

/* ----------------------------------------------------------------------------
 * 入口
 * -------------------------------------------------------------------------- */

// 失敗の表示はここだけ。共通の前半（entryFailure）で済まないものを、この表で表示する
export const reportFailure = reportEntryFailure((failure) => {
  if (failure instanceof RequiredDepsMissing) return Effect.void;
  if (failure instanceof ModelRefused || failure instanceof ConfirmationRequired) return Console.error(failure.message);
  return Console.error(isCliFailure(failure) ? (failure._tag === "UpdaterUnavailable" || failure._tag === "ChatgptUnavailable" || failure._tag === "ServerFailed" ? failureLine(failure) : oneLine(failureLine(failure))) : describe(failure));
});

export const teardown: Runtime.Teardown = exitCodeTeardown((failure) => (failure instanceof RequiredDepsMissing || failure instanceof StartupDepsMissing ? 3 : failure instanceof ConfirmationRequired ? 4 : undefined));

if (import.meta.main) {
  // ヘルパーが見つからないときは、その文を理由に失敗する mix の Layer を渡す（map-audio.html だけを諦める。録音の無いセッションや map.html には影響しない）
  const helper = resolveHelperPath(process.env);
  const screenJpegLayer = ScreenJpeg.layer.pipe(Layer.provide(NodeServices.layer));
  const audioMixLayer = "error" in helper
    ? AudioMix.unavailable(helper.error)
    : AudioMix.layer({ command: helper.path, args: [] }).pipe(Layer.provide(NodeServices.layer));
  const managedDeps = Layer.unwrap(Effect.gen(function* () {
    const root = yield* depsDirConfig;
    return ManagedDeps.layer({ root }).pipe(Layer.provide(NodeServices.layer));
  }));
  runCli(process.argv.slice(2)).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(Layer.mergeAll(managedDeps, NodeServices.layer, MapCapture.layer.pipe(Layer.provide(Playwright.layer.pipe(Layer.provide(managedDeps)))), ReviewBuild.layer.pipe(Layer.provide(NodeServices.layer)), audioMixLayer, screenJpegLayer, NodeHttpClient.layerUndici, AppleIntelligence.layer(appleCommand).pipe(Layer.provide(NodeChildProcessSpawner.layer), Layer.provide(NodeServices.layer)))),
    NodeRuntime.runMain({ disableErrorReporting: true, teardown }),
  );
}
