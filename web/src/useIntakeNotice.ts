import { useEffect, useState, useSyncExternalStore } from "react";
import type { IntakeStatus } from "./intake.ts";
import { createIntakeNoticeStore } from "./intakeNoticeStore.ts";

// 現在の取り込みの状態（useLiveFeed が持つ。まだ何も受け取っていなければ "running" 扱い）から、
// 画面に出す一言を決める React の糊（Mediator）。状態の変化・経過時間・期限の予約は intakeNoticeStore.ts
// （React を使わない）に任せ、ここは useSyncExternalStore でその結果を読むだけにする。
export function useIntakeNotice(status: IntakeStatus): string | null {
  const [store] = useState(() => createIntakeNoticeStore(status));

  useEffect(() => {
    store.setStatus(status);
  }, [store, status]);

  return useSyncExternalStore(store.subscribe, store.text);
}
