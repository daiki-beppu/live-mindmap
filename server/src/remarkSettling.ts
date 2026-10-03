// 途中結果から発言を出す規則（core/settle.ts）に、タイマーをつなぐ。
// タイマーを使うので Node 層に置く（中核は実行環境のタイマーを使わない。ADR 0003）。
import { createRemarkSettler, type HelperPartial, type SettledRemark } from "./core/index.ts";

export type RemarkSettlingOptions = {
  emit: (remark: SettledRemark) => void;
  now?: () => number;
};

export function createRemarkSettling({ emit, now = Date.now }: RemarkSettlingOptions) {
  const settler = createRemarkSettler();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  // 次に出す時刻に合わせて、予約を 1 本だけ張り直す
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    const at = settler.nextDue();
    if (at === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      settler.due(now()).forEach(emit);
      schedule();
    }, Math.max(0, at - now()));
  }

  return {
    partial(p: HelperPartial) {
      if (stopped) return;
      settler.partial(p, now());
      schedule();
    },
    final(r: SettledRemark) {
      if (stopped) return;
      settler.final(r, now()).forEach(emit);
      schedule();
    },
    // 停止時。まだ出ていない発話を T を待たずにすべて出す
    drain() {
      if (stopped) return;
      settler.drain().forEach(emit);
      schedule();
    },
    // 予約を取り消す。以後の入力は無視する
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
