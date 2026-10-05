// 取り込みの状態（CONTEXT.md「取り込みの途切れ」）に応じて、字幕の横に出す一言の規則（order.md「画面」）。
// サーバーは現在の状態だけを送り、ここで「途切れ／止まった → 動いている」の遷移から「再開しました」を導く。
// React を使わない純粋な規則（useIntakeNotice.ts が React の糊、IntakeNotice.tsx が部品）。

// "none" はセッションが無い（終わった）ことを表す。cli status と同じ語彙（サーバー側の SessionIntakeStatus）
export type IntakeStatus = "running" | "interrupted" | "stopped" | "none";

export const RESUMED_NOTICE_MS = 3_000; // 「再開しました」を出し続ける時間（「数秒」の具体化）

const INTERRUPTED_TEXT = "音声の取り込みが途切れました。再開しています";
const STOPPED_TEXT = "音声の取り込みが止まっています";
const RESUMED_TEXT = "再開しました";

export type IntakeNoticeInput = {
  previous: IntakeStatus | null; // 直前の状態（接続直後・まだ状態を受け取っていないときは null）
  current: IntakeStatus;
  msSinceChange: number; // current になってからの経過時間（ms）
};

// 出す文（なければ null）を決める。
// - interrupted の間は、経過時間に関わらず出し続ける
// - stopped の間は、経過時間に関わらず出し続ける
// - running は、直前が interrupted/stopped から戻った直後だけ RESUMED_NOTICE_MS の間「再開しました」を出す。
//   直前が null（接続直後）や running（変化なし）のときは出さない
// - none（セッションが終わった）は、直前が何であっても出さない。running と違い「再開した」への遷移として扱わない
//   （終わったセッションに「再開しました」が出ないようにするための区別。CT-NOTICE-CLEAR）
export function intakeNoticeText({ previous, current, msSinceChange }: IntakeNoticeInput): string | null {
  if (current === "interrupted") return INTERRUPTED_TEXT;
  if (current === "stopped") return STOPPED_TEXT;
  if (current === "none") return null;
  // current === "running"
  if ((previous === "interrupted" || previous === "stopped") && msSinceChange <= RESUMED_NOTICE_MS) return RESUMED_TEXT;
  return null;
}
