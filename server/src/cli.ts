#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
// 使い方は各 Command・Flag の withDescription が正本で、`live-mindmap --help` で読む（ADR 0010）。
import { basename, dirname, join, resolve } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem, Layer, Option, PlatformError, Predicate, Result, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { HttpServer } from "effect/http";
import { AudioMix } from "./audioMix.ts";
import { MapCapture } from "./capture.ts";
import { portConfig, sessionsDirConfig } from "./config.ts";
import { withoutFinalNewline } from "./consoleText.ts";
import { claudeUpdaterLayer, UpdaterUnavailable } from "./diffUpdater.ts";
import {
  formatIntakeStatus,
  formatTable,
  DiffUpdater,
  fromTranscript,
  JsonExport,
  LogEvent,
  SessionLog,
  playback,
  type PlaybackScreen,
  type Remark,
  restoreSession,
  restoreState,
  toMarkdown,
  TranscriptFile,
  type IntakeStatusReport,
  type Run,
  type Snapshot,
} from "./core/index.ts";
import { openListener, serveFeed } from "./http.ts";
import { resolveHelperPath } from "./helperPath.ts";
import { BrokenLogLine, readLogLines } from "./logLines.ts";
import { ReviewBuild, writeReviewPages } from "./review.ts";
import { ScreenJpeg } from "./screenJpeg.ts";
import { parseSlides, slideChanges } from "./screenSlides.ts";
import {
  createSessionDir,
  EXPORT_FILE,
  LOG_FILE,
  openRecordedSession,
  SCREENS_DIR,
  reviewVariants,
  reviewWarning,
  selfReviewVariants,
  writeExportsAndCapture,
  writeReviews,
} from "./sessionFiles.ts";
import { describe, fileReason, formatIssues, InvalidTruthFile, oneLine, readScreenTruthFile, readTextFile, readTruthFile } from "./truthFile.ts";
import { Viewers } from "./viewers.ts";

// セッションのファイル操作は sessionFiles.ts にある。既存の import 元（cli.ts）を保つために再公開する
export { createSessionDir, openRecordedSession, type RecordedSessionOptions } from "./sessionFiles.ts";

// server/package.json は private で version を持たないので、--version の正本はここに置く
const VERSION = "0.1.0";

/* ----------------------------------------------------------------------------
 * 失敗: サブコマンドの中身の失敗はタグ付きにし、入口の表 1 つで日本語の 1 行に変える
 * -------------------------------------------------------------------------- */

class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()("ServerUnreachable", {}) {}
class ServerFailed extends Schema.TaggedError<ServerFailed>()("ServerFailed", { message: Schema.String }) {}
class NoSession extends Schema.TaggedError<NoSession>()("NoSession", { sessionsDir: Schema.String }) {}
class MissingRunExport extends Schema.TaggedError<MissingRunExport>()("MissingRunExport", { path: Schema.String }) {}
class InvalidTranscriptFile extends Schema.TaggedError<InvalidTranscriptFile>()("InvalidTranscriptFile", {
  path: Schema.String,
  reason: Schema.String,
}) {}
// 下位のモジュール（配信・再生・ファイルの読み書き）の失敗。message はそのまま入口の 1 行になる
class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", { message: Schema.String }) {}

type CliFailure =
  | ServerUnreachable
  | ServerFailed
  | NoSession
  | MissingRunExport
  | InvalidTruthFile
  | InvalidTranscriptFile
  | BrokenLogLine
  | CommandFailed
  | UpdaterUnavailable;

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
      return failure.message;
  }
};

const CLI_FAILURE_TAGS: ReadonlySet<string> = new Set<CliFailure["_tag"]>([
  "ServerUnreachable",
  "ServerFailed",
  "NoSession",
  "MissingRunExport",
  "InvalidTruthFile",
  "InvalidTranscriptFile",
  "BrokenLogLine",
  "CommandFailed",
  "UpdaterUnavailable",
]);

const isCliFailure = (failure: unknown): failure is CliFailure =>
  Predicate.hasProperty(failure, "_tag") && Predicate.isString(failure._tag) && CLI_FAILURE_TAGS.has(failure._tag);

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

// ファイル操作の失敗（PlatformError）を入口の 1 行にする。理由は OS のエラー（ENOENT など）の文面
const fileFailed = (e: PlatformError.PlatformError) => new CommandFailed({ message: fileReason(e) });
const orFileFailed = <A, E, R>(effect: Effect.Effect<A, E | PlatformError.PlatformError, R>) =>
  effect.pipe(Effect.catchIf(PlatformError.isPlatformError, (e) => Effect.fail(fileFailed(e))));

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
const StartedSession = Schema.Struct({ dir: Schema.String });
const StoppedSession = Schema.Struct({ paths: Schema.Array(Schema.String) });
const IntakeStatus = Schema.Struct({
  status: Schema.Literals(["none", "running", "interrupted", "stopped"]),
  dir: Schema.optionalKey(Schema.String),
  restarts: Schema.optionalKey(Schema.Number),
  lastInterruptedAt: Schema.optionalKey(Schema.String),
});

// 常駐サーバーへ依頼を送り、応答を decode する。2xx 以外は、応答の { error } をそのまま入口の 1 行にする
const requestServer = <A>(
  port: number,
  method: "GET" | "POST",
  path: string,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  body?: object,
) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        }),
      catch: () => new ServerUnreachable(),
    });
    // 応答の本文が JSON でなくても、状態コードから作る 1 行で伝えられるようにする（今と同じ）
    const raw = yield* Effect.tryPromise((): Promise<unknown> => response.json()).pipe(
      Effect.catch(() => Effect.succeed<unknown>({})),
    );
    if (!response.ok) {
      const reported = yield* Schema.decodeUnknownEffect(ServerErrorBody)(raw).pipe(
        Effect.catch(() => Effect.succeed<{ readonly error?: string }>({})),
      );
      return yield* new ServerFailed({ message: reported.error ?? `サーバーがエラーを返しました: ${response.status}` });
    }
    return yield* decode(raw).pipe(Effect.mapError((e) => new ServerFailed({ message: `サーバーの応答が読めません: ${decodeReason(e)}` })));
  });

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

// セッションのフォルダ（log.jsonl を持つフォルダ）のログから、再生に渡す題名・発言・共有画面の変化を読む。
// 流すのは start（題名）・remark・screen・screen-off だけで、ほかの行（intake-*・diff など）は読み飛ばす。
// 画像は元のフォルダの screens/ から、入れる直前に読む。変化の時刻はログの start をそのまま使う
const loadRecordedSession = Effect.fn("loadRecordedSession")(function* (dir: string) {
  const logPath = join(dir, LOG_FILE);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* pathExists(fs, logPath).pipe(orFileFailed))) return yield* new CommandFailed({ message: `${LOG_FILE} がありません: ${logPath}` });
  const { lines, events } = yield* readLogLines(logPath).pipe(orFileFailed);
  let title: string | undefined;
  const remarks: Remark[] = [];
  const screens: PlaybackScreen<CommandFailed>[] = [];
  for (const [i, event] of events.entries()) {
    if (!Predicate.isObject(event) || !("type" in event)) continue;
    if (!(event.type === "start" || event.type === "remark" || event.type === "screen" || event.type === "screen-off")) continue;
    const decoded = yield* Schema.decodeUnknownEffect(LogEvent)(event).pipe(
      Effect.mapError((e) => new BrokenLogLine({ line: lines[i]?.no ?? 1, reason: decodeReason(e) })),
    );
    switch (decoded.type) {
      case "start":
        title ??= decoded.title;
        break;
      case "remark":
        remarks.push(decoded.remark);
        break;
      case "screen": {
        const { start, image } = decoded;
        if (image === null) {
          screens.push({ start, image: null });
          break;
        }
        // ログ由来の image は、screens/ 直下の単一のファイル名だけを認める（外のファイルを読まない）
        const screensDir = resolve(dir, SCREENS_DIR);
        const path = resolve(screensDir, image);
        // basename 比較で区切り文字を含む値（絶対パス・../・./）を、dirname 比較で ""・.・.. を拒否する
        if (basename(image) !== image || dirname(path) !== screensDir) {
          return yield* new CommandFailed({ message: `${LOG_FILE} ${lines[i]?.no ?? 1} 行目の image が screens/ 直下のファイル名ではありません: ${image}` });
        }
        screens.push({
          start,
          image: {
            id: image,
            load: fs.readFile(path).pipe(Effect.mapError((e) => new CommandFailed({ message: `${path} が読めません: ${e.message}` }))),
          },
        });
        break;
      }
      case "screen-off":
        screens.push({ start: decoded.start, reason: decoded.reason });
        break;
      case "diff":
        break;
    }
  }
  if (title === undefined) return yield* new CommandFailed({ message: `${LOG_FILE} に start の行がありません: ${logPath}` });
  return { title, remarks, screens };
});

const readTranscriptRemarks = Effect.fn("readTranscriptRemarks")(function* (transcript: string) {
  const text = yield* readTextFile(transcript).pipe(Effect.mapError((e) => new InvalidTranscriptFile({ path: transcript, reason: fileReason(e) })));
  const file = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TranscriptFile))(text).pipe(
    Effect.mapError((e) => new InvalidTranscriptFile({ path: transcript, reason: decodeReason(e) })),
  );
  return [...fromTranscript(file)];
});

// 無いパスは false（ファイルを渡す play の入口でも失敗にしない）
const isDirectory = Effect.fn("isDirectory")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(path)) && (yield* fs.stat(path)).type === "Directory";
}, orFileFailed);

const play = Command.make(
  "play",
  {
    transcript: Argument.String("source").pipe(
      Argument.withDescription(
        "再生する文字起こしファイル（kanary transcribe の JSON）、または過去のセッションのフォルダ（log.jsonl を持つフォルダ）。"
          + "フォルダのときは、ログの発言と共有画面の変化（screen・screen-off）を元の時刻のまま流し、画像は元のフォルダの screens/ から読む。題名は元の start の行から取る",
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
    function* ({ realtime, screen, transcript }) {
      const sessionsDir = yield* sessionsDirConfig;
      const port = yield* portConfig;
      const folder = yield* isDirectory(transcript);
      if (folder && Option.isSome(screen)) {
        return yield* new CommandFailed({ message: "セッションのフォルダと --screen は一緒に使えません" });
      }
      // セッションのフォルダはログを再生の前にすべて読む。壊れていれば何も始めずに失敗する（画像は入れる直前に読む）
      const recorded = folder ? yield* loadRecordedSession(resolve(transcript)) : undefined;
      // 共有画面は再生を始める前にすべて読み、JPEG にする。読めなければ何も始めずに失敗する
      const screens: Iterable<PlaybackScreen<CommandFailed>> = recorded
        ? recorded.screens
        : Option.isSome(screen) ? yield* loadScreens(screen.value) : [];
      // 配信は play の Scope が持つ。再生と書き出しが終わって Scope を閉じるときに、待受けも閉じる
      const { viewers, httpServer } = yield* openListener(port).pipe(
        Effect.mapError((e) => new CommandFailed({ message: describe(e) })),
      );
      yield* serveFeed.pipe(
        Effect.provideService(Viewers, viewers),
        Effect.provideService(HttpServer.HttpServer, httpServer),
      );
      // 待受けを閉じる前に、最後のスナップショットを接続中のクライアントへ渡し切る
      yield* Effect.addFinalizer(() => viewers.drained);
      const dir = yield* createSessionDir(sessionsDir).pipe(Effect.mapError((e) => new CommandFailed({ message: describe(e) })));
      const { session } = yield* openRecordedSession({
        dir,
        title: recorded ? recorded.title : basename(transcript).replace(/\.transcript\.json$/, ""),
        publish: viewers.publish,
      });
      const remarks = recorded ? recorded.remarks : yield* readTranscriptRemarks(transcript);
      // --realtime のときだけ待つ。再生の待ちと、セッションの「最後の発言から一定時間」の待ちは、同じ Clock に乗る
      yield* playback(session, remarks, { ...(realtime ? { sleep: (ms: number) => Effect.sleep(ms) } : {}), screens });
      const paths = yield* writeExportsAndCapture(dir, yield* session.snapshot, describe).pipe(
        Effect.mapError((e) => new CommandFailed({ message: e.message })),
      );
      yield* write(paths.map((path) => `${path}\n`).join(""));
    },
    Effect.scoped,
  ),
).pipe(
  Command.withDescription(
    "録音サンプルの文字起こし、または過去のセッションのフォルダ（log.jsonl を持つフォルダ）を再生し、マップを組み立てる（既定は待ち時間なし、--realtime で等速）。"
      + "フォルダのときは、ログの発言と共有画面の変化を元の時刻のまま流し、新しいセッションのフォルダにライブと同じ形でログと screens/ を書く。"
      + "再生中は WebSocket で、反映のたびにマップ全体をブラウザへ送る。"
      + "終わると、セッションのフォルダに map.md・map.json・map.drawnix・map.png・map.html を書き出し、そのパスを出す（play のセッションには録音が無いので map-audio.html は作らない）",
  ),
  // 差分更新は play だけが使う。Layer が取得と解放を持ち、最後の反映と最終撮影の後に 1 回だけ閉じる
  Command.provide(claudeUpdaterLayer),
);

const apps = Command.make(
  "apps",
  {},
  Effect.fn("apps")(function* () {
    const port = yield* portConfig;
    // 一覧の中身は CLI が使わないので、形を決めずにそのまま出す
    const list = yield* requestServer(port, "GET", "/apps", Schema.decodeUnknownEffect(Schema.Unknown));
    yield* write(JSON.stringify(list, null, 2) + "\n");
  }),
).pipe(Command.withDescription("会議アプリの一覧（JSON）を出す。常駐サーバー（pnpm dev）に頼む"));

const start = Command.make(
  "start",
  {
    app: Flag.String("app").pipe(Flag.withDescription("会議アプリの bundle id（例 us.zoom.xos）")),
    title: Flag.String("title").pipe(Flag.withDescription("会議の名前（省略するとセッションの開始時刻）"), Flag.optional),
    noAudio: Flag.Boolean("no-audio").pipe(
      Flag.withDescription("トラックごとの録音（相手.m4a・自分.m4a）をセッションのフォルダに残さない（既定は残す）"),
      Flag.withDefault(false),
    ),
    noScreen: Flag.Boolean("no-screen").pipe(
      Flag.withDescription("共有画面を AI に渡さない（取り込まない）"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("start")(function* ({ app, noAudio, noScreen, title }) {
    const port = yield* portConfig;
    const { dir } = yield* requestServer(port, "POST", "/session/start", Schema.decodeUnknownEffect(StartedSession), {
      app,
      title: Option.getOrUndefined(title),
      audio: !noAudio,
      screen: !noScreen,
    });
    yield* write(`${dir}\n`);
  }),
).pipe(
  Command.withDescription(
    "ライブのセッションを開始する。サーバーがヘルパーを起動し、セッションのフォルダを出す。同時に 1 つだけ",
  ),
);

const stop = Command.make(
  "stop",
  {},
  Effect.fn("stop")(function* () {
    const port = yield* portConfig;
    const { paths } = yield* requestServer(port, "POST", "/session/stop", Schema.decodeUnknownEffect(StoppedSession));
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
    const report: IntakeStatusReport = yield* requestServer(port, "GET", "/session/status", Schema.decodeUnknownEffect(IntakeStatus));
    yield* write(formatIntakeStatus(report));
  }),
).pipe(
  Command.withDescription(
    "取り込みの状態（動いている／途切れている／止まった／セッションなし）・セッションのフォルダ・"
      + "起動し直した回数・最後の途切れの時刻を出す",
  ),
);

const resume = Command.make(
  "resume",
  {},
  Effect.fn("resume")(function* () {
    const port = yield* portConfig;
    yield* requestServer(port, "POST", "/session/resume", Schema.decodeUnknownEffect(Schema.Unknown));
  }),
).pipe(
  Command.withDescription("止まった状態（起動し直しを諦めた状態）から、ヘルパーを起動し直して同じセッションを続ける"),
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
      const raw = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError((e) => new CommandFailed({ message: `${path} が JSON として読めません: ${decodeReason(e)}` })),
      );
      yield* write(JSON.stringify(raw, null, 2) + "\n");
      return;
    }
    const exported = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonExport))(text).pipe(
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
    yield* write(`${dir}\n`);
  }, Effect.scoped),
).pipe(Command.withDescription("最新のセッションのログから、差分更新を呼ばずにマップを戻す"));

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
    const dir = Option.isSome(session)
      ? resolve(session.value)
      : yield* Effect.gen(function* () {
          const sessionsDir = yield* sessionsDirConfig;
          return resolve(sessionsDir, yield* latestSession(sessionsDir, LOG_FILE));
        });
    const logPath = join(dir, LOG_FILE);
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* pathExists(fs, logPath).pipe(orFileFailed))) return yield* new CommandFailed({ message: `${LOG_FILE} がありません: ${logPath}` });
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

const evaluate = Command.make(
  "eval",
  {
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
  Effect.fn("eval")(function* ({ sessions, truth, screenTruth }) {
    // 正解ファイルの検証は共有の readTruthFile（段 1 の Truth の Schema）が持つ（Flag 側では検証しない）
    const expected = Option.isNone(truth) ? undefined : yield* readTruthFile(truth.value);
    const screen = Option.isNone(screenTruth) ? undefined : yield* readScreenTruthFile(screenTruth.value);
    const fs = yield* FileSystem.FileSystem;
    const runs: Run[] = [];
    for (const dir of sessions) {
      const path = join(dir, EXPORT_FILE);
      if (!(yield* pathExists(fs, path).pipe(orFileFailed))) return yield* new MissingRunExport({ path });
      const text = yield* readTextFile(path).pipe(Effect.mapError(fileFailed));
      const exp = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonExport))(text).pipe(
        Effect.mapError((e) => new CommandFailed({ message: `${path} が読めません: ${decodeReason(e)}` })),
      );
      const logPath = join(dir, LOG_FILE);
      if (!(yield* pathExists(fs, logPath).pipe(orFileFailed))) {
        runs.push({ name: basename(dir), title: exp.root.text, exp });
        continue;
      }
      // 検証は restore と同じ restoreState で行う。壊れた行は、どのランか分かるようにパスと行番号を添えて失敗にする
      const { lines, events } = yield* readLogLines(logPath).pipe(
        orFileFailed,
        Effect.catchTag("BrokenLogLine", (e) => Effect.fail(new CommandFailed({ message: `${logPath} の ${e.line} 行目が JSON として読めません: ${e.reason}` }))),
      );
      yield* restoreState(events).pipe(
        Effect.catchTag("InvalidLogEvent", (e) => Effect.fail(new CommandFailed({ message: `${logPath} の ${lines[e.index]?.no ?? 1} 行目が読めません: ${e.reason}` }))),
      );
      const log: LogEvent[] = [];
      for (const event of events) {
        if (!Predicate.isObject(event) || !("type" in event) || !(event.type === "start" || event.type === "remark" || event.type === "diff")) continue;
        log.push(yield* Schema.decodeUnknownEffect(LogEvent)(event).pipe(Effect.orDie));
      }
      runs.push({ name: basename(dir), title: exp.root.text, exp, log });
    }
    yield* write(formatTable(runs, expected, screen));
  }),
).pipe(
  Command.withDescription(
    "play で作ったランの指標を 1 ラン 1 行の表で出す。log.jsonl があれば、本文の書き換えの回数÷発言の数・1 ノードの書き換えの最多・話し中の兄弟の最多も出す（無ければ -）。--truth を渡すと決定・TODO の再現率も、--screen-truth を渡すと指す発言・うち記憶・話だけ・出てはいけないの列も出す"
      + "（当たる条件と 1 対 1 の数え方は core/evaluate.ts の matches・recall が持つ）",
  ),
);

const root = Command.make("live-mindmap").pipe(
  Command.withDescription("会議の文字起こし・ライブのセッションから、議論のマインドマップを組み立てる（ADR 0003）"),
  Command.withSubcommands([play, apps, start, stop, status, resume, exportCommand, restore, review, evaluate]),
);

// argv を受けて走らせるだけ。失敗の表示はしない（入口の reportFailure が 1 か所で持つ）
export const runCli = Command.runWith(root, { version: VERSION });

/* ----------------------------------------------------------------------------
 * 入口
 * -------------------------------------------------------------------------- */

// 失敗の表示はここだけ。CliError（help・引数の誤り）は effect/cli が出力済みなので二重に出さない
const reportFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findError(cause);
  if (Result.isFailure(error)) return Console.error(describe(Cause.squash(cause)));
  const failure = error.success;
  if (CliError.isCliError(failure)) return Effect.void;
  return Console.error(isCliFailure(failure) ? oneLine(failureLine(failure)) : describe(failure));
};

if (import.meta.main) {
  // ヘルパーが見つからないときは、その文を理由に失敗する mix の Layer を渡す（map-audio.html だけを諦める。録音の無いセッションや map.html には影響しない）
  const helper = resolveHelperPath(process.env);
  const screenJpegLayer = ScreenJpeg.layer.pipe(Layer.provide(NodeServices.layer));
  const audioMixLayer = "error" in helper
    ? AudioMix.unavailable(helper.error)
    : AudioMix.layer({ command: helper.path, args: [] }).pipe(Layer.provide(NodeServices.layer));
  runCli(process.argv.slice(2)).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(Layer.mergeAll(NodeServices.layer, MapCapture.layer, ReviewBuild.layer.pipe(Layer.provide(NodeServices.layer)), audioMixLayer, screenJpegLayer)),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
