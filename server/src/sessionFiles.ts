// セッションのフォルダに対するファイル操作（作成・ログと export.json の追記・終了時の書き出し）。
// play（cli.ts）とライブのセッション（sessionSinks.ts）が共有する。HTTP には依存しない
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { PromiseMapCapture } from "./capture.ts";
import type { PromiseReviewPages, ReviewVariant } from "./review.ts";
import {
  createSession,
  exportFiles,
  toJsonExport,
  type DiffUpdater,
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
export const reviewWarning = (reason: string) => `map.html を書き出せませんでした: ${reason}`;

// 見返し用の HTML の版。今は map.html だけ
export const REVIEW_VARIANTS: readonly ReviewVariant[] = [{ file: "map.html" }];

// セッション終了時の書き出し。スナップショットは 1 回だけ取り、5 形式（md・json・drawnix・png・html）を書く。
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
    paths.push(...(await writeReview(dir, join(dir, LOG_FILE), REVIEW_VARIANTS)));
  } catch (e) {
    process.stderr.write(reviewWarning(e instanceof Error ? e.message : String(e)) + "\n");
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
  updater: DiffUpdater;
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

