import { Context, DateTime, Effect, FileSystem, Layer, Ref, Scope, Semaphore } from "effect";
import { dirname } from "node:path";
import type { UpdatePlan } from "./updatePlan.ts";
import { MapCapture } from "./capture.ts";
import { COMMON_WORDS_PATH, loadCommonWords } from "./commonWords.ts";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { createSessionDir, openLoggedSession, openLoggedTranscriptSession, writeExportsAndCapture } from "./sessionFiles.ts";
import { DiffUpdater, DiffUpdateReason, type HelperPartial, type IntakeLogEvent, type SelfPauseLogEvent, nameSpeaker, speakerNameMap, speakerNamesFrame, type SpeakerNameChange, type SpeakerNameTable, type SettledRemark, type SpeakerLogEvent, type OnSpeakerNames, wordsForKatakana, type Track } from "./core/index.ts";
import { startPoolSession, updatePoolFromSession } from "./vocabularyPool.ts";
import { AudioMix } from "./audioMix.ts";
import { Readings } from "./readings.ts";
import { makeSessionVocabulary, modelReadings } from "./sessionVocabulary.ts";
import { recordedFeed, type RecordedFeed, type TrackEnds } from "./recordedFeed.ts";
import { directFeed, makeRemarkFlow, type Feed, type Inlet } from "./remarkFlow.ts";
import type { Session } from "./core/index.ts";
import { ReviewBuild } from "./review.ts";
import { SpeakerNameRejected } from "./sessionFailure.ts";
import { errorMessage } from "./truthFile.ts";
import type { SendFrame, ViewerFrame } from "./viewers.ts";

type SinkBase = {
  dir: string;
  partial: (p: HelperPartial) => Effect.Effect<void>;
  final: (r: SettledRemark) => Effect.Effect<void>;
  screen: Inlet["screen"];
  ocrSummary: Effect.Effect<typeof import("./core/recordedProgress.ts").OcrSummary.Type>;
  screenOff: (off: { start: number; reason: "指定" | "許可なし" }) => Effect.Effect<void>;
  drain: Effect.Effect<void>;
  stopRelays: Effect.Effect<void>;
  speaker: (event: SpeakerLogEvent) => Effect.Effect<void>;
  speakersRenumbered: Effect.Effect<void>;
  nameSpeaker: (speaker: { label: string; name: string }) => Effect.Effect<void, SpeakerNameRejected>;
  appendLog: (event: Exclude<IntakeLogEvent, SpeakerLogEvent> | SelfPauseLogEvent) => Effect.Effect<void>;
  flush: Effect.Effect<void>;
  exports: Effect.Effect<string[]>;
};

export type LiveSink = SinkBase & {
  clearSpeaking: Effect.Effect<void>;
};

export type RecordedSink = SinkBase & {
  drainForRestart: Effect.Effect<TrackEnds>;
  finishBacklog: Effect.Effect<void>;
  discardBacklog: Effect.Effect<void>;
};

export type SessionSinksDeps<R = never> = {
  prepareUpdater: (plan: UpdatePlan) => Effect.Effect<{ readonly layer: Layer.Layer<DiffUpdater, UpdaterUnavailable>; readonly notice?: string }, UpdaterUnavailable, R | Scope.Scope>;
};

type SinkMode =
  | { noMap?: false; model: ExecutableModel; updaterLayer: Layer.Layer<DiffUpdater, UpdaterUnavailable> }
  | { noMap: true; model?: never; updaterLayer?: never };

export type OpenSessionSink = SinkMode & {
  dir: string;
  title: string | undefined;
  vocab?: ReadonlyArray<string> | undefined;
  logShiftMs?: number;
  send: SendFrame;
};

export type RecordedOptions = {
  realtime: boolean;
  excluded?: (surfaces: ReadonlyArray<string>) => Effect.Effect<void>;
  selfTrack?: boolean;
  progress: (progress: { position: number; rounds: number }) => Effect.Effect<void>;
  paused: (pause: { reason: DiffUpdatePauseReason; retryAt: number } | undefined) => Effect.Effect<void>;
};

type DiffUpdatePauseReason = typeof DiffUpdateReason["Type"];

const TRACKS: Track[] = ["相手", "自分"];

export const audioFileNames = (attempt: number): string[] => TRACKS.map((track) => (attempt > 1 ? `${track}-${attempt}.m4a` : `${track}.m4a`));

export class SessionSinks extends Context.Service<SessionSinks, {
  prepare: SessionSinksDeps["prepareUpdater"];
  createDir: (sessionsDir: string, at?: DateTime.DateTime) => Effect.Effect<string>;
  open: (args: OpenSessionSink & { noMap?: false }) => Effect.Effect<LiveSink, never, Scope.Scope>;
  openRecorded: (args: OpenSessionSink & { recorded: RecordedOptions }) => Effect.Effect<RecordedSink, never, Scope.Scope>;
}>()("live-mindmap/server/SessionSinks") {
  static readonly layer = <R>({ prepareUpdater }: SessionSinksDeps<R>): Layer.Layer<SessionSinks, never, R | MapCapture | ReviewBuild | AudioMix | Readings | FileSystem.FileSystem> =>
    Layer.effect(SessionSinks)(
      Effect.gen(function* () {
        const preparationServices = yield* Effect.context<R>();
        const exportServices = Context.pick(MapCapture, ReviewBuild, AudioMix, FileSystem.FileSystem)(
          yield* Effect.context<MapCapture | ReviewBuild | AudioMix | FileSystem.FileSystem>(),
        );
        const readings = yield* Readings;
        const commonWords = yield* loadCommonWords(COMMON_WORDS_PATH).pipe(Effect.provideContext(exportServices), Effect.orDie);
        const openSink = Effect.fnUntraced(function* <F extends Feed & { observe?: RecordedFeed["observe"] }>(
          args: OpenSessionSink,
          captions: "途中結果から" | "入れた発言だけ",
          makeFeed: (session: Session, inlet: Inlet) => Effect.Effect<F, never, Scope.Scope>,
          excluded?: RecordedOptions["excluded"],
        ) {
          const { dir, title, vocab, logShiftMs, send } = args;
          // updater を開く。Layer はメモ化されるので、Layer.fresh でセッションごとに別の実体にする（query を使い回さない）。
          const updaterContext = args.noMap === true ? undefined : yield* Layer.build(Layer.fresh(args.updaterLayer)).pipe(Effect.orDie);
          const names = yield* Ref.make<SpeakerNameTable>(new Map());
          const namesLock = yield* Semaphore.make(1);
          const baseUpdater = updaterContext === undefined ? undefined : Context.get(updaterContext, DiffUpdater);
          const namedUpdater = baseUpdater === undefined ? undefined : DiffUpdater.of({
            ...baseUpdater,
            update: (input) => Effect.flatMap(Ref.get(names), (table) =>
              baseUpdater.update(table.size === 0 ? input : { ...input, speakerNames: speakerNameMap(table) })),
          });
          const applyName = (change: SpeakerNameChange): Effect.Effect<void> =>
            namesLock.withPermit(Effect.uninterruptible(Effect.gen(function* () {
              const next = nameSpeaker(yield* Ref.get(names), change);
              if (next === undefined) return;
              yield* appendRecordedLog({ type: "speaker-name", label: change.label, name: next.get(change.label)!.name, source: change.source });
              yield* Ref.set(names, next);
              yield* send(speakerNamesFrame(next));
            })));
          let observe: RecordedFeed["observe"] | undefined;
          const loggedOptions = {
            dir,
            title,
            logShiftMs,
            send: (frame: ViewerFrame) => Effect.gen(function* () {
              yield* send(frame);
              if ("type" in frame && frame.type === "diff-update" && observe !== undefined) yield* observe(frame);
            }),
            onDiff: Effect.suspend((): Effect.Effect<void> => flow.captionsChanged),
            onSpeakerNames: (inferred: Parameters<OnSpeakerNames>[0]) => Effect.forEach(inferred, ({ label, name, basis }) => applyName({ label, name, source: "推定", basis }), { discard: true }),
          };
          const { session, appendLog: appendRecordedLog } = yield* (args.noMap === true
            ? openLoggedTranscriptSession(loggedOptions)
            : openLoggedSession({ ...loggedOptions, model: args.model }).pipe(Effect.provideService(DiffUpdater, namedUpdater!))).pipe(Effect.provideContext(exportServices));
          const started = yield* startPoolSession(dirname(dir)).pipe(Effect.provideContext(exportServices));
          if (started !== undefined) yield* appendRecordedLog({ type: "vocab-pool", session: started.session });
          const vocabulary = yield* makeSessionVocabulary({
            read: modelReadings(baseUpdater?.katakana, readings),
            commonWords,
            log: appendRecordedLog,
            carried: started?.words ?? [],
            ...(args.noMap === true && excluded !== undefined ? { excluded: (surfaces: ReadonlyArray<string>) => {
              const words = wordsForKatakana(surfaces);
              return words.length === 0 ? Effect.void : excluded(words);
            } } : {}),
          });
          yield* vocabulary.addUser(vocab ?? []).pipe(Effect.asVoid);
          const flow = yield* makeRemarkFlow({
            session, correct: vocabulary.correct, speak: send,
            captions,
            feed: (inlet) => Effect.gen(function* () {
              const feed = yield* makeFeed(session, inlet);
              observe = feed.observe;
              return feed;
            }),
          });
          const sink: SinkBase = {
            dir,
            partial: flow.partial,
            final: flow.final,
            speaker: (event) => Effect.andThen(appendRecordedLog(event), flow.speaker(event)),
            speakersRenumbered: flow.renumbered,
            nameSpeaker: ({ label, name }) =>
              Effect.gen(function* () {
                if (!flow.labels().includes(label)) return yield* new SpeakerNameRejected({ reason: "ラベルがない" });
                if (name.trim() === "") return yield* new SpeakerNameRejected({ reason: "名前が空" });
                yield* applyName({ label, name, source: "手入力" });
              }),
            screen: (change) => captions === "途中結果から"
              ? Effect.andThen(flow.screen(change), vocabulary.addScreen(change.lines)).pipe(Effect.asVoid)
              : Effect.andThen(vocabulary.addScreen(change.lines, change.start), flow.screen(change)),
            ocrSummary: flow.ocrSummary,
            screenOff: flow.screenOff,
            drain: flow.drain,
            stopRelays: flow.stop,
            appendLog: appendRecordedLog,
            flush: session.flush,
            exports: Effect.andThen(
              Effect.andThen(vocabulary.settled, updatePoolFromSession(dir, dirname(dir))),
              args.noMap === true ? Effect.succeed<string[]>([]) : Effect.flatMap(Effect.all([session.snapshot, Ref.get(names)]), ([snapshot, table]) => writeExportsAndCapture(dir, snapshot, errorMessage, speakerNameMap(table))),
            ).pipe(
              Effect.provideContext(exportServices),
              Effect.orDie,
            ),
          };
          return { sink, flow };
        });
        return SessionSinks.of({
          prepare: (plan) => Effect.gen(function* () {
            const scope = yield* Effect.scope;
            return yield* prepareUpdater(plan).pipe(Effect.provideContext(Context.add(preparationServices, Scope.Scope, scope)));
          }),
          createDir: (sessionsDir, at) => createSessionDir(sessionsDir, at).pipe(Effect.provideContext(exportServices), Effect.orDie),
          open: Effect.fnUntraced(function* (args) {
            const { sink, flow } = yield* openSink(args, "途中結果から", (_session, inlet) => directFeed(inlet));
            return { ...sink, clearSpeaking: flow.clearSpeaking };
          }),
          openRecorded: Effect.fnUntraced(function* ({ recorded, ...args }) {
            const { sink, flow } = yield* openSink(args, "入れた発言だけ", (session, inlet) => recordedFeed({
              realtime: recorded.realtime,
              noMap: args.noMap === true,
              selfTrack: recorded.selfTrack === true,
              session: {
                diffUpdate: session.diffUpdate,
                nextRetryAt: session.nextRetryAt,
                unreflectedCount: Effect.map(session.unreflectedRemarks, (remarks) => remarks.length),
                idle: session.idle,
                round: Effect.map(session.snapshot, (snapshot) => snapshot.round),
              },
              progress: recorded.progress,
              paused: recorded.paused,
            })(inlet), recorded.excluded);
            return {
              ...sink,
              drainForRestart: Effect.andThen(flow.drainForRestart, flow.feed.prepareRestart),
              finishBacklog: flow.feed.finish,
              discardBacklog: flow.feed.discard,
            };
          }),
        });
      }),
    );
}
