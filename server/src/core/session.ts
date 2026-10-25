import { Cause, Clock, Context, DateTime, Effect, Exit, Fiber, Predicate, Ref, Result, Schema, Stream, type Scope } from "effect";
import { diffMaps } from "./changes.ts";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePaused, DiffUpdatePausedEvent, DiffUpdateRetryEvent, DiffUpdateResumedEvent, DiffUpdateStateEvent, type DiffUpdateLifecycle, type DiffUpdateState } from "./diffUpdate.ts";
import type { KatakanaAnswer } from "./latinWords.ts";
import { toJsonExport, type JsonExport } from "./export.ts";
import { attributePeople } from "./people.ts";
import { applyOps, cloneNode, Dropped, emptyMap, Op, pointStatus, type AppliedOps, type DiffOutput, type MeetingMap } from "./map.ts";
import { lastChangedNode, nextCurrentTopic } from "./topic.ts";
import { anchorAfter, byStart, carriedOf, selectScreens } from "./screenSelection.ts";
import { Remark } from "./remark.ts";
import { acceptInferredNames, type InferredSpeakerName } from "./speakerNames.ts";
import type { ChangeEntry, Snapshot, SnapshotNode } from "./snapshot.ts";
import { Word, WordTime } from "./words.ts";

export type ScreenChange = {
  readonly start: number;
  readonly image: { readonly id: string; readonly bytes: Uint8Array } | null;
};

export type DiffInput = {
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
export const LogEvent = Schema.Union([StartEvent, RemarkEvent, VocabEvent, VocabPoolEvent, ScreenEvent, ScreenOffEvent, ScreenInputSkippedEvent, DiffEvent, DiffUpdatePausedEvent, DiffUpdateRetryEvent, DiffUpdateResumedEvent, DiffUpdateStateEvent]);
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

export const FILLERS: ReadonlySet<string> = new Set([
  "あ", "え", "う", "お", "ん", "うん", "ふん", "ええ", "はあ", "へえ", "ほう",
  "あの", "えっと", "えと", "その", "まあ", "はい",
]);

export function hasContent(text: string): boolean {
  const words = text.replace(/[ー〜~]/g, "").split(/[\s\p{P}\p{S}]+/u).filter((w) => w !== "");
  return words.some((w) => !FILLERS.has(w));
}


export type SessionState = {
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

type ScreenRefs = { readonly start: number; readonly image: string | null };
export type RestoredScreens = {
  readonly unsent: readonly ScreenRefs[];
  readonly files: ReadonlySet<string>;
  readonly received: number;
  readonly carried: string | undefined;
  readonly anchor: number | undefined;
};

type History = Pick<SessionState, "round" | "changes" | "currentTopic" | "lastChanged">;

export const stampOf = (history: { round: number }, fresh: readonly Remark[]) => ({ round: history.round + 1, at: Math.max(...fresh.map((r) => r.end)) });

function recordRound(history: History, before: MeetingMap, applied: Pick<AppliedOps, "map" | "changeOrder" | "combined">, stamp: { round: number; at: number }): History {
  const { round, at } = stamp;
  const added = diffMaps(before, applied).map((c): ChangeEntry => ({ ...c, round, at }));
  const lastChanged = lastChangedNode(applied.map, applied.changeOrder);
  return {
    round,
    changes: [...history.changes, ...added],
    lastChanged,
    currentTopic: nextCurrentTopic(applied.map, lastChanged, history.currentTopic),
  };
}

const previousResponseOf = (applied: { refs: Record<string, string>; dropped: Dropped[] }): PreviousResponse | undefined =>
  Object.keys(applied.refs).length || applied.dropped.length ? { refs: applied.refs, dropped: applied.dropped } : undefined;

const typeOf = (event: unknown): unknown => (Predicate.isObject(event) && "type" in event ? event.type : undefined);

const decodeStart = Schema.decodeUnknownEffect(StartEvent);
const decodeRemark = Schema.decodeUnknownEffect(RemarkEvent);
const decodeDiff = Schema.decodeUnknownEffect(DiffEvent);
const decodePaused = Schema.decodeUnknownEffect(DiffUpdatePausedEvent);
const decodeScreen = Schema.decodeUnknownEffect(ScreenEvent);

type UnsentScreen = ScreenRefs & { readonly seq: number };
type Ledger = {
  readonly remarks: Remark[];
  readonly byId: Map<string, Remark>;
  readonly processed: Remark[];
  readonly known: Set<string>;
  readonly files: Set<string>;
  unsent: UnsentScreen[];
};
type Replay = {
  readonly map: MeetingMap | undefined;
  readonly history: History;
  readonly received: number;
  readonly carried: string | undefined;
  readonly anchor: number | undefined;
  readonly imagesSkipped: boolean;
  readonly diffUpdate: DiffUpdateState;
};

const freshRemarksOf = (remarks: readonly Remark[], ids: readonly string[], invalid: (reason: string) => InvalidLogEvent): Effect.Effect<Remark[], InvalidLogEvent> => {
  const fresh: Remark[] = [];
  for (const id of ids) {
    const r = remarks.find((x) => x.id === id);
    if (!r) return Effect.fail(invalid(`ログに発言がありません: ${id}`));
    fresh.push(r);
  }
  return Effect.succeed(fresh);
};

const consumeFresh = (ledger: Ledger, fresh: readonly Remark[], e: typeof DiffEvent["Type"], invalid: (reason: string) => InvalidLogEvent): Effect.Effect<readonly Remark[], InvalidLogEvent> => {
  const count = e.error !== undefined ? fresh.length : e.processedRemarks ?? fresh.length;
  if (count > fresh.length) return Effect.fail(invalid("diff の反映数が入力の発言数を超えています"));
  const consumed = fresh.slice(0, count);
  for (const r of consumed) {
    ledger.known.add(r.id);
    if (hasContent(r.text)) ledger.processed.push(r);
  }
  return Effect.succeed(consumed);
};

const replayDiff = Effect.fnUntraced(function* (replay: Replay, ledger: Ledger, e: typeof DiffEvent["Type"], invalid: (reason: string) => InvalidLogEvent): Effect.fn.Return<Replay, InvalidLogEvent> {
  const { map } = replay;
  if (!map) return yield* invalid("ログの diff より前に start がありません");
  const fresh = yield* freshRemarksOf(ledger.remarks, e.input.fresh, invalid);
  const consumed = yield* consumeFresh(ledger, fresh, e, invalid);
  const selectedBefore = e.input.screenCount ?? 0;
  if (selectedBefore > replay.received) return yield* invalid(`diff の screenCount ${selectedBefore} が、ここまでの screen の行の数 ${replay.received} より大きい`);
  const cutoff = Math.max(...fresh.map((r) => r.end));
  const added = e.input.screens ?? [];
  const candidates = fresh.length ? byStart(ledger.unsent.filter((h) => h.seq < selectedBefore && (h.start <= cutoff || h.image === replay.carried))) : [];
  const carried = replay.imagesSkipped ? undefined : carriedOf(candidates, new Set(added.flatMap((h) => (h.image === null ? [] : [h.image]))));
  const anchor = anchorAfter(added, replay.anchor);
  if (fresh.length) ledger.unsent = ledger.unsent.filter((h) => h.seq >= selectedBefore || h.start > cutoff || (h.image !== null && h.image === carried));
  const stamp = stampOf(replay.history, consumed);
  const applied = applyOps(map, e.ops, ledger.known, stamp, ledger.byId);
  const history = e.error === undefined ? recordRound(replay.history, map, applied, stamp) : replay.history;
  const diffUpdate = replay.diffUpdate.status === "paused" ? { status: "running" as const } : replay.diffUpdate;
  return { ...replay, diffUpdate, map: applied.map, carried: fresh.length ? carried : replay.carried, anchor, history };
});

export const restoreState = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<SessionState & { readonly screens: RestoredScreens }, InvalidLogEvent> {
  const ledger: Ledger = { remarks: [], byId: new Map(), processed: [], known: new Set(), files: new Set(), unsent: [] };
  let replay: Replay = {
    map: undefined, history: { round: 0, changes: [], currentTopic: undefined, lastChanged: undefined },
    received: 0, carried: undefined, anchor: undefined, imagesSkipped: false, diffUpdate: { status: "running" },
  };
  let index = -1;
  for (const event of events) {
    index++;
    const invalid = (reason: string) => new InvalidLogEvent({ index, reason });
    const failed = Effect.mapError((error: { readonly message: string }) => invalid(error.message));
    const type = typeOf(event);
    if (type === StartEvent.fields.type.literal) {
      const e = yield* decodeStart(event).pipe(failed);
      replay = { ...replay, map: emptyMap(e.title) };
    } else if (type === RemarkEvent.fields.type.literal) {
      const e = yield* decodeRemark(event).pipe(failed);
      ledger.remarks.push(e.remark);
      ledger.byId.set(e.remark.id, e.remark);
    } else if (type === ScreenEvent.fields.type.literal) {
      const e = yield* decodeScreen(event).pipe(failed);
      ledger.unsent.push({ start: e.start, image: e.image, seq: replay.received });
      if (e.image !== null) ledger.files.add(e.image);
      replay = { ...replay, received: replay.received + 1 };
    } else if (type === DiffEvent.fields.type.literal) {
      const e = yield* decodeDiff(event).pipe(failed);
      replay = yield* replayDiff(replay, ledger, e, invalid);
    } else if (type === ScreenInputSkippedEvent.fields.type.literal) {
      replay = { ...replay, imagesSkipped: true };
    } else if (type === DiffUpdatePausedEvent.fields.type.literal) {
      const e = yield* decodePaused(event).pipe(failed);
      replay = { ...replay, diffUpdate: { status: "paused", reason: e.reason } };
    } else if (type === DiffUpdateResumedEvent.fields.type.literal) {
      replay = { ...replay, diffUpdate: { status: "running" } };
    }
  }
  const { remarks, processed, known, unsent, files } = ledger;
  const { map, history, received, carried, anchor, diffUpdate } = replay;
  if (!map) return yield* new InvalidLogEvent({ index: 0, reason: "ログに start がありません" });
  const pending = remarks.filter((r) => !r.duplicate && !known.has(r.id) && hasContent(r.text));
  return { map, pending, processed, remarks, known, ...history, diffUpdate, screens: { unsent: unsent.map(({ start, image }) => ({ start, image })), files, received, carried, anchor } };
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
  readonly unsentScreens: readonly HeldScreen[];
  readonly catchUpScreen: HeldScreen | undefined;
  readonly screenFiles: ReadonlySet<string>;
  readonly receivedScreens: number;
  readonly carriedScreen: string | undefined;
  readonly lastImageStart: number | undefined;
};

type StartVerdict = "callInFlight" | "nothingToStart";

type HeldScreen = { readonly start: number; readonly image: { readonly id: string; readonly file: string } | null };
const laterStart = (latest: HeldScreen | undefined, screen: HeldScreen): HeldScreen => latest === undefined || screen.start >= latest.start ? screen : latest;

export const PACED_CALL_REMARKS = 2;
const SCREENS_MAX = 3;

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
    pause: Result.isSuccess(failure) && failure.success instanceof DiffUpdatePaused ? failure.success : undefined,
    stopped: Result.isSuccess(failure) && failure.success._tag === "DiffUpdateStopped",
  };
};

function takeFresh(pending: readonly Remark[], catchUpUntil: string | undefined): { readonly fresh: readonly Remark[]; readonly rest: readonly Remark[]; readonly catchUpUntil: string | undefined } {
  if (catchUpUntil === undefined || !pending.some((r) => r.id === catchUpUntil)) return { fresh: pending, rest: [], catchUpUntil: undefined };
  return { fresh: pending.slice(0, PACED_CALL_REMARKS), rest: pending.slice(PACED_CALL_REMARKS), catchUpUntil };
}

type InitialScreens = { readonly unsent: readonly HeldScreen[]; readonly files: ReadonlySet<string>; readonly received: number; readonly carried: string | undefined; readonly anchor: number | undefined };
const noScreens: InitialScreens = { unsent: [], files: new Set(), received: 0, carried: undefined, anchor: undefined };

export type OnSpeakerNames = (names: readonly InferredSpeakerName[]) => Effect.Effect<void>;

const openSession = Effect.fnUntraced(function* (initial: SessionState, screens: InitialScreens, images: boolean, logShiftMs: number = 0, onSpeakerNames?: OnSpeakerNames, updater?: DiffUpdater["Service"]): Effect.fn.Return<Session, never, Scope.Scope | SessionLog> {
  const scope = yield* Effect.scope;
  const log = yield* SessionLog;
  const notifySpeakerNames = (accepted: readonly InferredSpeakerName[]): Effect.Effect<void> => (onSpeakerNames && accepted.length > 0 ? onSpeakerNames(accepted) : Effect.void);
  const ref = yield* Ref.make<SessionState & Runtime>({ ...initial, previousResponse: undefined, retryEnabled: true, nextRetryAt: undefined, inFlight: undefined, nextCall: 0, reflecting: [], catchUpUntil: undefined, catchUpScreen: undefined, unsentScreens: screens.unsent, screenFiles: screens.files, receivedScreens: screens.received, carriedScreen: screens.carried, lastImageStart: screens.anchor });

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
        const { map, recent, input, selectedScreens, previousResponse, before, keptUnsent } = yield* Ref.modify(ref, (s) => {
          const recent = s.processed.slice(-RECENT);
          const cutoff = Math.max(...fresh.map((u) => u.end));
          const candidates = byStart(s.unsentScreens.filter((h) => h.start <= cutoff || (h.image !== null && h.image.file === s.carriedScreen)));
          const keyed = candidates.map((h) => ({ start: h.start, image: h.image?.file ?? null, held: h }));
          const selected = images ? selectScreens(keyed, s.carriedScreen, s.lastImageStart, cutoff) : [];
          const chosen = s.catchUpScreen !== undefined ? selected : selected.slice(-SCREENS_MAX);
          const selectedScreens = chosen.map((c) => c.held);
          const carriedScreen = images ? carriedOf(keyed, new Set(chosen.flatMap((c) => (c.image === null ? [] : [c.image])))) : undefined;
          const input = {
            recent: recent.map((u) => u.id),
            fresh: fresh.map((u) => u.id),
            nodeCount: s.map.order.length - 1,
            ...(selectedScreens.length ? { screens: selectedScreens.map((h) => ({ start: h.start, image: h.image?.file ?? null })) } : {}),
            ...(s.receivedScreens > 0 ? { screenCount: s.receivedScreens } : {}),
          };
          const keptUnsent = s.unsentScreens.filter((h) => h.start > cutoff || (carriedScreen !== undefined && h.image?.file === carriedScreen));
          const before = { unsentScreens: s.unsentScreens, carriedScreen: s.carriedScreen, lastImageStart: s.lastImageStart };
          const catchUpScreen = s.catchUpScreen !== undefined && keptUnsent.includes(s.catchUpScreen) ? s.catchUpScreen : undefined;
          return [
            { map: s.map, recent, input, selectedScreens, previousResponse: s.previousResponse, before, keptUnsent: keptUnsent.length },
            {
              ...s,
              reflecting: fresh,
              unsentScreens: keptUnsent,
              catchUpScreen,
              carriedScreen,
              lastImageStart: anchorAfter(chosen, s.lastImageStart),
            },
          ];
        });
        const readBack = (h: HeldScreen): Effect.Effect<ScreenChange> => {
          const held = h.image;
          return held ? Effect.map(log.readScreen(held.file), (bytes) => ({ start: h.start, image: { id: held.id, bytes } })) : Effect.succeed({ start: h.start, image: null });
        };
        type CallTimes = { startedAt: string; endedAt: string };
        const classifyUnlessInterrupt = (cause: Cause.Cause<DiffUpdateFailure>) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(classifyFailure(cause)));
        const outcome = yield* Effect.forEach(selectedScreens, readBack).pipe(
          Effect.flatMap((screens) =>
            Effect.suspend(() => {
              const startedAt = logTimestamp(logShiftMs);
              return Effect.exit(restore(updater.update({ map, recent: [...recent], fresh: [...fresh], ...(screens.length ? { screens } : {}), ...(previousResponse ? { previousResponse } : {}) }))).pipe(
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
            yield* Ref.update(ref, (s) => {
              const unsentScreens = [...before.unsentScreens, ...s.unsentScreens.slice(keptUnsent)];
              return { ...s, ...before, unsentScreens, catchUpScreen: unsentScreens.reduce<HeldScreen | undefined>(laterStart, undefined), reflecting: [], pending: [...fresh, ...s.pending], catchUpUntil: [...fresh, ...s.pending].at(-1)?.id, diffUpdate: { status: "paused" as const, reason }, nextRetryAt, previousResponse: undefined };
            });
            yield* log.write({ type: "diff-update-paused", reason });
            return;
          }
          yield* Ref.update(ref, (s) => ({ ...s, diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, nextRetryAt: undefined, reflecting: [], known: new Set([...s.known, ...fresh.map((r) => r.id)]), processed: [...s.processed, ...fresh], previousResponse: undefined }));
          yield* log.write({ type: "diff", input, ops: [], dropped: [], error: outcome.error, ...presentFields(outcome, ["judge", "call"]) });
          return;
        }
        const { dropped, ops, accepted } = yield* Ref.modify(ref, (s) => {
          const consumed = fresh.slice(0, outcome.count);
          const known = new Set([...s.known, ...consumed.map((r) => r.id)]);
          const stamp = stampOf(s, consumed);
          const byId = new Map(s.remarks.map((r) => [r.id, r]));
          const ops = attributePeople(outcome.ops, byId);
          const applied = applyOps(s.map, ops, known, stamp, byId);
          const accepted = acceptInferredNames(outcome.names, known, byId);
          return [{ dropped: applied.dropped, ops, accepted }, {
            ...s, ...recordRound(s, s.map, applied, stamp), diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, nextRetryAt: undefined, map: applied.map, reflecting: [], previousResponse: previousResponseOf(applied),
            known, processed: [...s.processed, ...consumed], pending: [...fresh.slice(outcome.count), ...s.pending],
          }];
        });
        yield* log.write({ type: "diff", input, ops, dropped, ...presentFields(outcome, ["processedRemarks", "usage", "judge", "call"]) });
        if (state.status === "paused") yield* log.write({ type: "diff-update-resumed" });
        yield* notifySpeakerNames(accepted);
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
        const held: HeldScreen = { start: change.start, image: change.image && file ? { id: change.image.id, file } : null };
        yield* Ref.update(ref, (s) => ({ ...s, receivedScreens: s.receivedScreens + 1, unsentScreens: [...s.unsentScreens, held], catchUpScreen: s.diffUpdate.status === "paused" ? laterStart(s.catchUpScreen, held) : s.catchUpScreen }));
        yield* log.write({ type: "screen", start: change.start, image: file, ...(change.ocrFailed === true ? { ocrFailed: true } : lines === undefined ? {} : { lines }) });
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
    exportJson: Effect.map(Ref.get(ref), (s) => toJsonExport(snapshotOf(s), [...s.remarks])),
  } satisfies Session;
});

type NewSessionOptions = { readonly title: string; readonly images?: boolean; readonly logShiftMs?: number; readonly onSpeakerNames?: OnSpeakerNames };

const createSession = Effect.fnUntraced(function* ({ title, images = true, logShiftMs = 0, onSpeakerNames }: NewSessionOptions, updater: DiffUpdater["Service"] | undefined): Effect.fn.Return<Session, never, Scope.Scope | SessionLog> {
  const log = yield* SessionLog;
  yield* log.write({ type: "start", title });
  if (!images) yield* log.write({
    type: ScreenInputSkippedEvent.fields.type.literal,
    reason: ScreenInputSkippedEvent.fields.reason.literal,
  });
  return yield* openSession({
    map: emptyMap(title),
    pending: [],
    processed: [],
    remarks: [],
    known: new Set(),
    round: 0,
    changes: [],
    currentTopic: undefined,
    lastChanged: undefined,
    diffUpdate: { status: "running" },
  }, noScreens, images, logShiftMs, onSpeakerNames, updater);
});

export const makeSession = Effect.fnUntraced(function* (options: NewSessionOptions) {
  return yield* createSession(options, yield* DiffUpdater);
});

export const makeTranscriptSession = (options: NewSessionOptions) => createSession(options, undefined);

export const restoreSession = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<Session, InvalidLogEvent, Scope.Scope | DiffUpdater | SessionLog> {
  const { screens, ...state } = yield* restoreState(events);
  const hold = (ref: ScreenRefs): HeldScreen => ({ start: ref.start, image: ref.image === null ? null : { id: ref.image, file: ref.image } });
  return yield* openSession(state, { unsent: screens.unsent.map(hold), files: screens.files, received: screens.received, carried: screens.carried, anchor: screens.anchor }, true, 0, undefined, yield* DiffUpdater);
});
