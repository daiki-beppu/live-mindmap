import { Cause, Clock, Context, DateTime, Effect, Exit, Fiber, Predicate, Ref, Result, Schema, Semaphore, Stream, type Scope } from "effect";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePaused, DiffUpdatePausedEvent, DiffUpdateRetryEvent, DiffUpdateResumedEvent, DiffUpdateStateEvent, type DiffUpdateLifecycle, type DiffUpdateState } from "./diffUpdate.ts";
import type { KatakanaAnswer } from "./latinWords.ts";
import { toJsonExport, type JsonExport } from "./export.ts";
import { attributePeople } from "./people.ts";
import { cloneNode, Dropped, emptyMap, Op, pointStatus, type DiffOutput, type MeetingMap } from "./map.ts";
import { reflectDiff, type ReflectionState } from "./reflection.ts";
import * as ScreenQueue from "./screenQueue.ts";
import { hasContent, Remark } from "./remark.ts";
import { acceptInferredNames, nameSpeaker as updateSpeakerName, restoreSpeakerName, speakerNameMap, SpeakerNameLogEvent, type SpeakerNameChange, type SpeakerNameTable } from "./speakerNames.ts";
import type { ChangeEntry, Snapshot, SnapshotNode } from "./snapshot.ts";
import { Word, WordTime } from "./words.ts";

export type ScreenChange = {
  readonly start: number;
  readonly image: { readonly id: string; readonly bytes: Uint8Array } | null;
};

export type DiffInput = {
  readonly criteria?: readonly string[];
  map: MeetingMap;
  recent: Remark[];
  fresh: Remark[];
  screens?: readonly ScreenChange[];
  previousResponse?: PreviousResponse;
  speakerNames?: ReadonlyMap<string, string>;
};
export type PreviousResponse = {
  readonly refs: Readonly<Record<string, string>>;
  readonly dropped: readonly Dropped[];
};
export type DiffUpdateError = { readonly _tag: string; readonly message: string };

export const DiffUsage = Schema.Struct({
  input: Schema.Int,
  cacheWrite: Schema.Int,
  cacheRead: Schema.Int,
  output: Schema.Int,
  model: Schema.String,
});
export type DiffUsage = typeof DiffUsage["Type"];
const JudgeRecord = Schema.Struct({
  model: Schema.String,
  ms: Schema.Finite,
  confidence: Schema.optionalKey(Schema.Finite),
  failure: Schema.optionalKey(Schema.String),
});
type JudgeRecord = typeof JudgeRecord["Type"];
export type DiffResult = DiffOutput & { readonly usage?: DiffUsage; readonly judge?: JudgeRecord };
export type DiffUpdateFailure = DiffUpdateError & { readonly judge?: JudgeRecord };

export type KatakanaAsk = (words: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<KatakanaAnswer>, DiffUpdateError>;

export class DiffUpdater extends Context.Service<DiffUpdater, {
  readonly update: (input: DiffInput) => Effect.Effect<DiffResult, DiffUpdateFailure>;
  readonly katakana?: KatakanaAsk;
  readonly lifecycle?: Stream.Stream<DiffUpdateLifecycle>;
}>()("live-mindmap/core/DiffUpdater") {}

export const StartEvent = Schema.Struct({
  type: Schema.Literal("start"), title: Schema.String,
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  model: Schema.optionalKey(Schema.Struct({ name: Schema.String, route: Schema.String, local: Schema.Boolean })),
});
export const RemarkEvent = Schema.Struct({ type: Schema.Literal("remark"), remark: Remark, noContent: Schema.optionalKey(Schema.Literal(true)),
  raw: Schema.optionalKey(Schema.String), words: Schema.optionalKey(Schema.Array(Word)),
  wordTimes: Schema.optionalKey(Schema.Array(WordTime)) });
const ScreenRef = Schema.Struct({ start: Schema.Finite, image: Schema.NullOr(Schema.String) });
export const ScreenEvent = Schema.Struct({ type: Schema.Literal("screen"), start: Schema.Finite, image: Schema.NullOr(Schema.String), lines: Schema.optionalKey(Schema.Array(Schema.String)), ocrFailed: Schema.optionalKey(Schema.Literal(true)) });
export const ScreenOffEvent = Schema.Struct({ type: Schema.Literal("screen-off"), start: Schema.Finite, reason: Schema.Literals(["指定", "許可なし"]) });
export const ScreenInputSkippedEvent = Schema.Struct({
  type: Schema.Literal("screen-input-skipped"),
  reason: Schema.Literal("差分更新には渡さない（モデルが画像を読まない）"),
});
export const DiffEvent = Schema.Struct({
  type: Schema.Literal("diff"),
  input: Schema.Struct({
    recent: Schema.mutable(Schema.Array(Schema.String)),
    fresh: Schema.mutable(Schema.Array(Schema.String)),
    nodeCount: Schema.Finite,
    screens: Schema.optionalKey(Schema.mutable(Schema.Array(ScreenRef))),
    screenCount: Schema.optionalKey(Schema.Finite),
  }),
  ops: Schema.mutable(Schema.Array(Op)),
  dropped: Schema.mutable(Schema.Array(Dropped)),
  error: Schema.optionalKey(Schema.String),
  processedRemarks: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  usage: Schema.optionalKey(DiffUsage),
  judge: Schema.optionalKey(JudgeRecord),
  call: Schema.optionalKey(Schema.Struct({ startedAt: Schema.String, endedAt: Schema.String })),
});

// log.jsonl の時刻の書き方。Clock ではなく実時刻（TestClock の下でも実際の時刻）。Effect を実行した時点で決める
export const logTimestamp = (shiftMs = 0): string => DateTime.formatIso(DateTime.addDuration(DateTime.nowUnsafe(), shiftMs));
export const VocabEvent = Schema.Struct({
  type: Schema.Literal("vocab"),
  words: Schema.Array(Schema.Struct({ surface: Schema.String, romaji: Schema.NullOr(Schema.String), source: Schema.Literals(["user", "screen", "carried"]) })),
});
export const VocabPoolEvent = Schema.Struct({ type: Schema.Literal("vocab-pool"), session: Schema.Int });
export const LogEvent = Schema.Union([StartEvent, RemarkEvent, VocabEvent, VocabPoolEvent, ScreenEvent, ScreenOffEvent, ScreenInputSkippedEvent, DiffEvent, DiffUpdatePausedEvent, DiffUpdateRetryEvent, DiffUpdateResumedEvent, DiffUpdateStateEvent, SpeakerNameLogEvent]);
export type LogEvent = typeof LogEvent["Type"];

export class SessionLog extends Context.Service<SessionLog, {
  readonly write: (event: LogEvent) => Effect.Effect<void>;
  readonly writeScreen: (file: string, bytes: Uint8Array) => Effect.Effect<void>;
  readonly readScreen: (file: string) => Effect.Effect<Uint8Array>;
}>()("live-mindmap/core/SessionLog") {}

export class InvalidLogEvent extends Schema.TaggedError<InvalidLogEvent>()("InvalidLogEvent", {
  index: Schema.Finite,
  reason: Schema.String,
}) {}

const RECENT = 3;

export { hasContent } from "./remark.ts";

export type SessionState = {
  readonly criteria?: readonly string[];
  readonly speakerNames: SpeakerNameTable;
  readonly map: MeetingMap;
  readonly pending: readonly Remark[];
  readonly processed: readonly Remark[];
  readonly remarks: readonly Remark[];
  readonly known: ReadonlySet<string>;
  readonly round: number;
  readonly changes: readonly ChangeEntry[];
  readonly currentTopic: string | undefined;
  readonly lastChanged: string | undefined;
  readonly diffUpdate: DiffUpdateState;
};

export type RestoredScreens = {
  readonly queue: ScreenQueue.ScreenQueue;
  readonly files: ReadonlySet<string>;
};

const previousResponseOf = (applied: { refs: Record<string, string>; dropped: Dropped[] }): PreviousResponse | undefined =>
  Object.keys(applied.refs).length || applied.dropped.length ? { refs: applied.refs, dropped: applied.dropped } : undefined;

const typeOf = (event: unknown): unknown => (Predicate.isObject(event) && "type" in event ? event.type : undefined);

const decodeStart = Schema.decodeUnknownEffect(StartEvent);
const decodeRemark = Schema.decodeUnknownEffect(RemarkEvent);
const decodeDiff = Schema.decodeUnknownEffect(DiffEvent);
const decodeSpeakerName = Schema.decodeUnknownEffect(SpeakerNameLogEvent);
const decodePaused = Schema.decodeUnknownEffect(DiffUpdatePausedEvent);
const decodeScreen = Schema.decodeUnknownEffect(ScreenEvent);

type Ledger = {
  readonly remarks: Remark[];
  readonly byId: Map<string, Remark>;
  processed: readonly Remark[];
  known: ReadonlySet<string>;
  readonly files: Set<string>;
};
type Replay = {
  readonly criteria?: readonly string[];
  readonly map: MeetingMap | undefined;
  readonly history: ReflectionState["history"];
  readonly queue: ScreenQueue.ScreenQueue;
  readonly diffUpdate: DiffUpdateState;
};

export const restoreState = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<SessionState & { readonly screens: RestoredScreens }, InvalidLogEvent> {
  const ledger: Ledger = { remarks: [], byId: new Map(), processed: [], known: new Set(), files: new Set() };
  let speakerNames: SpeakerNameTable = new Map();
  let replay: Replay = {
    map: undefined, history: { round: 0, changes: [], currentTopic: undefined, lastChanged: undefined },
    queue: ScreenQueue.make(), diffUpdate: { status: "running" },
  };
  let index = -1;
  for (const event of events) {
    index++;
    const invalid = (reason: string) => new InvalidLogEvent({ index, reason });
    const failed = Effect.mapError((error: { readonly message: string }) => invalid(error.message));
    const type = typeOf(event);
    if (type === StartEvent.fields.type.literal) {
      const e = yield* decodeStart(event).pipe(failed);
      replay = { ...replay, criteria: e.criteria, map: emptyMap(e.title) };
    } else if (type === RemarkEvent.fields.type.literal) {
      const e = yield* decodeRemark(event).pipe(failed);
      ledger.remarks.push(e.remark);
      ledger.byId.set(e.remark.id, e.remark);
    } else if (type === ScreenEvent.fields.type.literal) {
      const e = yield* decodeScreen(event).pipe(failed);
      if (e.image !== null) ledger.files.add(e.image);
      replay = { ...replay, queue: ScreenQueue.receive(replay.queue, e, replay.diffUpdate.status === "paused") };
    } else if (type === DiffEvent.fields.type.literal) {
      const e = yield* decodeDiff(event).pipe(failed);
      const map = yield* Effect.fromNullishOr(replay.map).pipe(Effect.mapError(() => invalid("ログの diff より前に start がありません")));
      const { state } = yield* Effect.fromResult(reflectDiff({ map, criteria: replay.criteria, history: replay.history, ledger }, e)).pipe(Effect.mapError(invalid));
      const cutoff = Math.max(...e.input.fresh.map((id) => ledger.byId.get(id)!.end));
      const queue = yield* Effect.fromResult(ScreenQueue.consume(replay.queue, e, cutoff)).pipe(Effect.mapError(invalid));
      ledger.known = state.ledger.known;
      ledger.processed = state.ledger.processed;
      replay = { ...replay, queue, map: state.map, history: state.history, diffUpdate: { status: "running" } };
    } else if (type === SpeakerNameLogEvent.fields.type.literal) {
      const e = yield* decodeSpeakerName(event).pipe(failed);
      speakerNames = restoreSpeakerName(speakerNames, e);
    } else if (type === ScreenInputSkippedEvent.fields.type.literal) {
      replay = { ...replay, queue: ScreenQueue.skipImages(replay.queue) };
    } else if (type === DiffUpdatePausedEvent.fields.type.literal) {
      const e = yield* decodePaused(event).pipe(failed);
      replay = { ...replay, queue: ScreenQueue.markPaused(replay.queue), diffUpdate: { status: "paused", reason: e.reason } };
    } else if (type === DiffUpdateResumedEvent.fields.type.literal) {
      replay = { ...replay, diffUpdate: { status: "running" } };
    }
  }
  const { remarks, processed, known, files } = ledger;
  const { map, history, queue, diffUpdate } = replay;
  const restoredMap = yield* Effect.fromNullishOr(map).pipe(Effect.mapError(() => new InvalidLogEvent({ index: 0, reason: "ログに start がありません" })));
  const pending = remarks.filter((r) => !r.duplicate && !known.has(r.id) && hasContent(r.text));
  return { ...(replay.criteria?.length ? { criteria: replay.criteria } : {}), map: restoredMap, speakerNames, pending, processed, remarks, known, ...history, diffUpdate, screens: { queue, files } };
});

export function snapshotOf(state: SessionState): Snapshot {
  const { map } = state;
  const nodes = map.order.map((id): SnapshotNode => {
    const n = cloneNode(map.nodes[id]!);
    return n.kind === "論点" ? { ...n, pointStatus: pointStatus(map, id) } : n;
  });
  const cited = new Set(nodes.flatMap((n) => n.evidence));
  const last = state.remarks.at(-1);
  return {
    ...(state.criteria?.length ? { criteria: [...state.criteria] } : {}),
    nodes,
    round: state.round,
    changes: state.changes.map((c) => ({ ...c })),
    remarks: state.remarks.filter((r) => cited.has(r.id)).map((r) => ({ ...r })),
    ...(state.currentTopic !== undefined ? { currentTopic: state.currentTopic } : {}),
    ...(state.lastChanged !== undefined ? { lastChanged: state.lastChanged } : {}),
    ...(last ? { now: last.end } : {}),
  };
}

export type Session = {
  readonly nameSpeaker: (change: SpeakerNameChange) => Effect.Effect<void>;
  readonly push: (remark: Remark, original?: { readonly raw: string; readonly words: readonly Word[] }, wordTimes?: readonly WordTime[]) => Effect.Effect<void>;
  readonly idle: Effect.Effect<void>;
  readonly pushScreen: (change: ScreenChange & Pick<typeof ScreenEvent.Type, "ocrFailed">, lines?: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly pushScreenOff: (off: Pick<typeof ScreenOffEvent["Type"], "start" | "reason">) => Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<Snapshot>;
  readonly diffUpdate: Effect.Effect<DiffUpdateState>;
  readonly nextRetryAt: Effect.Effect<number | undefined>;
  readonly unreflectedRemarks: Effect.Effect<Remark[]>;
  readonly exportJson: Effect.Effect<JsonExport>;
};

type Reservation = { readonly kind: "reserved"; readonly call: number };
type InFlight = Reservation | { readonly kind: "running"; readonly call: number; readonly fiber: Fiber.Fiber<void> };

type Runtime = {
  readonly previousResponse: PreviousResponse | undefined;
  readonly retryEnabled: boolean;
  readonly nextRetryAt: number | undefined;
  readonly inFlight: InFlight | undefined;
  readonly nextCall: number;
  readonly reflecting: readonly Remark[];
  readonly catchUpUntil: string | undefined;
  readonly screenQueue: ScreenQueue.ScreenQueue;
  readonly screenFiles: ReadonlySet<string>;
};

type StartVerdict = "callInFlight" | "nothingToStart";

export const PACED_CALL_REMARKS = 2;

function screenFileName(start: number, used: ReadonlySet<string>): string {
  const base = start.toFixed(1).padStart(6, "0");
  let name = `${base}.jpg`;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}.jpg`;
  return name;
}

function presentFields<T extends object, K extends keyof T>(source: T, keys: readonly K[]): { [P in K]?: Exclude<T[P], undefined> } {
  return Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]])) as { [P in K]?: Exclude<T[P], undefined> };
}

const classifyFailure = (cause: Cause.Cause<DiffUpdateFailure>) => {
  const failure = Cause.findError(cause);
  const judge = Result.isSuccess(failure) ? failure.success.judge : undefined;
  return {
    judge,
    ok: false as const,
    error: Result.isSuccess(failure) ? `${failure.success._tag}: ${failure.success.message}` : `defect: ${String(Cause.squash(cause))}`,
    pause: Result.isSuccess(failure) && Schema.is(DiffUpdatePaused)(failure.success) ? failure.success : undefined,
    stopped: Result.isSuccess(failure) && failure.success._tag === "DiffUpdateStopped",
  };
};

function takeFresh(pending: readonly Remark[], catchUpUntil: string | undefined): { readonly fresh: readonly Remark[]; readonly rest: readonly Remark[]; readonly catchUpUntil: string | undefined } {
  if (catchUpUntil === undefined || !pending.some((r) => r.id === catchUpUntil)) return { fresh: pending, rest: [], catchUpUntil: undefined };
  return { fresh: pending.slice(0, PACED_CALL_REMARKS), rest: pending.slice(PACED_CALL_REMARKS), catchUpUntil };
}

const openSession = Effect.fnUntraced(function* (initial: SessionState, screens: RestoredScreens, logShiftMs: number, updater?: DiffUpdater["Service"]): Effect.fn.Return<Session, never, Scope.Scope | SessionLog> {
  const scope = yield* Effect.scope;
  const log = yield* SessionLog;
  const screenTransitions = yield* Semaphore.make(1);
  const ref = yield* Ref.make<SessionState & Runtime>({ ...initial, previousResponse: undefined, retryEnabled: true, nextRetryAt: undefined, inFlight: undefined, nextCall: 0, reflecting: [], catchUpUntil: undefined, screenQueue: screens.queue, screenFiles: screens.files });

  const nameSpeaker = (change: SpeakerNameChange): Effect.Effect<void> =>
    Effect.uninterruptible(screenTransitions.withPermit(Effect.gen(function* () {
      const next = yield* Ref.modify(ref, (s): [SpeakerNameTable | undefined, SessionState & Runtime] => {
        const next = updateSpeakerName(s.speakerNames, change);
        return [next, next === undefined ? s : { ...s, speakerNames: next }];
      });
      if (next === undefined) return;
      yield* log.write({ type: "speaker-name", label: change.label, name: next.get(change.label)!.name, source: change.source });
    })));

  const setLifecycleState = Effect.fnUntraced(function* (state: DiffUpdateState) {
    const changed = yield* Ref.modify(ref, (s): [boolean, SessionState & Runtime] =>
      s.diffUpdate.status === "stopped" || s.diffUpdate.status === state.status
        ? [false, s] : [true, { ...s, diffUpdate: state, nextRetryAt: undefined }]);
    if (changed) yield* log.write({ type: "diff-update-state", state });
  });
  if (updater?.lifecycle) yield* Effect.forkIn(Stream.runForEach(updater.lifecycle, (notification) =>
    setLifecycleState("status" in notification ? notification : { status: "stopped" }).pipe(Effect.uninterruptible),
  ), scope, { startImmediately: true });

  type Taken = { readonly fresh: readonly Remark[]; readonly call: number };
  function takeStep(s: SessionState & Runtime): [Taken, SessionState & Runtime] {
    const taken = takeFresh(s.pending, s.catchUpUntil);
    return [{ fresh: taken.fresh, call: s.nextCall }, { ...s, pending: taken.rest, catchUpUntil: taken.catchUpUntil, inFlight: { kind: "reserved", call: s.nextCall }, nextCall: s.nextCall + 1 }];
  }

  function startDiffIfReady(retry = false): Effect.Effect<StartVerdict> {
    if (updater === undefined) return Effect.succeed("nothingToStart");
    return Effect.uninterruptible(
      Effect.gen(function* () {
        const taken = yield* Ref.modify(ref, (s): [StartVerdict | Taken, SessionState & Runtime] =>
          s.inFlight ? ["callInFlight", s]
            : s.pending.length === 0 || (retry ? !s.retryEnabled || s.diffUpdate.status !== "paused" : s.diffUpdate.status === "paused" || s.diffUpdate.status === "stopped") ? ["nothingToStart", s]
              : takeStep(s),
        );
        if (typeof taken === "string") return taken;
        const { fresh, call } = taken;
        const fiber = yield* Effect.forkIn(Effect.interruptible(runCall(updater, fresh)), scope, { startImmediately: true });
        yield* Ref.update(ref, (s) => (s.inFlight?.kind === "reserved" && s.inFlight.call === call ? { ...s, inFlight: { kind: "running" as const, call, fiber } } : s));
        return "callInFlight";
      }),
    );
  }

  const scheduleRetry: Effect.Effect<void> = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const { retryEnabled, nextRetryAt } = yield* Ref.modify(ref, (s) => {
      const next = s.nextRetryAt ?? now + DIFF_UPDATE_RETRY_MS;
      return [{ retryEnabled: s.retryEnabled, nextRetryAt: next }, s.nextRetryAt === undefined ? { ...s, nextRetryAt: next } : s] as const;
    });
    const wait = Math.max(0, nextRetryAt - now);
    if (retryEnabled) yield* Effect.forkIn(Effect.sleep(wait).pipe(Effect.andThen(startDiffIfReady(true))), scope);
  });
  if (initial.diffUpdate.status === "paused") yield* scheduleRetry;

  function runCall(updater: DiffUpdater["Service"], fresh: readonly Remark[]): Effect.Effect<void> {
    return callUpdater(updater, fresh).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* Ref.update(ref, (s) => ({ ...s, inFlight: undefined }));
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
          const state = yield* Ref.get(ref);
          if (state.diffUpdate.status === "paused") {
            yield* scheduleRetry;
            return;
          }
          yield* startDiffIfReady();
        }),
      ),
      Effect.asVoid,
    );
  }

  function callUpdater(updater: DiffUpdater["Service"], fresh: readonly Remark[]): Effect.Effect<void> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const state = (yield* Ref.get(ref)).diffUpdate;
        if (state.status === "paused") yield* log.write({ type: "diff-update-retry", reason: state.reason });
        const cutoff = Math.max(...fresh.map((u) => u.end));
        const { map, recent, input, previousResponse } = yield* Ref.modify(ref, (s) => {
          const recent = s.processed.slice(-RECENT);
          const input = {
            recent: recent.map((u) => u.id),
            fresh: fresh.map((u) => u.id),
            nodeCount: s.map.order.length - 1,
            ...ScreenQueue.select(s.screenQueue, cutoff),
          };
          return [
            { map: s.map, recent, input, previousResponse: s.previousResponse },
            { ...s, reflecting: fresh },
          ];
        });
        const readBack = (screen: NonNullable<typeof input.screens>[number]): Effect.Effect<ScreenChange> => {
          const file = screen.image;
          return file === null ? Effect.succeed({ start: screen.start, image: null }) : Effect.map(log.readScreen(file), (bytes) => ({ start: screen.start, image: { id: file, bytes } }));
        };
        type CallTimes = { startedAt: string; endedAt: string };
        const classifyUnlessInterrupt = (cause: Cause.Cause<DiffUpdateFailure>) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(classifyFailure(cause)));
        const outcome = yield* Effect.forEach(input.screens ?? [], readBack).pipe(
          Effect.flatMap((screens) =>
            Effect.gen(function* () {
              const current = yield* Ref.get(ref);
              const speakerNames = speakerNameMap(current.speakerNames);
              const startedAt = logTimestamp(logShiftMs);
              return yield* Effect.exit(restore(updater.update({ ...(current.criteria?.length ? { criteria: current.criteria } : {}), map, recent: [...recent], fresh: [...fresh], ...(screens.length ? { screens } : {}), ...(previousResponse ? { previousResponse } : {}), ...(speakerNames.size ? { speakerNames } : {}) }))).pipe(
                Effect.map((exit) => ({ exit, call: { startedAt, endedAt: logTimestamp(logShiftMs) } as CallTimes })),
              );
            }),
          ),
          Effect.flatMap(({ exit, call }) =>
            exit.pipe(
              Effect.flatMap(({ ops, usage, judge, processedRemarks, names }) => {
                const count = processedRemarks ?? fresh.length;
                return !Number.isInteger(count) || count <= 0 || count > fresh.length
                  ? Effect.fail({ _tag: "InvalidProcessedRemarks", message: "反映数が入力の発言数に対して不正です", judge })
                  : Effect.succeed({ ok: true as const, ops, names, usage, judge, processedRemarks, count, call: call as CallTimes | undefined });
              }),
              Effect.catchCause((cause) => Effect.map(classifyUnlessInterrupt(cause), (failure) => ({ ...failure, call: call as CallTimes | undefined }))),
            ),
          ),
          Effect.catchCause((cause) => Effect.map(classifyUnlessInterrupt(cause), (failure) => ({ ...failure, call: undefined as CallTimes | undefined }))),
        );
        if (!outcome.ok) {
          if (outcome.stopped) {
            yield* Ref.update(ref, (s) => ({ ...s, reflecting: [], pending: [...fresh, ...s.pending], previousResponse: undefined }));
            yield* setLifecycleState({ status: "stopped" });
            return;
          }
          if (outcome.pause) {
            const { reason } = outcome.pause;
            const requestedAt = state.status === "paused" ? undefined : outcome.pause.retryAt;
            const now = yield* Clock.currentTimeMillis;
            const nextRetryAt = requestedAt !== undefined && requestedAt > now ? requestedAt : now + DIFF_UPDATE_RETRY_MS;
            yield* screenTransitions.withPermit(Effect.gen(function* () {
              yield* Ref.update(ref, (s) => ({ ...s, screenQueue: ScreenQueue.markPaused(s.screenQueue), reflecting: [], pending: [...fresh, ...s.pending], catchUpUntil: [...fresh, ...s.pending].at(-1)?.id, diffUpdate: { status: "paused" as const, reason }, nextRetryAt, previousResponse: undefined }));
              yield* log.write({ type: "diff-update-paused", reason });
            }));
            return;
          }
          const event: typeof DiffEvent.Type = { type: "diff", input, ops: [], dropped: [], error: outcome.error, ...presentFields(outcome, ["judge", "call"]) };
          yield* screenTransitions.withPermit(Effect.gen(function* () {
            let dropped: Dropped[] = [];
            yield* Ref.update(ref, (s) => {
              const byId = new Map(s.remarks.map((r) => [r.id, r]));
              const applied = Result.getOrThrowWith(reflectDiff({ map: s.map, criteria: s.criteria, history: s, ledger: { byId, known: s.known, processed: s.processed } }, event), (reason) => new Error(reason));
              const screenQueue = Result.getOrThrowWith(ScreenQueue.consume(s.screenQueue, event, cutoff), (reason) => new Error(reason));
              dropped = applied.dropped;
              return { ...s, ...applied.state.history, screenQueue, map: applied.state.map, known: applied.state.ledger.known, processed: applied.state.ledger.processed,
                diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, nextRetryAt: undefined, reflecting: [], previousResponse: undefined };
            });
            yield* log.write({ ...event, dropped });
          }));
          return;
        }
        const accepted = yield* screenTransitions.withPermit(Effect.gen(function* () {
          const { event, dropped, accepted } = yield* Ref.modify(ref, (s) => {
            const byId = new Map(s.remarks.map((r) => [r.id, r]));
            const ops = attributePeople(outcome.ops, byId);
            const event: typeof DiffEvent.Type = { type: "diff", input, ops, dropped: [], ...presentFields(outcome, ["processedRemarks", "usage", "judge", "call"]) };
            const applied = Result.getOrThrowWith(reflectDiff({ map: s.map, criteria: s.criteria, history: s, ledger: { byId, known: s.known, processed: s.processed } }, event), (reason) => new Error(reason));
            const screenQueue = Result.getOrThrowWith(ScreenQueue.consume(s.screenQueue, event, cutoff), (reason) => new Error(reason));
            const accepted = acceptInferredNames(outcome.names, applied.state.ledger.known, byId);
            return [{ event, dropped: applied.dropped, accepted }, {
              ...s, ...applied.state.history, screenQueue, diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, nextRetryAt: undefined, map: applied.state.map, reflecting: [], previousResponse: previousResponseOf(applied),
              known: applied.state.ledger.known, processed: applied.state.ledger.processed, pending: [...fresh.slice(outcome.count), ...s.pending],
            }];
          });
          yield* log.write({ ...event, dropped });
          return accepted;
        }));
        if (state.status === "paused") yield* log.write({ type: "diff-update-resumed" });
        yield* Effect.forEach(accepted, ({ label, name, basis }) => nameSpeaker({ label, name, source: "推定", basis }), { discard: true });
      }),
    );
  }

  const idle: Effect.Effect<void> = Effect.gen(function* () {
    for (;;) {
      const { inFlight } = yield* Ref.get(ref);
      if (!inFlight) return;
      if (inFlight.kind === "reserved") yield* Effect.yieldNow;
      else yield* Fiber.join(inFlight.fiber);
    }
  });

  return {
    push: (r, original, wordTimes) =>
      Effect.gen(function* () {
        yield* Ref.update(ref, (s) => ({ ...s, remarks: [...s.remarks, r] }));
        const extra = { ...(original === undefined ? {} : { raw: original.raw, words: original.words }), ...(wordTimes === undefined ? {} : { wordTimes }) };
        if (!r.duplicate && !hasContent(r.text)) {
          yield* log.write({ type: "remark", remark: r, noContent: true, ...extra });
          return;
        }
        yield* log.write({ type: "remark", remark: r, ...extra });
        if (r.duplicate) return;
        yield* Ref.update(ref, (s) => ({ ...s, pending: [...s.pending, r], catchUpUntil: s.diffUpdate.status === "paused" ? r.id : s.catchUpUntil }));
        yield* startDiffIfReady();
      }),
    idle,
    pushScreen: (change, lines) =>
      Effect.gen(function* () {
        const file = yield* Ref.modify(ref, (s): [string | null, SessionState & Runtime] => {
          const file = change.image ? screenFileName(change.start, s.screenFiles) : null;
          return [file, { ...s, screenFiles: file ? new Set([...s.screenFiles, file]) : s.screenFiles }];
        });
        if (change.image && file) yield* log.writeScreen(file, change.image.bytes);
        yield* screenTransitions.withPermit(Effect.uninterruptible(Effect.gen(function* () {
          yield* log.write({ type: "screen", start: change.start, image: file, ...(change.ocrFailed === true ? { ocrFailed: true } : lines === undefined ? {} : { lines }) });
          yield* Ref.update(ref, (s) => ({ ...s, screenQueue: ScreenQueue.receive(s.screenQueue, { start: change.start, image: file }, s.diffUpdate.status === "paused") }));
        })));
      }),
    pushScreenOff: ({ start, reason }) => log.write({ type: "screen-off", start, reason }),
    flush: Effect.gen(function* () {
      yield* Ref.update(ref, (s) => ({ ...s, retryEnabled: false }));
      for (;;) {
        yield* idle;
        if ((yield* startDiffIfReady()) === "nothingToStart") return;
      }
    }),
    snapshot: Effect.map(Ref.get(ref), snapshotOf),
    diffUpdate: Effect.map(Ref.get(ref), (s) => s.diffUpdate),
    nextRetryAt: Effect.map(Ref.get(ref), (s) => s.nextRetryAt),
    unreflectedRemarks: Effect.map(Ref.get(ref), (s) => [...s.reflecting, ...s.pending].map((r) => ({ ...r }))),
    nameSpeaker,
    exportJson: Effect.map(Ref.get(ref), (s) => toJsonExport(snapshotOf(s), [...s.remarks], speakerNameMap(s.speakerNames))),
  } satisfies Session;
});

type NewSessionOptions = { readonly title: string; readonly criteria?: readonly string[]; readonly images?: boolean; readonly logShiftMs?: number };

const createSession = Effect.fnUntraced(function* ({ title, criteria, images = true, logShiftMs = 0 }: NewSessionOptions, updater: DiffUpdater["Service"] | undefined): Effect.fn.Return<Session, never, Scope.Scope | SessionLog> {
  const log = yield* SessionLog;
  yield* log.write({ type: "start", title, ...(criteria?.length ? { criteria: [...criteria] } : {}) });
  if (!images) yield* log.write({
    type: ScreenInputSkippedEvent.fields.type.literal,
    reason: ScreenInputSkippedEvent.fields.reason.literal,
  });
  const queue = ScreenQueue.make();
  return yield* openSession({
    ...(criteria?.length ? { criteria: [...criteria] } : {}),
    map: emptyMap(title),
    speakerNames: new Map(),
    pending: [],
    processed: [],
    remarks: [],
    known: new Set(),
    round: 0,
    changes: [],
    currentTopic: undefined,
    lastChanged: undefined,
    diffUpdate: { status: "running" },
  }, { queue: images ? queue : ScreenQueue.skipImages(queue), files: new Set() }, logShiftMs, updater);
});

export const makeSession = Effect.fnUntraced(function* (options: NewSessionOptions) {
  return yield* createSession(options, yield* DiffUpdater);
});

export const makeTranscriptSession = (options: NewSessionOptions) => createSession(options, undefined);

export const restoreSession = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<Session, InvalidLogEvent, Scope.Scope | DiffUpdater | SessionLog> {
  const { screens, ...state } = yield* restoreState(events);
  return yield* openSession(state, screens, 0, yield* DiffUpdater);
});
