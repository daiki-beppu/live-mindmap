#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
// 使い方は各 Command・Flag の withDescription が正本で、`live-mindmap --help` で読む（ADR 0010）。
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Config, Console, Effect, Layer, Option, Predicate, Result, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { HttpServer } from "effect/http";
import { AudioMix } from "./audioMix.ts";
import { MapCapture } from "./capture.ts";
import { claudeUpdaterLayer, UpdaterUnavailable } from "./diffUpdater.ts";
import {
  formatIntakeStatus,
  formatTable,
  DiffUpdater,
  fromTranscript,
  JsonExport,
  SessionLog,
  playback,
  restoreSession,
  toMarkdown,
  TranscriptFile,
  type IntakeStatusReport,
  type Run,
  type Snapshot,
} from "./core/index.ts";
import { openListener, serveFeed } from "./http.ts";
import { resolveHelperPath } from "./helperPath.ts";
import { ReviewBuild, writeReviewPages } from "./review.ts";
import {
  captureWarning,
  createSessionDir,
  EXPORT_FILE,
  LOG_FILE,
  openRecordedSession,
  reviewVariants,
  reviewWarning,
  writeExportFiles,
} from "./sessionFiles.ts";
import { describe, formatIssues, InvalidTruthFile, oneLine, readScreenTruthFile, readTextFile, readTruthFile } from "./truthFile.ts";
import { Viewers } from "./viewers.ts";

// セッションのファイル操作は sessionFiles.ts にある。既存の import 元（cli.ts）を保つために再公開する
export { createSessionDir, openRecordedSession, writeSessionExports, type RecordedSessionOptions } from "./sessionFiles.ts";

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
class BrokenLogLine extends Schema.TaggedError<BrokenLogLine>()("BrokenLogLine", {
  line: Schema.Number,
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

const DEFAULT_PORT = 4319;
export const defaultPort = () => Number(process.env.LIVE_MINDMAP_PORT ?? DEFAULT_PORT);
export const defaultSessionsDir = () => process.env.LIVE_MINDMAP_SESSIONS ?? join(homedir(), ".live-mindmap", "sessions");

// 設定は handler の先頭で 1 回だけ解決する（下位の処理は process.env を読み直さない）。
// ポートは Config.Int（Config.Port は 1 以上しか受けず、空きポートを選ばせる 0 を拒む）
const sessionsDirConfig = Config.String("LIVE_MINDMAP_SESSIONS").pipe(
  Config.withDefault(join(homedir(), ".live-mindmap", "sessions")),
);
const portConfig = Config.Int("LIVE_MINDMAP_PORT").pipe(Config.withDefault(DEFAULT_PORT));

// 標準出力。Console.log が末尾に改行を足すので、改行で終わる文字列はその 1 つを外して渡す
// （出力のバイト列を今と同じに保つ。改行の規則はこの 1 か所だけが持つ）
const write = (text: string) => Console.log(text.endsWith("\n") ? text.slice(0, -1) : text);

// セッションのフォルダ（名前は開始時刻）のうち、file を持つ最新のもの
const latestSession = (sessionsDir: string, file: string) =>
  Effect.suspend(() => {
    const latest = existsSync(sessionsDir)
      ? readdirSync(sessionsDir)
          .filter((d) => existsSync(join(sessionsDir, d, file)))
          .sort()
          .at(-1)
      : undefined;
    return latest === undefined ? new NoSession({ sessionsDir }) : Effect.succeed(latest);
  });

/* ----------------------------------------------------------------------------
 * セッションの保存・公開（ライブのセッションとも共有する）
 * -------------------------------------------------------------------------- */

// 見返し用の HTML を書く。版の一覧は録音の有無で決める（reviewVariants）。mix だけの失敗は結果の skipped に入り、ここでは失敗にしない
const writeReviews = (dir: string, review: ReviewBuild["Service"], audioMix: AudioMix["Service"]) =>
  Effect.try({ try: () => reviewVariants(dir), catch: (e) => new CommandFailed({ message: describe(e) }) }).pipe(
    Effect.flatMap((variants) => writeReviewPages(dir, join(dir, LOG_FILE), variants)),
    Effect.provideService(ReviewBuild, review),
    Effect.provideService(AudioMix, audioMix),
  );

// CLI 側の書き出し。警告は Console（差し替え可能）へ出す以外、writeSessionExports と同じ順・同じ結果
const writeExportsAndCapture = Effect.fnUntraced(function* (
  dir: string,
  snapshot: Snapshot,
  capture: MapCapture["Service"],
  review: ReviewBuild["Service"],
  audioMix: AudioMix["Service"],
) {
  const paths = yield* Effect.try({ try: () => writeExportFiles(dir, snapshot), catch: (e) => new CommandFailed({ message: describe(e) }) });
  const png = join(dir, "map.png");
  const captured = yield* Effect.result(capture.capture(snapshot, png));
  if (Result.isFailure(captured)) yield* Console.error(captureWarning(describe(captured.failure)));
  else paths.push(png);
  const reviewed = yield* Effect.result(writeReviews(dir, review, audioMix));
  if (Result.isFailure(reviewed)) yield* Console.error(reviewWarning("map.html", describe(reviewed.failure)));
  else {
    paths.push(...reviewed.success.paths);
    for (const { file, reason } of reviewed.success.skipped) yield* Console.error(reviewWarning(file, reason));
  }
  return paths;
});

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

const play = Command.make(
  "play",
  {
    transcript: Argument.String("transcript").pipe(Argument.withDescription("再生する文字起こしファイル（kanary transcribe の JSON）")),
    realtime: Flag.Boolean("realtime").pipe(
      Flag.withDescription("発言の時刻どおりに等速で再生する（既定は待ち時間なし）"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("play")(
    function* ({ realtime, transcript }) {
      const sessionsDir = yield* sessionsDirConfig;
      const port = yield* portConfig;
      const capture = yield* MapCapture;
      const review = yield* ReviewBuild;
      const audioMix = yield* AudioMix;
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
      const dir = yield* Effect.try({ try: () => createSessionDir(sessionsDir), catch: (e) => new CommandFailed({ message: describe(e) }) });
      const { session } = yield* openRecordedSession({
        dir,
        title: basename(transcript).replace(/\.transcript\.json$/, ""),
        publish: viewers.publish,
      });
      const text = yield* readTextFile(transcript).pipe(
        Effect.mapError((reason) => new InvalidTranscriptFile({ path: transcript, reason })),
      );
      const file = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TranscriptFile))(text).pipe(
        Effect.mapError((e) => new InvalidTranscriptFile({ path: transcript, reason: decodeReason(e) })),
      );
      // --realtime のときだけ待つ。再生の待ちと、セッションの「最後の発言から一定時間」の待ちは、同じ Clock に乗る
      yield* playback(session, fromTranscript(file), realtime ? { sleep: (ms) => Effect.sleep(ms) } : {});
      const paths = yield* writeExportsAndCapture(dir, yield* session.snapshot, capture, review, audioMix);
      yield* write(paths.map((path) => `${path}\n`).join(""));
    },
    Effect.scoped,
  ),
).pipe(
  Command.withDescription(
    "録音サンプルの文字起こしを再生し、マップを組み立てる（既定は待ち時間なし、--realtime で等速）。"
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
  },
  Effect.fn("start")(function* ({ app, noAudio, title }) {
    const port = yield* portConfig;
    const { dir } = yield* requestServer(port, "POST", "/session/start", Schema.decodeUnknownEffect(StartedSession), {
      app,
      title: Option.getOrUndefined(title),
      audio: !noAudio,
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
    const text = yield* readTextFile(path).pipe(Effect.mapError((message) => new CommandFailed({ message })));
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
    const text = yield* readTextFile(join(dir, LOG_FILE)).pipe(Effect.mapError((message) => new CommandFailed({ message })));
    // 行番号は空行を除く前に採る（人がログを開いたときの行と合わせる）
    const lines = text
      .split("\n")
      .map((line, i) => ({ text: line, no: i + 1 }))
      .filter((line) => line.text.trim() !== "");
    const events: unknown[] = [];
    for (const line of lines) {
      events.push(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(line.text).pipe(
          Effect.mapError((e) => new BrokenLogLine({ line: line.no, reason: decodeReason(e) })),
        ),
      );
    }
    // 復元では差分更新を呼ばない。呼ばれたら defect にする。ログは書き直さない
    const session = yield* restoreSession(events).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DiffUpdater)(DiffUpdater.of({ update: () => Effect.die("restore では差分更新を呼べません") })),
          Layer.succeed(SessionLog)(SessionLog.of({ write: () => Effect.void })),
        ),
      ),
      // 壊れた行は、空行を除く前の行番号の BrokenLogLine にする
      Effect.catchTag("InvalidLogEvent", (e) => Effect.fail(new BrokenLogLine({ line: lines[e.index]?.no ?? 1, reason: e.reason }))),
    );
    const exported = yield* session.exportJson;
    yield* Effect.try({
      try: () => writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(exported)),
      catch: (e) => new CommandFailed({ message: describe(e) }),
    });
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
  },
  Effect.fn("review")(function* ({ session }) {
    const dir = Option.isSome(session)
      ? resolve(session.value)
      : yield* Effect.gen(function* () {
          const sessionsDir = yield* sessionsDirConfig;
          return resolve(sessionsDir, yield* latestSession(sessionsDir, LOG_FILE));
        });
    const logPath = join(dir, LOG_FILE);
    if (!existsSync(logPath)) return yield* new CommandFailed({ message: `${LOG_FILE} がありません: ${logPath}` });
    const { paths, skipped } = yield* writeReviews(dir, yield* ReviewBuild, yield* AudioMix).pipe(
      Effect.mapError((e) => new CommandFailed({ message: reviewWarning("map.html", describe(e)) })),
    );
    // mix だけの失敗は、map.html を書いて成功のまま終える。書けなかった理由は標準エラーに出す
    for (const { file, reason } of skipped) yield* Console.error(reviewWarning(file, reason));
    yield* write(paths.map((path) => `${path}\n`).join(""));
  }),
).pipe(
  Command.withDescription(
    "セッションの log.jsonl から、見返し用の map.html を作り直してパスを出す。フォルダに録音（相手*.m4a・自分*.m4a）があれば、その後に音声つきの map-audio.html も作る（mix が失敗したら map-audio.html だけ諦めて、理由を標準エラーに出す）。サーバーは要らない",
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
    const runs: Run[] = [];
    for (const dir of sessions) {
      const path = join(dir, EXPORT_FILE);
      if (!existsSync(path)) return yield* new MissingRunExport({ path });
      const text = yield* readTextFile(path).pipe(Effect.mapError((message) => new CommandFailed({ message })));
      const exp = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonExport))(text).pipe(
        Effect.mapError((e) => new CommandFailed({ message: `${path} が読めません: ${decodeReason(e)}` })),
      );
      runs.push({ name: basename(dir), title: exp.root.text, exp });
    }
    yield* write(formatTable(runs, expected, screen));
  }),
).pipe(
  Command.withDescription(
    "play で作ったランの指標を 1 ラン 1 行の表で出す。--truth を渡すと決定・TODO の再現率も、--screen-truth を渡すと指す発言・うち記憶・話だけ・出てはいけないの列も出す"
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
  const audioMixLayer = "error" in helper
    ? AudioMix.unavailable(helper.error)
    : AudioMix.layer({ command: helper.path, args: [] }).pipe(Layer.provide(NodeServices.layer));
  runCli(process.argv.slice(2)).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(Layer.mergeAll(NodeServices.layer, MapCapture.layer, ReviewBuild.layer, audioMixLayer)),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
