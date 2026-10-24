import { Effect } from "effect";
import { createRemarkSettler, createSpeakerAttribution, type HelperPartial, type SettledRemark, type SpeakerAttributionOptions, type SpeakerLogEvent } from "./core/index.ts";
import { createStopGate } from "./stopGate.ts";

export type RemarkSettlingOptions = {
  emit: (remark: SettledRemark) => Effect.Effect<void>;
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
    speaker: (event: SpeakerLogEvent) => unlessStopped(Effect.suspend(() => emitAll(attribution.speaker(event)))),
    renumbered: unlessStopped(Effect.suspend(() => emitAll(attribution.restart()))),
    drain: unlessStopped(Effect.suspend(() => emitAll([...attribution.remarks(settler.drain(), 0), ...attribution.drain()]))),
    preview: {
      unemittedTail: settler.unemittedTail,
      heldRemarks: attribution.heldRemarks,
      segments: attribution.previewSegments,
      label: attribution.previewLabel,
    },
    labels: attribution.labels,
    stop: gate.stop,
  };
});
