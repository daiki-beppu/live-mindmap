// 途中結果から発言を出す規則（core/settle.ts）を、停止の門につなぐ。
// 時計は届いた結果の end の最大値（音声の時刻）だけ。壁時計では進めない（結果が届かない間は発言を出さない。出すのは、結果の到着・確定結果・drain のとき）。
// settler の戻り値（4 つの出口は、どれもここを通る）の後ろに、話者を決める段（core/speakers.ts）を 1 段だけ置く（Issue #1021）。
// 相手の発言は、確定した話者の区間が揃うまで保留される（最大 SPEAKER_WAIT_MS）。段の状態（枠とラベルの対応）は、この settling と同じ寿命で 1 つ
import { Effect } from "effect";
import { createRemarkSettler, createSpeakerAttribution, type HelperPartial, type SettledRemark, type SpeakerAttributionOptions, type SpeakerLogEvent } from "./core/index.ts";
import { createStopGate } from "./stopGate.ts";

export type RemarkSettlingOptions = {
  emit: (remark: SettledRemark) => Effect.Effect<void>;
  // 話者の段の規則の切り替えと判定の記録（Issue #1030）。ライブは渡さない
  speakers?: SpeakerAttributionOptions;
};

export const createRemarkSettling = Effect.fnUntraced(function* ({ emit, speakers }: RemarkSettlingOptions) {
  const settler = createRemarkSettler();
  const attribution = createSpeakerAttribution(speakers);
  const gate = yield* createStopGate;
  const { unlessStopped } = gate;

  const emitAll = (remarks: readonly SettledRemark[]) => Effect.forEach(remarks, emit, { discard: true });

  return {
    partial: (p: HelperPartial) => unlessStopped(Effect.suspend(() => emitAll(attribution.remarks(settler.partial(p), p.end * 1000)))),
    final: (r: SettledRemark) => unlessStopped(Effect.suspend(() => emitAll(attribution.remarks(settler.final(r), r.end * 1000)))),
    // ヘルパーの speaker / speaker-off。揃った保留と、speaker-off で待たなくなった保留を出す
    speaker: (event: SpeakerLogEvent) => unlessStopped(Effect.suspend(() => emitAll(attribution.speaker(event)))),
    // ヘルパーを起動し直した（Issue #1025）。前の世代の保留を出し切り、枠単位の状態を捨てる
    renumbered: unlessStopped(Effect.suspend(() => emitAll(attribution.restart()))),
    // 停止時。まだ出ていない発話と保留を T・3 秒を待たずにすべて出す（揃っていない保留は話者なし）
    drain: unlessStopped(Effect.suspend(() => emitAll([...attribution.remarks(settler.drain(), 0), ...attribution.drain()]))),
    // 字幕のための読み取り（Issue #1022）。発言の判定には使わない
    preview: {
      // 途中結果のうち、もう発言になった分を除いた後ろ（Issue #1222）。発言を出すときと同じ規則で切る
      unemittedTail: settler.unemittedTail,
      heldRemarks: attribution.heldRemarks,
      segments: attribution.previewSegments,
      label: attribution.previewLabel,
    },
    // 発言に振ったラベル。名前を付けられるのはこれだけ（Issue #1026）
    labels: attribution.labels,
    // 以後の入力は無視する
    stop: gate.stop,
  };
});
