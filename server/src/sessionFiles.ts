// セッションのフォルダに対するファイル操作（作成・ログと export.json の追記・終了時の書き出し）。FileSystem 経由。
// play（cli.ts）とライブのセッション（sessionSinks.ts）が共有する。HTTP には依存しない
import { basename, join } from "node:path";
import { Cause, Console, DateTime, Effect, FileSystem, Layer, Ref, Schema, Semaphore } from "effect";
import { MapCapture } from "./capture.ts";
import { ReviewPageFailed, writeReviewPages, type ReviewVariant } from "./review.ts";
import {
  exportFiles,
  makeSession,
  SessionLog,
  toJsonExport,
  type IntakeLogEvent,
  type LogEvent,
  type Session,
  type Snapshot,
} from "./core/index.ts";
import { errorMessage } from "./truthFile.ts";

// セッションのフォルダに置く、その時点のエクスポート。別のプロセスの export がこれを読む。
// play もライブのセッションも、作成直後と log のたびに書く。サーバーが動いていなくても export できる。
export const EXPORT_FILE = "export.json";
export const LOG_FILE = "log.jsonl";
export const SCREENS_DIR = "screens"; // 共有画面の画像（JPEG）を置く、セッションのフォルダの下のフォルダ

// テキストの 3 形式（map.md・map.json・map.drawnix）を書き、書いたパスを順に返す
export const writeExportFiles = Effect.fnUntraced(function* (dir: string, snapshot: Snapshot) {
  const fs = yield* FileSystem.FileSystem;
  const paths: string[] = [];
  for (const [name, content] of Object.entries(exportFiles(toJsonExport(snapshot, snapshot.remarks)))) {
    const path = join(dir, name);
    yield* fs.writeFileString(path, content.endsWith("\n") ? content : content + "\n");
    paths.push(path);
  }
  return paths;
});

export const captureWarning = (reason: string) => `map.png を書き出せませんでした: ${reason}`;
export const reviewWarning = (file: string, reason: string) => `${file} を書き出せませんでした: ${reason}`;

// セッションのフォルダ直下の録音（相手*.m4a・自分*.m4a）の有無
const RECORDING_PATTERN = /^(相手|自分).*\.m4a$/;
const SELF_RECORDING_PATTERN = /^自分.*\.m4a$/;

// フォルダ直下に、名前が pattern に合う通常のファイルがあるか（名前が合っても、シンボリックリンクとフォルダは録音と数えない）。
// FileSystem に lstat が無く stat はリンクを辿るため、readLink が成功するか（= リンクか）で見分ける
const hasRecording = Effect.fnUntraced(function* (dir: string, pattern: RegExp) {
  const fs = yield* FileSystem.FileSystem;
  for (const name of yield* fs.readDirectory(dir)) {
    if (!pattern.test(name)) continue;
    const path = join(dir, name);
    if (yield* fs.readLink(path).pipe(Effect.as(true), Effect.orElseSucceed(() => false))) continue;
    if ((yield* fs.stat(path)).type === "File") return true;
  }
  return false;
});

// `自分` の声だけを埋め込んだ版（--self-only）。フォルダ直下に 自分*.m4a があれば 1 つ、無ければ空
export const selfReviewVariants = Effect.fnUntraced(function* (dir: string) {
  const variants: readonly ReviewVariant[] = (yield* hasRecording(dir, SELF_RECORDING_PATTERN))
    ? [{ file: "map-audio-自分.html", audio: true, track: "自分" }]
    : [];
  return variants;
});

// 見返し用の HTML の版。録音があれば map.html、map-audio.html の順、無ければ map.html だけ（理由は表示しない）。
// play と --no-audio のセッションには録音が無い
export const reviewVariants = Effect.fnUntraced(function* (dir: string) {
  const variants: readonly ReviewVariant[] = (yield* hasRecording(dir, RECORDING_PATTERN))
    ? [{ file: "map.html", audio: false }, { file: "map-audio.html", audio: true }]
    : [{ file: "map.html", audio: false }];
  return variants;
});

// テキストの 3 形式（map.md・map.json・map.drawnix）を書けなかった。message は書き込みの失敗の理由。
// cli は CommandFailed に、サーバーは defect にする（撮影・HTML と違って、これだけは諦めずに失敗にする）
export class ExportFilesFailed extends Schema.TaggedError<ExportFilesFailed>()("ExportFilesFailed", { message: Schema.String }) {}

// 見返し用の HTML を書く。版の一覧は録音の有無で決める（reviewVariants）。mix だけの失敗は結果の skipped に入り、ここでは失敗にしない
export const writeReviews = (dir: string) =>
  reviewVariants(dir).pipe(
    Effect.mapError((e) => new ReviewPageFailed({ message: errorMessage(e) })),
    Effect.flatMap((variants) => writeReviewPages(dir, join(dir, LOG_FILE), variants)),
  );

// セッション終了時の書き出し。スナップショットは 1 回だけ取り、5 形式（md・json・drawnix・png・html。録音があれば map-audio.html も）を書く。
// play（cli.ts）とライブのセッションの終了処理（sessionSinks.ts）が、この関数を呼ぶ。書いたファイルのパスを順に返す。
// 撮影・HTML・mix と FileSystem は文脈から受け取る。テキストの 3 形式を先に書く。撮影・HTML の書き出しは互いに独立で、
// 失敗したもの（Chromium が無い等。型付きの失敗も、中断以外の defect も）だけ諦めて、標準エラー（Console）に理由を残し、書けたもののパスを返す。
// 中断は警告にせず伝える。理由の整形（formatReason）は入口が決める（cli は 1 行にし、サーバーは元の理由のまま）
export const writeExportsAndCapture = Effect.fnUntraced(function* (dir: string, snapshot: Snapshot, formatReason: (e: unknown) => string) {
  const paths = yield* writeExportFiles(dir, snapshot).pipe(Effect.mapError((e) => new ExportFilesFailed({ message: formatReason(e) })));
  // 中断以外の失敗（型付きの失敗も defect も）は、警告にして undefined を返す
  const orWarn = <A, E, R>(effect: Effect.Effect<A, E, R>, warning: (reason: string) => string) =>
    Effect.catchCauseIf(
      effect,
      (cause) => !Cause.hasInterrupts(cause),
      (cause) => Effect.as(Console.error(warning(formatReason(Cause.squash(cause)))), undefined),
    );
  const png = join(dir, "map.png");
  const captured = yield* orWarn(
    Effect.as(Effect.flatMap(MapCapture, (service) => service.capture(snapshot, png)), true),
    captureWarning,
  );
  if (captured) paths.push(png);
  const reviewed = yield* orWarn(writeReviews(dir), (reason) => reviewWarning("map.html", reason));
  if (reviewed) {
    paths.push(...reviewed.paths);
    for (const { file, reason } of reviewed.skipped) yield* Console.error(reviewWarning(file, reason));
  }
  return paths;
});

// セッションのフォルダ（名前は開始時刻）を作る。ライブでは、ヘルパーの起動前に作って録音の書き出し先として渡す
export const createSessionDir = Effect.fnUntraced(function* (sessionsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = join(sessionsDir, DateTime.formatIso(DateTime.nowUnsafe()).replaceAll(":", "-"));
  yield* fs.makeDirectory(dir, { recursive: true });
  return dir;
});

export type RecordedSessionOptions = {
  dir: string; // createSessionDir で作ったセッションのフォルダ
  title?: string; // 省略したときは、セッションのフォルダ名（開始時刻）
  publish: (snapshot: Snapshot) => Effect.Effect<void>;
  onDiff?: Effect.Effect<void>; // 差分更新の 1 回が終わった（成功の publish の後・失敗のとき）。未反映の発言が変わったことを知らせる
};

// 作成済みのセッションのフォルダに、ログと export.json を書きながら、マップが変わるたびに publish する。
// play もライブのセッションも、この 1 つの配線で動かす（出どころだけが違う）。差分更新（DiffUpdater）は呼び出し側が提供する。
// appendLog は、サーバーが取り込みの途切れ等（LogEvent ではない独自の種類）を log.jsonl へ追記するための口。
// session のログと同じ書き先・同じ at 付きの形を共有するが、export.json は書き直さない（マップを変えない記録のため）。
// ログが書けないとき（FileSystem の失敗）は、そのまま defect にする。
export const openRecordedSession = Effect.fnUntraced(function* ({ dir, title, publish, onDiff }: RecordedSessionOptions) {
  // SessionLog のメソッドの R は空なので、FileSystem はここで 1 回だけ受け取ってクロージャで使う
  const fs = yield* FileSystem.FileSystem;
  // 書き先（log.jsonl）と at 付きの形は、session のログ（LogEvent）とサーバーの独自の記録（IntakeLogEvent）で共有する。
  // at は Clock ではなく実時刻（TestClock の下でも log.jsonl は実際の時刻で書く）。Effect を実行した時点で決める
  const writeLogLine = (event: LogEvent | IntakeLogEvent) =>
    Effect.suspend(() =>
      fs.writeFileString(join(dir, LOG_FILE), JSON.stringify({ at: DateTime.formatIso(DateTime.nowUnsafe()), ...event }) + "\n", { flag: "a" }),
    ).pipe(Effect.orDie);
  const writeExport = (session: Session) =>
    Effect.flatMap(session.exportJson, (json) => fs.writeFileString(join(dir, EXPORT_FILE), JSON.stringify(json))).pipe(Effect.orDie);
  // 同期の書き込みでは自然に成り立っていた性質（行が呼んだ順に並ぶ・最後の export.json が最新）を保つため、
  // ログの 1 行と export.json の書き直しは 1 つずつ、中断させずに行う。publish と onDiff は待ちに巻き込まないよう、外で呼ぶ
  const lock = yield* Semaphore.make(1);
  const serialized = <A>(effect: Effect.Effect<A>) => lock.withPermit(Effect.uninterruptible(effect));
  // 開始のイベントは makeSession の中で書かれるので、makeSession が返す前は export.json を書けない（publish もしない）
  const current = yield* Ref.make<Session | undefined>(undefined);
  const log = Layer.succeed(SessionLog)(
    SessionLog.of({
      write: (event) =>
        Effect.gen(function* () {
          const session = yield* serialized(
            Effect.gen(function* () {
              yield* writeLogLine(event);
              const session = yield* Ref.get(current);
              if (session) yield* writeExport(session);
              return session;
            }),
          );
          if (!session || event.type !== "diff") return;
          if (!event.error) yield* Effect.flatMap(session.snapshot, publish);
          if (onDiff) yield* onDiff;
        }),
      // 共有画面の画像は、受け取ったバイト列のまま screens/ に書く（最初の 1 枚で作る）
      writeScreen: (file, bytes) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(join(dir, SCREENS_DIR), { recursive: true });
          yield* fs.writeFile(join(dir, SCREENS_DIR, file), bytes);
        }).pipe(Effect.orDie),
      readScreen: (file) => fs.readFile(join(dir, SCREENS_DIR, file)).pipe(Effect.orDie),
    }),
  );
  const session = yield* makeSession({ title: title ?? basename(dir) }).pipe(Effect.provide(log));
  yield* Ref.set(current, session);
  // 発言が 1 件も来なくても、export が前のセッションではなくこのセッションのマップを返すように、作成直後にも書く
  yield* serialized(writeExport(session));
  yield* Effect.flatMap(session.snapshot, publish); // 最初のルート
  return { session, appendLog: (event: LogEvent | IntakeLogEvent) => serialized(writeLogLine(event)) };
});
