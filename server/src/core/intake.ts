// 取り込みの途切れ（CONTEXT.md）の状態・ブラウザへのフレーム・ログの形・起動し直しの上限の判断。
// Node の実行環境に依存しない（ADR 0003）。タイマーは持たない（60 秒・3 回の判断は、実時間を受け取って純粋に決める）。

// ヘルパーごとの取り込みの状態。running: 動いている。interrupted: 途切れて起動し直している。stopped: 諦めて止まった
export type IntakeStatus = "running" | "interrupted" | "stopped";

// ブラウザへ送る、取り込みの状態のフレーム。スナップショット（type なし）・speaking（type: "speaking"）とは type で見分ける。
// status は cli status と同じ語彙（SessionIntakeStatus）を使う。"none" は、セッションが終わったことを伝える専用の値で、
// "running" とは区別する。接続を保ったクライアントは、直前が interrupted/stopped だった状態から "running" へ変わると
// 「再開しました」と解釈する（intakeNoticeText）ため、セッションが終わっただけのときに "running" を送ると、終わったのに
// 再開したと誤って表示してしまう（CT-NOTICE-CLEAR）。"none" はその転換を起こさない
export type IntakeFrame = { type: "intake"; status: SessionIntakeStatus };

// log.jsonl に残す記録（order.md「ログに残す」）。すべて intake- で始まる種類。知らない種類として復元時に読み飛ばされる（CT-RESTORE）。
// signal は Node のシグナル名の文字列（"SIGKILL" 等）。NodeJS.Signals は使わない（core は Node の実行環境に依存しない。ADR 0003）
export type IntakeLogEvent =
  | { type: "intake-stopped"; code: number | null; signal: string | null; stderrTail: string[] }
  | { type: "intake-restarted"; trigger: "auto" | "resume" }
  | { type: "intake-gave-up" };

export const RESTART_WINDOW_MS = 60_000; // この時間以内に終わったら「続けて失敗した」と数える
export const MAX_CONSECUTIVE_FAILURES = 3; // 続けて失敗した回数がこれに達したら諦める
export const STDERR_TAIL_LINES = 5; // ログ・標準エラーに残す stderr の末尾の行数

export type IntakeRestartDecision = { failures: number; action: "restart" | "giveup" };

// 起動し直すか諦めるかの判断（order.md「起動し直す回数の上限」）。止まり方（コード／シグナル）では分岐しない。
// ranMs が RESTART_WINDOW_MS を超えていれば、数え直す（failures を 0 に戻し、必ず再起動）。
// 超えていなければ failures を 1 増やし、MAX_CONSECUTIVE_FAILURES に達したら諦める。
export function decideIntakeRestart({ failures, ranMs }: { failures: number; ranMs: number }): IntakeRestartDecision {
  if (ranMs > RESTART_WINDOW_MS) return { failures: 0, action: "restart" };
  const next = failures + 1;
  return { failures: next, action: next >= MAX_CONSECUTIVE_FAILURES ? "giveup" : "restart" };
}

// 標準エラーの末尾 n 行（末尾の改行による空行は数えない）。n 行以下ならそのまま全部返す
export function tailLines(text: string, n: number): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}

// cli status が出す状態の語彙（order.md「知らせ方」。CLI は「セッションなし」も扱うので、サーバーの IntakeStatus を拡張する）
export type SessionIntakeStatus = "none" | IntakeStatus;

export type IntakeStatusReport = {
  status: SessionIntakeStatus;
  dir?: string;
  restarts?: number; // 起動し直した回数
  lastInterruptedAt?: string; // 最後の途切れの時刻（ISO）
};

const STATUS_WORDS: Record<SessionIntakeStatus, string> = {
  none: "セッションなし",
  running: "動いている",
  interrupted: "途切れている",
  stopped: "止まった",
};

// cli status の標準出力（order.md「cli status」）
export function formatIntakeStatus(report: IntakeStatusReport): string {
  const lines = [STATUS_WORDS[report.status]];
  if (report.dir !== undefined) lines.push(`セッションのフォルダ: ${report.dir}`);
  if (report.restarts !== undefined) lines.push(`起動し直した回数: ${report.restarts}`);
  if (report.lastInterruptedAt !== undefined) lines.push(`最後の途切れの時刻: ${report.lastInterruptedAt}`);
  return lines.join("\n") + "\n";
}
