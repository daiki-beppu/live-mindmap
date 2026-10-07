#!/usr/bin/env node
// live-mindmap の CLI。AI エージェントが Bash から呼ぶ（ADR 0003）。
// 使い方は各 Command・Flag の withDescription が正本で、`live-mindmap --help` で読む（ADR 0010）。
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Config, Console, Effect, Layer, Option, Predicate, Queue, Result, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { HttpServer } from "effect/http";
import { MapCapture, type PromiseMapCapture } from "./capture.ts";
import { DiffUpdater, UpdaterUnavailable } from "./diffUpdater.ts";
import {
  createSession,
  exportFiles,
  formatIntakeStatus,
  formatTable,
  fromTranscript,
  JsonExport,
  playback,
  restoreSession,
  toJsonExport,
  toMarkdown,
  TranscriptFile,
  type DiffUpdater as UpdateFn,
  type IntakeLogEvent,
  type IntakeStatusReport,
  type LogEvent,
  type Run,
  type Session,
  type Snapshot,
} from "./core/index.ts";
import { openListener, serveFeed } from "./http.ts";
import { ReviewBuild, writeReviewPages, type PromiseReviewPages, type ReviewVariant } from "./review.ts";
import { describe, formatIssues, InvalidTruthFile, oneLine, readTextFile, readTruthFile } from "./truthFile.ts";
import { Viewers } from "./viewers.ts";

// server/package.json は private で version を持たないので、--version の正本はここに置く
const VERSION = "0.1.0";

// セッションのフォルダに置く、その時点のエクスポート。別のプロセスの export がこれを読む。
// play もライブのセッションも、作成直後と log のたびに書く。サーバーが動いていなくても export できる。
const EXPORT_FILE = "export.json";
const LOG_FILE = "log.jsonl";

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

// テキストの 3 形式（map.md・map.json・map.drawnix）を書き、書いたパスを順に返す
function writeExportFiles(dir: string, snapshot: Snapshot): string[] {
  return Object.entries(exportFiles(toJsonExport(snapshot, snapshot.remarks))).map(([name, content]) => {
    const path = join(dir, name);
    writeFileSync(path, content.endsWith("\n") ? content : content + "\n");
    return path;
  });
}

const captureWarning = (reason: string) => `map.png を書き出せませんでした: ${reason}`;
const reviewWarning = (reason: string) => `map.html を書き出せませんでした: ${reason}`;

// 見返し用の HTML の版。今は map.html だけ
const REVIEW_VARIANTS: readonly ReviewVariant[] = [{ file: "map.html" }];

// セッション終了時の書き出し。スナップショットは 1 回だけ取り、5 形式（md・json・drawnix・png・html）を書く。
// ライブのセッションの終了処理からも、この関数を呼ぶ。書いたファイルのパスを順に返す。
// テキストの 3 形式を先に書く。撮影・HTML の書き出しは互いに独立で、失敗したもの（Chromium が無い等）だけ諦めて、
// 標準エラーに理由を残し、書けたもののパスを返す。
export async function writeSessionExports(
  dir: string,
  snapshot: Snapshot,
  capture: PromiseMapCapture,
  writeReview: PromiseReviewPages,
): Promise<string[]> {
  const paths = writeExportFiles(dir, snapshot);
  const png = join(dir, "map.png");
  try {
    await capture(snapshot, png);
    paths.push(png);
  } catch (e) {
    process.stderr.write(captureWarning(e instanceof Error ? e.message : String(e)) + "\n");
  }
  try {
    paths.push(...(await writeReview(dir, join(dir, LOG_FILE), REVIEW_VARIANTS)));
  } catch (e) {
    process.stderr.write(reviewWarning(e instanceof Error ? e.message : String(e)) + "\n");
  }
  return paths;
}

// CLI 側の書き出し。警告は Console（差し替え可能）へ出す以外、writeSessionExports と同じ順・同じ結果
const writeExportsAndCapture = Effect.fnUntraced(function* (
  dir: string,
  snapshot: Snapshot,
  capture: MapCapture["Service"],
  review: ReviewBuild["Service"],
) {
  const paths = yield* Effect.try({ try: () => writeExportFiles(dir, snapshot), catch: (e) => new CommandFailed({ message: describe(e) }) });
  const png = join(dir, "map.png");
  const captured = yield* Effect.result(capture.capture(snapshot, png));
  if (Result.isFailure(captured)) yield* Console.error(captureWarning(describe(captured.failure)));
  else paths.push(png);
  const reviewed = yield* Effect.result(
    writeReviewPages(dir, join(dir, LOG_FILE), REVIEW_VARIANTS).pipe(Effect.provideService(ReviewBuild, review)),
  );
  if (Result.isFailure(reviewed)) yield* Console.error(reviewWarning(describe(reviewed.failure)));
  else paths.push(...reviewed.success);
  return paths;
});

// セッションのフォルダ（名前は開始時刻）を作る。ライブでは、ヘルパーの起動前に作って録音の書き出し先として渡す
export function createSessionDir(sessionsDir: string): string {
  const dir = join(sessionsDir, new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type RecordedSessionOptions = {
  dir: string; // createSessionDir で作ったセッションのフォルダ
  title?: string; // 省略したときは、セッションのフォルダ名（開始時刻）
  updater: UpdateFn;
  publish: (snapshot: Snapshot) => void;
  sleep?: (ms: number) => Promise<void>; // 渡すと、最後の発言から一定時間たまった発言を 1 つでも差分更新に渡す
  onDiff?: () => void; // 差分更新の 1 回が終わった（成功の publish の後・失敗のとき）。未反映の発言が変わったことを知らせる
};

// 作成済みのセッションのフォルダに、ログと export.json を書きながら、マップが変わるたびに publish する。
// play もライブのセッションも、この 1 つの配線で動かす（出どころだけが違う）。
// appendLog は、サーバーが取り込みの途切れ等（LogEvent ではない独自の種類）を log.jsonl へ追記するための口。
// session のログと同じ書き先・同じ at 付きの形を共有するが、export.json は書き直さない（マップを変えない記録のため）。
export function startRecordedSession({ dir, title, updater, publish, sleep, onDiff }: RecordedSessionOptions): { session: Session; appendLog: (event: IntakeLogEvent) => void } {
  // 書き先（log.jsonl）と at 付きの形は、session のログ（LogEvent）とサーバーの独自の記録（IntakeLogEvent）で共有する
  const writeLogLine = (event: LogEvent | IntakeLogEvent) => {
    appendFileSync(join(dir, LOG_FILE), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  };
  // 開始のイベントは createSession の中で log されるので、session の代入前は export.json を書けない
  let session: Session | undefined;
  session = createSession({
    title: title ?? basename(dir),
    updater,
    sleep,
    log: (event) => {
      writeLogLine(event);
      if (!session) return;
      writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(session.exportJson()));
      if (event.type !== "diff") return;
      if (!event.error) publish(session.snapshot());
      onDiff?.();
    },
  });
  // 発言が 1 件も来なくても、export が前のセッションではなくこのセッションのマップを返すように、作成直後にも書く
  writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(session.exportJson()));
  publish(session.snapshot()); // 最初のルート
  return { session, appendLog: writeLogLine };
}

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
 * --realtime の待ち: Promise を待つ playback・session へ、Effect の時計に乗る sleep を渡す
 * -------------------------------------------------------------------------- */

// 要求を Queue で受け、要求ごとに子 fiber で Effect.sleep する。再生の間隔待ちと QUIET_MS の静穏待ちは
// 同時に進むので、要求を直列に処理しない。scope が閉じれば待っている要求ごと止まる（古い待ちで Session を進めない）
const effectSleep = Effect.gen(function* () {
  const requests = yield* Queue.make<{ readonly ms: number; readonly resolve: () => void }>();
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.flatMap(Queue.take(requests), ({ ms, resolve }) =>
        Effect.forkChild(
          Effect.gen(function* () {
            yield* Effect.sleep(ms);
            resolve();
          }),
          { startImmediately: true },
        ),
      ),
    ),
  );
  return (ms: number) =>
    new Promise<void>((resolve) => {
      Queue.offerUnsafe(requests, { ms, resolve });
    });
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
      const updater = yield* DiffUpdater;
      const capture = yield* MapCapture;
      const review = yield* ReviewBuild;
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
      // --realtime のときだけ待つ。再生の待ちと、セッションの「最後の発言から一定時間」の待ちで同じ sleep を使う
      const sleep = realtime ? yield* effectSleep : undefined;
      const dir = yield* Effect.try({ try: () => createSessionDir(sessionsDir), catch: (e) => new CommandFailed({ message: describe(e) }) });
      const { session } = yield* Effect.try({
        try: () =>
          startRecordedSession({
            dir,
            title: basename(transcript).replace(/\.transcript\.json$/, ""),
            updater: updater.update,
            publish: (snapshot) => Effect.runSync(viewers.publish(snapshot)),
            sleep,
          }),
        catch: (e) => new CommandFailed({ message: describe(e) }),
      });
      const text = yield* readTextFile(transcript).pipe(
        Effect.mapError((reason) => new InvalidTranscriptFile({ path: transcript, reason })),
      );
      const file = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TranscriptFile))(text).pipe(
        Effect.mapError((e) => new InvalidTranscriptFile({ path: transcript, reason: decodeReason(e) })),
      );
      yield* Effect.tryPromise({
        try: () => playback(session, fromTranscript(file), sleep ? { sleep } : {}),
        catch: (e) => new CommandFailed({ message: describe(e) }),
      });
      const paths = yield* writeExportsAndCapture(dir, session.snapshot(), capture, review);
      yield* write(paths.map((path) => `${path}\n`).join(""));
    },
    Effect.scoped,
  ),
).pipe(
  Command.withDescription(
    "録音サンプルの文字起こしを再生し、マップを組み立てる（既定は待ち時間なし、--realtime で等速）。"
      + "再生中は WebSocket で、反映のたびにマップ全体をブラウザへ送る。"
      + "終わると、セッションのフォルダに map.md・map.json・map.drawnix・map.png・map.html を書き出し、そのパスを出す",
  ),
  // 差分更新は play だけが使う。Layer が取得と解放を持ち、最後の反映と最終撮影の後に 1 回だけ閉じる
  Command.provide(DiffUpdater.layer),
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
    "ライブのセッションを終了し、map.md・map.json・map.drawnix・map.png・map.html を書き出して、そのパスを出す",
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
    const session = yield* Effect.try({
      try: () =>
        restoreSession(events, {
          // 復元では差分更新を呼ばない。呼ばれたら失敗する
          updater: async () => {
            throw new Error("restore では差分更新を呼べません");
          },
          log: () => {},
        }),
      catch: (e) => new CommandFailed({ message: describe(e) }),
    });
    yield* Effect.try({
      try: () => writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(session.exportJson())),
      catch: (e) => new CommandFailed({ message: describe(e) }),
    });
    yield* write(`${dir}\n`);
  }),
).pipe(Command.withDescription("最新のセッションのログから、差分更新を呼ばずにマップを戻す"));

const evaluate = Command.make(
  "eval",
  {
    truth: Flag.File("truth").pipe(
      Flag.withDescription("正解ファイル（JSON）。形は core/evaluate.ts の Truth が正本"),
      Flag.optional,
    ),
    sessions: Argument.String("session").pipe(
      Argument.withDescription("play で作ったセッションのフォルダ"),
      Argument.atLeast(1),
    ),
  },
  Effect.fn("eval")(function* ({ sessions, truth }) {
    // 正解ファイルの検証は共有の readTruthFile（段 1 の Truth の Schema）が持つ（Flag 側では検証しない）
    const expected = Option.isNone(truth) ? undefined : yield* readTruthFile(truth.value);
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
    yield* write(formatTable(runs, expected));
  }),
).pipe(
  Command.withDescription(
    "play で作ったランの指標を 1 ラン 1 行の表で出す。--truth を渡すと決定・TODO の再現率も出す"
      + "（当たる条件と 1 対 1 の数え方は core/evaluate.ts の matches・recall が持つ）",
  ),
);

const root = Command.make("live-mindmap").pipe(
  Command.withDescription("会議の文字起こし・ライブのセッションから、議論のマインドマップを組み立てる（ADR 0003）"),
  Command.withSubcommands([play, apps, start, stop, status, resume, exportCommand, restore, evaluate]),
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
  return Console.error(isCliFailure(failure) ? failureLine(failure) : describe(failure));
};

if (import.meta.main) {
  runCli(process.argv.slice(2)).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(Layer.mergeAll(NodeServices.layer, MapCapture.layer, ReviewBuild.layer)),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
