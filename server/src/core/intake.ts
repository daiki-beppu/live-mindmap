import { DateTime, Schema } from "effect";
import { DiffUpdateStatusReport } from "./diffUpdate.ts";
import type { SpeakerLogEvent } from "./live.ts";

export const SessionIntakeStatus = Schema.Literals(["none", "running", "interrupted", "stopped"]);
export type SessionIntakeStatus = typeof SessionIntakeStatus["Type"];

export const IntakeFrame = Schema.Struct({ type: Schema.Literal("intake"), status: SessionIntakeStatus });
export type IntakeFrame = typeof IntakeFrame["Type"];

export type IntakeLogEvent =
  | { type: "intake-stopped"; code: number | null; signal: string | null; stderrTail: string[] }
  | { type: "intake-restarted"; trigger: "auto" | "resume" }
  | { type: "intake-gave-up"; reason: IntakeGiveUpReason }
  | { type: "tap-silent"; start: number }
  | SpeakerLogEvent;

export type IntakeGiveUpReason = "failures" | "configuration-changes";

export const RESTART_WINDOW_MS = 60_000;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const STDERR_TAIL_LINES = 5;
export const HELPER_RUN_STDERR_TAIL_LINES = 10;
// マイクの入力の構成の変化でヘルパーが終わるときの終了コード。BSD の sysexits.h の EX_TEMPFAIL（一時的な失敗。やり直すよう促す）。
export const HELPER_EXIT_CONFIGURATION_CHANGED = 75;
export const CONFIGURATION_CHANGE_WINDOW_MS = 60_000;
export const MAX_CONFIGURATION_CHANGES = 10;

export type HelperExit = { code: number | null; signal: string | null };

export type IntakeRestartInput = {
  failures: number;
  configurationChanges: ReadonlyArray<number>;
  ranMs: number;
  exit: HelperExit;
  now: number;
};

export type IntakeRestartDecision = { failures: number; configurationChanges: ReadonlyArray<number> } & (
  | { action: "restart" }
  | { action: "giveup"; reason: IntakeGiveUpReason }
);

export function isConfigurationChangeExit(exit: HelperExit): boolean {
  return exit.code === HELPER_EXIT_CONFIGURATION_CHANGED && exit.signal === null;
}

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

export function tailLines(text: string, n: number): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}

// transition は開始・終了の処理中。処理の間だけの報告の値で、画面へ送る IntakeFrame には載せない
const IntakeReportStatus = Schema.Literals([...SessionIntakeStatus.literals, "transition"]);

export const IntakeStatusReport = Schema.Struct({
  status: IntakeReportStatus,
  dir: Schema.optionalKey(Schema.String),
  restarts: Schema.optionalKey(Schema.Finite),
  lastInterruptedAt: Schema.optionalKey(Schema.String),
  stoppedReason: Schema.optionalKey(Schema.String),
  meetingTab: Schema.optionalKey(Schema.Struct({
    title: Schema.optionalKey(Schema.String),
    status: Schema.Literals(["unknown", "capturing", "waiting", "notified", "off"]),
  })),
  diffUpdate: Schema.optionalKey(DiffUpdateStatusReport),
});
export type IntakeStatusReport = typeof IntakeStatusReport["Type"];

const STATUS_WORDS: Record<IntakeStatusReport["status"], string> = {
  none: "セッションなし",
  transition: "開始・終了の処理中",
  running: "動いている",
  interrupted: "途切れている",
  stopped: "止まった",
};

export function formatIntakeStatus(report: IntakeStatusReport): string {
  const lines = [STATUS_WORDS[report.status]];
  if (report.stoppedReason !== undefined) lines.push(`止まった理由: ${report.stoppedReason}`);
  if (report.dir !== undefined) lines.push(`セッションのフォルダ: ${report.dir}`);
  if (report.restarts !== undefined) lines.push(`起動し直した回数: ${report.restarts}`);
  if (report.lastInterruptedAt !== undefined) lines.push(`最後の途切れの時刻: ${report.lastInterruptedAt}`);
  if (report.meetingTab !== undefined) {
    const tab = report.meetingTab;
    if (tab.title !== undefined) lines.push(`会議のタブ: ${tab.title}`);
    const screenWords: Record<typeof tab.status, string> = {
      unknown: "未取得",
      capturing: "取り込み中",
      waiting: "画像を待っています",
      notified: "会議のタブが前面にありません。取り込めていません",
      off: "取り込み停止",
    };
    lines.push(`共有画面: ${screenWords[tab.status]}`);
  }
  if (report.diffUpdate !== undefined) {
    const diff = report.diffUpdate;
    lines.push(`差分更新: ${diff.status === "paused" ? "一時停止" : STATUS_WORDS[diff.status]}`);
    if (diff.status === "paused") {
      lines.push(`一時停止の理由: ${diff.reason}`);
      lines.push(`次に試す時刻: ${DateTime.formatIso(DateTime.makeUnsafe(diff.nextRetryAt))}`);
    }
    if (diff.lastFailure !== undefined) lines.push(`最後の失敗: ${diff.lastFailure}`);
  }
  return lines.join("\n") + "\n";
}
