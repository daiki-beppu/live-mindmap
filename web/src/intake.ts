export type IntakeStatus = "running" | "interrupted" | "stopped" | "none";

export const RESUMED_NOTICE_MS = 3_000;

const INTERRUPTED_TEXT = "音声の取り込みが途切れました。再開しています";
const STOPPED_TEXT = "音声の取り込みが止まっています";
const RESUMED_TEXT = "再開しました";

export type IntakeNoticeInput = {
  previous: IntakeStatus | null;
  current: IntakeStatus;
  msSinceChange: number;
};

export function intakeNoticeText({ previous, current, msSinceChange }: IntakeNoticeInput): string | null {
  if (current === "interrupted") return INTERRUPTED_TEXT;
  if (current === "stopped") return STOPPED_TEXT;
  if (current === "none") return null;
  if ((previous === "interrupted" || previous === "stopped") && msSinceChange <= RESUMED_NOTICE_MS) return RESUMED_TEXT;
  return null;
}
