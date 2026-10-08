// 取り込みの途切れ（CONTEXT.md）の状態・ブラウザへのフレーム・ログの形・起動し直しの上限の判断。
// Node の実行環境に依存しない（ADR 0003）。タイマーは持たない（60 秒・3 回、構成の変化の 60 秒・10 回の判断は、実時間を受け取って純粋に決める）。

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
  | { type: "intake-gave-up"; reason: IntakeGiveUpReason };

// 諦めた理由。failures: 壊れて続けて落ちた（RESTART_WINDOW_MS 以内の終了が MAX_CONSECUTIVE_FAILURES 回続いた）。
// configuration-changes: 構成の変化による終了が CONFIGURATION_CHANGE_WINDOW_MS の間に MAX_CONFIGURATION_CHANGES 回を超えた
export type IntakeGiveUpReason = "failures" | "configuration-changes";

export const RESTART_WINDOW_MS = 60_000; // この時間以内に終わったら「続けて失敗した」と数える
export const MAX_CONSECUTIVE_FAILURES = 3; // 続けて失敗した回数がこれに達したら諦める
export const STDERR_TAIL_LINES = 5; // ログ・標準エラーに残す stderr の末尾の行数
// マイクの入力の構成の変化でヘルパーが終わるときの終了コード。BSD の sysexits.h の EX_TEMPFAIL（一時的な失敗。やり直すよう促す）。
// ヘルパー（Swift）の microphoneConfigurationChangedExitCode と同じ値にそろえる（両側のテストで値を固定している）
export const HELPER_EXIT_CONFIGURATION_CHANGED = 75;
export const CONFIGURATION_CHANGE_WINDOW_MS = 60_000; // 構成の変化による終了を数える窓
export const MAX_CONFIGURATION_CHANGES = 10; // 窓の中でこの回数を超えたら諦める

export type HelperExit = { code: number | null; signal: string | null };

export type IntakeRestartInput = {
  failures: number; // 続けて失敗した回数
  configurationChanges: ReadonlyArray<number>; // 構成の変化で終わった時刻（Clock のミリ秒）
  ranMs: number; // 起動を始めてから終わるまでの時間
  exit: HelperExit;
  now: number; // 終わりを扱う時刻（Clock のミリ秒）
};

export type IntakeRestartDecision = { failures: number; configurationChanges: ReadonlyArray<number> } & (
  | { action: "restart" }
  | { action: "giveup"; reason: IntakeGiveUpReason }
);

// 構成の変化による終了か（終了コード 75 で、シグナルによる終了ではない）
export function isConfigurationChangeExit(exit: HelperExit): boolean {
  return exit.code === HELPER_EXIT_CONFIGURATION_CHANGED && exit.signal === null;
}

// 起動し直すか諦めるかの判断（order.md「起動し直す回数の上限」）。
// 構成の変化による終了は failures に数えず、CONFIGURATION_CHANGE_WINDOW_MS の窓の中で MAX_CONFIGURATION_CHANGES 回を超えたら諦める
// （ちょうど窓の長さだけ前の記録は窓の中）。failures は、ranMs が RESTART_WINDOW_MS を超えていれば 0 に戻し、そうでなければ保つ。
// それ以外の終了（コード・シグナル）は、ranMs が RESTART_WINDOW_MS を超えていれば failures を 0 に戻して起動し直し、
// 超えていなければ failures を 1 増やして MAX_CONSECUTIVE_FAILURES に達したら諦める。configurationChanges には足さない。
export function decideIntakeRestart({ failures, configurationChanges, ranMs, exit, now }: IntakeRestartInput): IntakeRestartDecision {
  const inWindow = configurationChanges.filter((t) => now - t <= CONFIGURATION_CHANGE_WINDOW_MS);
  const ranLong = ranMs > RESTART_WINDOW_MS;
  if (isConfigurationChangeExit(exit)) {
    const changes = [...inWindow, now];
    const kept = ranLong ? 0 : failures;
    return changes.length > MAX_CONFIGURATION_CHANGES
      ? { failures: kept, configurationChanges: changes, action: "giveup", reason: "configuration-changes" }
      : { failures: kept, configurationChanges: changes, action: "restart" };
  }
  if (ranLong) return { failures: 0, configurationChanges: inWindow, action: "restart" };
  const next = failures + 1;
  return next >= MAX_CONSECUTIVE_FAILURES
    ? { failures: next, configurationChanges: inWindow, action: "giveup", reason: "failures" }
    : { failures: next, configurationChanges: inWindow, action: "restart" };
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
