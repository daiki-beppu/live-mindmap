import { Effect, Ref, type Scope } from "effect";
import type { CaptionsFrame, ScreenEvent, HelperPartial, Replacement, Session, SpeakerLogEvent, WordTime } from "./core/index.ts";
import type { CorrectedRemark, SessionVocabulary } from "./sessionVocabulary.ts";
import { createRemarkSettling } from "./remarkSettling.ts";
import { createSpeakingRelay, type CaptionContext } from "./speakingRelay.ts";

export type Inlet = {
  remark: (corrected: CorrectedRemark) => Effect.Effect<void>;
  screen: (change: { start: number; image: Uint8Array | null; lines?: ReadonlyArray<string> | undefined; ocrFailed?: (typeof ScreenEvent.Type)["ocrFailed"] }) => Effect.Effect<void>;
  screenOff: Session["pushScreenOff"];
};

export type Feed = Inlet & { drain: Effect.Effect<void> };

export const directFeed = (inlet: Inlet): Effect.Effect<Feed> =>
  Effect.succeed({ ...inlet, drain: Effect.void });

export const makeRemarkFlow = Effect.fnUntraced(function* <F extends Feed>(options: {
  session: Pick<Session, "push" | "pushScreen" | "pushScreenOff" | "unreflectedRemarks">;
  correct: SessionVocabulary["correct"];
  speak: (frame: CaptionsFrame) => Effect.Effect<void>;
  captions: "途中結果から" | "入れた発言だけ";
  feed: (inlet: Inlet) => Effect.Effect<F, never, Scope.Scope>;
}) {
  const { session, correct, speak, captions } = options;
  const captionTexts = yield* Ref.make<ReadonlyMap<string, { readonly text: string; readonly wordTimes: readonly WordTime[]; readonly replacements: readonly Replacement[] }>>(new Map());
  const relay = yield* createSpeakingRelay({
    // contextは送信時にだけ評価される。工場の構築中には入力を投入しない。
    context: Effect.zipWith(session.unreflectedRemarks, Ref.get(captionTexts), (remarks, texts): CaptionContext => ({
        unreflected: remarks.map(({ id, ...remark }) => {
          const caption = texts.get(id);
          return caption === undefined ? { id, remark } : { id, remark: { ...remark, text: caption.text, wordTimes: caption.wordTimes }, replacements: caption.replacements };
        }),
        held: captions === "途中結果から" ? settling.preview.heldRemarks() : [],
        intervals: captions === "途中結果から" ? settling.preview.segments() : [],
        previewLabel: captions === "途中結果から" ? settling.preview.label : () => undefined,
    })),
    send: speak,
  });
  const count = yield* Ref.make(0);
  const screenCount = yield* Ref.make(0);
  const ocrSummary = yield* Ref.make({ failed: 0, images: 0 });
  const inlet: Inlet = {
    remark: Effect.fnUntraced(function* ({ rest, original, wordTimes, replacements }) {
      const n = yield* Ref.updateAndGet(count, (c) => c + 1);
      const id = `r${n}`;
      if (wordTimes !== undefined) {
        const unreflected = new Set((yield* session.unreflectedRemarks).map((r) => r.id));
        const entry = { text: original?.raw ?? rest.text, wordTimes, replacements };
        yield* Ref.update(captionTexts, (table) => new Map([...table].filter(([key]) => unreflected.has(key)).concat([[id, entry]])));
      }
      yield* session.push({ ...rest, id }, original, wordTimes);
      yield* relay.remark(rest.track);
    }),
    screen: Effect.fnUntraced(function* ({ start, image, lines, ocrFailed }) {
      if (image === null) {
        yield* session.pushScreen({ start, image: null, ...(ocrFailed === true ? { ocrFailed } : {}) }, lines);
      } else {
        const n = yield* Ref.updateAndGet(screenCount, (c) => c + 1);
        yield* session.pushScreen({ start, image: { id: `s${n}`, bytes: image }, ...(ocrFailed === true ? { ocrFailed } : {}) }, lines);
        yield* Ref.update(ocrSummary, (s) => ({ images: s.images + 1, failed: s.failed + (ocrFailed === true ? 1 : 0) }));
      }
    }),
    screenOff: session.pushScreenOff,
  };
  const feed = yield* options.feed(inlet);
  const settling = yield* createRemarkSettling({
    emit: (settled) => Effect.flatMap(correct(settled), feed.remark),
  });
  const stop = Effect.andThen(relay.stop, settling.stop);
  yield* Effect.addFinalizer(() => stop);
  return {
    partial: (p: HelperPartial) => Effect.andThen(settling.partial(p), captions === "途中結果から"
      ? Effect.suspend(() => relay.partial(settling.preview.unemittedTail(p))) : Effect.void),
    final: settling.final,
    speaker: (event: SpeakerLogEvent) => Effect.andThen(settling.speaker(event), captions === "途中結果から" ? relay.speaker(event) : Effect.void),
    renumbered: settling.renumbered,
    ocrSummary: Ref.get(ocrSummary),
    screen: feed.screen,
    screenOff: feed.screenOff,
    drain: Effect.andThen(settling.drain, feed.drain),
    // 再起動ではfeedの並べ替え待ちを出さない。
    drainForRestart: settling.drain,
    captionsChanged: relay.flushAll,
    clearSpeaking: relay.clear,
    stop,
    labels: settling.labels,
    feed,
  };
});
