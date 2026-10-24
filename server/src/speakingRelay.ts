import { Clock, Effect, Fiber, Ref } from "effect";
import { createCaptionBoard, type CaptionBoardInput, type CaptionsFrame, type HelperPartial, type SpeakerLogEvent, type Track } from "./core/index.ts";
import { createStopGate } from "./stopGate.ts";

export const SPEAKING_INTERVAL_MS = 300;

export type CaptionContext = Omit<CaptionBoardInput, "partials">;

export type SpeakingRelayOptions = {
  context: Effect.Effect<CaptionContext>;
  send: (frame: CaptionsFrame) => Effect.Effect<void>;
};

type State = { partials: Record<Track, HelperPartial | undefined>; lastSent: number | undefined; lastFrame: string; timer: Fiber.Fiber<void> | undefined };

export const createSpeakingRelay = Effect.fnUntraced(function* ({ context, send }: SpeakingRelayOptions) {
  const scope = yield* Effect.scope;
  const board = createCaptionBoard();
  const state = yield* Ref.make<State>({ partials: { 相手: undefined, 自分: undefined }, lastSent: undefined, lastFrame: "", timer: undefined });
  const gate = yield* createStopGate;
  const { unlessStopped } = gate;

  const cancel = Effect.fnUntraced(function* () {
    const fiber = yield* Ref.modify(state, (current): [Fiber.Fiber<void> | undefined, State] => [current.timer, { ...current, timer: undefined }]);
    if (fiber === undefined) return;
    yield* Fiber.interrupt(fiber);
  });

  const emit = Effect.fnUntraced(function* (frame: CaptionsFrame) {
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(state, (s) => ({ ...s, lastSent: now, lastFrame: JSON.stringify(frame) }));
    yield* send(frame);
  });

  const inputNow = Effect.fnUntraced(function* () {
    const { partials } = yield* Ref.get(state);
    return { ...(yield* context), partials: Object.values(partials).filter((p) => p !== undefined) } satisfies CaptionBoardInput;
  });
  const flush = Effect.fnUntraced(function* () {
    yield* cancel();
    yield* emit({ type: "captions", bubbles: board.build(yield* inputNow()) });
  });

  const reserve = Effect.fnUntraced(function* (wait: number) {
    const fiber = yield* Effect.forkIn(
      Effect.gen(function* () {
        yield* Effect.sleep(wait);
        yield* Ref.update(state, (s) => ({ ...s, timer: undefined }));
        yield* flush();
      }),
      scope,
    );
    yield* Ref.update(state, (s) => ({ ...s, timer: fiber }));
  });

  const throttled = Effect.fnUntraced(function* () {
    const { timer, lastSent } = yield* Ref.get(state);
    if (timer !== undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const wait = lastSent === undefined ? 0 : lastSent + SPEAKING_INTERVAL_MS - now;
    if (wait <= 0) yield* flush();
    else yield* reserve(wait);
  });

  const emptyFrame = Effect.fnUntraced(function* () {
    yield* cancel();
    yield* Ref.update(state, (s) => ({ ...s, partials: { 相手: undefined, 自分: undefined } }));
    board.reset();
    yield* emit({ type: "captions", bubbles: [] });
  });

  return {
    partial: (p: HelperPartial) =>
      unlessStopped(
        Effect.andThen(
          Ref.update(state, (s) => ({ ...s, partials: { ...s.partials, [p.track]: p } })),
          throttled(),
        ),
      ),
    remark: (track: Track) =>
      unlessStopped(
        Effect.andThen(
          Ref.update(state, (s) => ({ ...s, partials: { ...s.partials, [track]: undefined } })),
          flush(),
        ),
      ),
    speaker: (event: SpeakerLogEvent) =>
      unlessStopped(
        Effect.gen(function* () {
          if (event.type === "speaker-settled" || event.type === "speaker-mixed" || event.type === "speaker-centroid") {
            const { lastFrame } = yield* Ref.get(state);
            const frame = { type: "captions", bubbles: board.preview(yield* inputNow()) } satisfies CaptionsFrame;
            if (JSON.stringify(frame) !== lastFrame) yield* throttled();
          }
        }),
      ),
    flushAll: unlessStopped(flush()),
    clear: unlessStopped(emptyFrame()),
    stop: unlessStopped(Effect.andThen(gate.stop, emptyFrame())),
    scheduled: Effect.map(Ref.get(state), (s) => s.timer !== undefined),
  };
});
