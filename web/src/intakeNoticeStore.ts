import { intakeNoticeText, RESUMED_NOTICE_MS, type IntakeStatus } from "./intake.ts";

// 取り込みの状態の変化・経過時間・「再開しました」が消える期限の予約を持つ、React を使わないストア
// （useIntakeNotice.ts が useSyncExternalStore でつなぐ。Issue #161 U-E）。
// レンダラの無い web のテスト環境でも、期限切れで実際に再描画の契機（listener の呼び出し）が起きることを
// 直接検証できるようにするため、タイマーをここに置く（hook 内部の setTimeout は到達できない）。
export type IntakeNoticeStore = {
  setStatus: (status: IntakeStatus) => void;
  text: () => string | null;
  // listener を登録し、解除する関数を返す（useSyncExternalStore の契約と同じ形）
  subscribe: (listener: () => void) => () => void;
};

export function createIntakeNoticeStore(initial: IntakeStatus): IntakeNoticeStore {
  let previous: IntakeStatus | null = null;
  let current: IntakeStatus = initial;
  let changedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) listener();
  }

  // 「再開しました」が RESUMED_NOTICE_MS で消えるタイミングだけ、再描画の契機（listener の呼び出し）を予約する。
  // 購読者が 1 人もいない間はタイマーを持たない（取得・開始・登録した状態は使う側がいなくなったら後片付けする）
  function scheduleExpiry() {
    clearTimeout(timer);
    timer = undefined;
    if (listeners.size === 0 || current !== "running") return;
    const msLeft = RESUMED_NOTICE_MS - (Date.now() - changedAt);
    if (msLeft < 0) return;
    timer = setTimeout(notify, msLeft + 1);
  }

  return {
    setStatus(status) {
      if (status === current) return;
      previous = current;
      current = status;
      changedAt = Date.now();
      scheduleExpiry();
      notify();
    },
    text() {
      return intakeNoticeText({ previous, current, msSinceChange: Date.now() - changedAt });
    },
    subscribe(listener) {
      listeners.add(listener);
      scheduleExpiry();
      return () => {
        listeners.delete(listener);
        scheduleExpiry();
      };
    },
  };
}
