// 途中結果から発言を出す規則（core/settle.ts）を、停止の門につなぐ。
// 時計は届いた結果の end の最大値（音声の時刻）だけ。壁時計では進めない（結果が届かない間は発言を出さない。出すのは、結果の到着・確定結果・drain のとき）。
import { Effect } from "effect";
import { createRemarkSettler, type HelperPartial, type SettledRemark } from "./core/index.ts";
import { createStopGate } from "./stopGate.ts";

export type RemarkSettlingOptions = {
  emit: (remark: SettledRemark) => Effect.Effect<void>;
};

export const createRemarkSettling = Effect.fnUntraced(function* ({ emit }: RemarkSettlingOptions) {
  const settler = createRemarkSettler();
  const gate = yield* createStopGate;
  const { unlessStopped } = gate;

  const emitAll = (remarks: readonly SettledRemark[]) => Effect.forEach(remarks, emit, { discard: true });

  return {
    partial: (p: HelperPartial) => unlessStopped(Effect.suspend(() => emitAll(settler.partial(p)))),
    final: (r: SettledRemark) => unlessStopped(Effect.suspend(() => emitAll(settler.final(r)))),
    // 停止時。まだ出ていない発話を T を待たずにすべて出す
    drain: unlessStopped(Effect.suspend(() => emitAll(settler.drain()))),
    // 以後の入力は無視する
    stop: gate.stop,
  };
});
