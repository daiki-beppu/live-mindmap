// セッションのフォルダに対するファイル操作（作成・ログと export.json の追記・終了時の書き出し）。
// play（cli.ts）とライブのセッション（sessionSinks.ts）が共有する。HTTP には依存しない
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import type { PromiseMapCapture } from "./capture.ts";
import type { PromiseReviewPages, ReviewVariant } from "./review.ts";
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

// セッションのフォルダに置く、その時点のエクスポート。別のプロセスの export がこれを読む。
// play もライブのセッションも、作成直後と log のたびに書く。サーバーが動いていなくても export できる。
export const EXPORT_FILE = "export.json";
export const LOG_FILE = "log.jsonl";

// テキストの 3 形式（map.md・map.json・map.drawnix）を書き、書いたパスを順に返す
export function writeExportFiles(dir: string, snapshot: Snapshot): string[] {
  return Object.entries(exportFiles(toJsonExport(snapshot, snapshot.remarks))).map(([name, content]) => {
    const path = join(dir, name);
    writeFileSync(path, content.endsWith("\n") ? content : content + "\n");
    return path;
  });
}

export const captureWarning = (reason: string) => `map.png を書き出せませんでした: ${reason}`;
export const reviewWarning = (file: string, reason: string) => `${file} を書き出せませんでした: ${reason}`;

// セッションのフォルダ直下の録音（相手*.m4a・自分*.m4a）の有無
const RECORDING_PATTERN = /^(相手|自分).*\.m4a$/;

// 見返し用の HTML の版。録音があれば map.html、map-audio.html の順、無ければ map.html だけ（理由は表示しない）。
// play と --no-audio のセッションには録音が無い
export function reviewVariants(dir: string): readonly ReviewVariant[] {
  const recorded = readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && RECORDING_PATTERN.test(entry.name));
  return recorded
    ? [{ file: "map.html", audio: false }, { file: "map-audio.html", audio: true }]
    : [{ file: "map.html", audio: false }];
}

// セッション終了時の書き出し。スナップショットは 1 回だけ取り、5 形式（md・json・drawnix・png・html。録音があれば map-audio.html も）を書く。
// ライブのセッションの終了処理（sessionSinks.ts）から、この関数を呼ぶ。書いたファイルのパスを順に返す。
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
    const reviewed = await writeReview(dir, join(dir, LOG_FILE), reviewVariants(dir));
    paths.push(...reviewed.paths);
    for (const { file, reason } of reviewed.skipped) process.stderr.write(reviewWarning(file, reason) + "\n");
  } catch (e) {
    process.stderr.write(reviewWarning("map.html", e instanceof Error ? e.message : String(e)) + "\n");
  }
  return paths;
}

// セッションのフォルダ（名前は開始時刻）を作る。ライブでは、ヘルパーの起動前に作って録音の書き出し先として渡す
export function createSessionDir(sessionsDir: string): string {
  const dir = join(sessionsDir, new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
// ログが書けないとき（appendFileSync が投げる）は、そのまま defect にする。
export const openRecordedSession = Effect.fnUntraced(function* ({ dir, title, publish, onDiff }: RecordedSessionOptions) {
  // 書き先（log.jsonl）と at 付きの形は、session のログ（LogEvent）とサーバーの独自の記録（IntakeLogEvent）で共有する。
  // at は Clock ではなく実時刻（TestClock の下でも log.jsonl は実際の時刻で書く）
  const writeLogLine = (event: LogEvent | IntakeLogEvent) =>
    Effect.sync(() => appendFileSync(join(dir, LOG_FILE), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"));
  const writeExport = (session: Session) =>
    Effect.flatMap(session.exportJson, (json) => Effect.sync(() => writeFileSync(join(dir, EXPORT_FILE), JSON.stringify(json))));
  // 開始のイベントは makeSession の中で書かれるので、makeSession が返す前は export.json を書けない（publish もしない）
  const current = yield* Ref.make<Session | undefined>(undefined);
  const log = Layer.succeed(SessionLog)(
    SessionLog.of({
      write: (event) =>
        Effect.gen(function* () {
          yield* writeLogLine(event);
          const session = yield* Ref.get(current);
          if (!session) return;
          yield* writeExport(session);
          if (event.type !== "diff") return;
          if (!event.error) yield* Effect.flatMap(session.snapshot, publish);
          if (onDiff) yield* onDiff;
        }),
    }),
  );
  const session = yield* makeSession({ title: title ?? basename(dir) }).pipe(Effect.provide(log));
  yield* Ref.set(current, session);
  // 発言が 1 件も来なくても、export が前のセッションではなくこのセッションのマップを返すように、作成直後にも書く
  yield* writeExport(session);
  yield* Effect.flatMap(session.snapshot, publish); // 最初のルート
  return { session, appendLog: writeLogLine };
});
