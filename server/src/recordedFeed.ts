import { Deferred, Effect, Ref, Semaphore, type Scope } from "effect";
import { PACED_CALL_REMARKS, createPacer, createTrackMerge, type DiffUpdateFrame, type DiffUpdateState, type Session, type Track } from "./core/index.ts";
import { createRecordedBacklog } from "./recordedBacklog.ts";
import type { Feed, Inlet } from "./remarkFlow.ts";
import type { CorrectedRemark } from "./sessionVocabulary.ts";

export type TrackEnds = Partial<Readonly<Record<Track, number>>>;
type Pause = { reason: Extract<DiffUpdateState, { status: "paused" }>["reason"]; retryAt: number };
type RecordedItem =
  | { kind: "remark"; corrected: CorrectedRemark }
  | { kind: "screen"; change: Parameters<Inlet["screen"]>[0] }
  | { kind: "screen-off"; off: Parameters<Inlet["screenOff"]>[0] };

const timeOf = (item: RecordedItem): number => item.kind === "remark" ? item.corrected.rest.end : item.kind === "screen" ? item.change.start : item.off.start;

export type RecordedFeed = Feed & {
  observe: (frame: DiffUpdateFrame) => Effect.Effect<void>;
  prepareRestart: Effect.Effect<TrackEnds>;
};

export const recordedFeed = (options: {
  realtime: boolean;
  noMap?: boolean;
  selfTrack: boolean;
  session: Pick<Session, "diffUpdate" | "nextRetryAt" | "idle"> & {
    unreflectedCount: Effect.Effect<number>;
    round: Effect.Effect<number>;
  };
  progress: (progress: { position: number; rounds: number }) => Effect.Effect<void>;
  paused: (pause: Pause | undefined) => Effect.Effect<void>;
}) => Effect.fnUntraced(function* (inlet: Inlet): Effect.fn.Return<RecordedFeed, never, Scope.Scope> {
  const { session } = options;
  const frameChanged = yield* Ref.make(yield* Deferred.make<void>());
  const notifyFrame = Effect.flatMap(Deferred.make<void>(), (next) => Effect.flatMap(Ref.getAndSet(frameChanged, next), (current) => Deferred.succeed(current, undefined)));
  const hold = Effect.gen(function* () {
    for (;;) {
      const changed = yield* Ref.get(frameChanged);
      if ((yield* session.diffUpdate).status !== "paused") return;
      yield* Deferred.await(changed);
    }
  });
  const roomForRemark = Effect.gen(function* () {
    for (;;) {
      const changed = yield* Ref.get(frameChanged);
      if ((yield* session.diffUpdate).status === "stopped" || (yield* session.unreflectedCount) < PACED_CALL_REMARKS) return;
      yield* Deferred.await(changed);
    }
  });
  const pauseLock = yield* Semaphore.make(1);
  const pauseState = yield* Ref.make<Pause | undefined>(undefined);
  const observe = (frame: DiffUpdateFrame): Effect.Effect<void> => Effect.andThen(notifyFrame,
    frame.state === null ? Effect.void : pauseLock.withPermit(Effect.gen(function* () {
      const state = frame.state;
      const retryAt = state?.status === "paused" ? yield* session.nextRetryAt : undefined;
      const before = yield* Ref.get(pauseState);
      const next = state?.status === "paused" && retryAt !== undefined ? { reason: state.reason, retryAt } : undefined;
      if (before?.reason === next?.reason && before?.retryAt === next?.retryAt) return;
      yield* Ref.set(pauseState, next);
      yield* options.paused(next);
    })));
  const pacer = options.realtime ? createPacer((ms) => Effect.sleep(ms)) : undefined;
  const sentScreenOff = yield* Ref.make(false);
  const backlog = yield* createRecordedBacklog<RecordedItem>({
    hold,
    ...(pacer === undefined ? {} : { pace: (item: RecordedItem) => Effect.andThen(pacer.waitUntil(timeOf(item)), item.kind === "remark" ? roomForRemark : Effect.void) }),
    deliver: Effect.fnUntraced(function* (item) {
      if (item.kind === "screen") return yield* inlet.screen(item.change);
      if (item.kind === "screen-off") {
        if (!(yield* Ref.getAndSet(sentScreenOff, true))) yield* inlet.screenOff(item.off);
        return;
      }
      yield* inlet.remark(item.corrected);
      if (pacer === undefined && options.noMap !== true) yield* session.idle;
      yield* options.progress({ position: item.corrected.rest.end, rounds: yield* session.round });
    }),
  });
  const screenQueue = yield* Ref.make<ReadonlyArray<RecordedItem>>([]);
  const enqueueScreen = (item: RecordedItem) => Ref.update(screenQueue, (queue) => [...queue, item]);
  const flushScreens = (limit?: number) => Effect.flatMap(
    Ref.modify(screenQueue, (queue) => [
      limit === undefined ? queue : queue.filter((item) => timeOf(item) < limit),
      limit === undefined ? [] : queue.filter((item) => timeOf(item) >= limit),
    ] as const),
    (due) => Effect.forEach(due, backlog.offer, { discard: true }),
  );
  const merge = options.selfTrack
    ? createTrackMerge<CorrectedRemark>({ tracks: ["相手", "自分"], trackOf: (c) => c.rest.track, timeOf: (c) => c.rest.end })
    : undefined;
  const offerRemarks = (corrected: ReadonlyArray<CorrectedRemark>) => Effect.forEach(corrected, (c) =>
    Effect.andThen(flushScreens(c.rest.end), backlog.offer({ kind: "remark", corrected: c })), { discard: true });
  const madeEnd = yield* Ref.make<TrackEnds>({});
  const drain = Effect.suspend(() => Effect.andThen(offerRemarks(merge?.drain() ?? []), flushScreens()));
  return {
    remark: (corrected) => Effect.andThen(
      Ref.update(madeEnd, (current) => ({ ...current, [corrected.rest.track]: Math.max(current[corrected.rest.track] ?? corrected.rest.end, corrected.rest.end) })),
      Effect.suspend(() => offerRemarks(merge === undefined ? [corrected] : merge.offer(corrected))),
    ),
    screen: (change) => enqueueScreen({ kind: "screen", change }),
    screenOff: (off) => enqueueScreen({ kind: "screen-off", off }),
    observe,
    prepareRestart: Effect.gen(function* () {
      const ends = yield* Ref.get(madeEnd);
      const limit = Math.max(-Infinity, ...Object.values(ends));
      yield* Ref.update(screenQueue, (queue) => queue.filter((item) => timeOf(item) < limit));
      return ends;
    }),
    finish: Effect.andThen(drain, backlog.finish),
    discard: Effect.andThen(Effect.sync(() => { merge?.drain(); }), Effect.andThen(Ref.set(screenQueue, []), backlog.discard)),
  };
});
