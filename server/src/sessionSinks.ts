import { Context, DateTime, Effect, FileSystem, Layer, type Scope } from "effect";
import { dirname } from "node:path";
import { MapCapture } from "./capture.ts";
import { COMMON_WORDS_PATH, loadCommonWords } from "./commonWords.ts";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { createSessionDir, openLoggedSession, openLoggedTranscriptSession, writeExportsAndCapture } from "./sessionFiles.ts";
import { DiffUpdater, DiffUpdateReason, type HelperPartial, type IntakeLogEvent, type SelfPauseLogEvent, type SettledRemark, type SpeakerLogEvent, wordsForKatakana, type Track } from "./core/index.ts";
import { startPoolSession, updatePoolFromSession } from "./vocabularyPool.ts";
import { AudioMix } from "./audioMix.ts";
import { Readings } from "./readings.ts";
import { makeSessionVocabulary, modelReadings } from "./sessionVocabulary.ts";
import { recordedFeed, type RecordedFeed, type TrackEnds } from "./recordedFeed.ts";
import { directFeed, makeRemarkFlow, type Ending, type Feed, type Inlet } from "./remarkFlow.ts";
import type { Session } from "./core/index.ts";
import { ReviewBuild } from "./review.ts";
import { SpeakerNameRejected } from "./sessionFailure.ts";
import { errorMessage } from "./truthFile.ts";
import type { SendFrame, ViewerFrame } from "./viewers.ts";

type Written = {
  paths: string[];
  ocrSummary: typeof import("./core/recordedProgress.ts").OcrSummary.Type;
};

type SinkBase = {
  dir: string;
  partial: (p: HelperPartial) => Effect.Effect<void>;
  final: (r: SettledRemark) => Effect.Effect<void>;
  screen: Inlet["screen"];
  screenOff: (off: { start: number; reason: "指定" | "許可なし" }) => Effect.Effect<void>;
  end: (ending: Ending) => Effect.Effect<{ writeOut: Effect.Effect<Written> }>;
  stopRelays: Effect.Effect<void>;
  speaker: (event: SpeakerLogEvent) => Effect.Effect<void>;
  speakersRenumbered: Effect.Effect<void>;
  nameSpeaker: (speaker: { label: string; name: string }) => Effect.Effect<void, SpeakerNameRejected>;
  appendLog: (event: Exclude<IntakeLogEvent, SpeakerLogEvent> | SelfPauseLogEvent) => Effect.Effect<void>;
};

export type LiveSink = SinkBase & {
  interrupted: Effect.Effect<void>;
};

export type RecordedSink = SinkBase & {
  drainForRestart: Effect.Effect<TrackEnds>;
};

type SinkMode =
  | { noMap?: false; model: ExecutableModel; updaterLayer: Layer.Layer<DiffUpdater, UpdaterUnavailable> }
  | { noMap: true; model?: never; updaterLayer?: never };

export type OpenSessionSink = SinkMode & {
  dir: string;
  title: string | undefined;
  vocab?: ReadonlyArray<string> | undefined;
  criteria?: readonly string[];
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
  createDir: (sessionsDir: string, at?: DateTime.DateTime) => Effect.Effect<string>;
  open: (args: OpenSessionSink & { noMap?: false }) => Effect.Effect<LiveSink, never, Scope.Scope>;
  openRecorded: (args: OpenSessionSink & { recorded: RecordedOptions }) => Effect.Effect<RecordedSink, never, Scope.Scope>;
}>()("live-mindmap/server/SessionSinks") {
  static readonly layer: Layer.Layer<SessionSinks, never, MapCapture | ReviewBuild | AudioMix | Readings | FileSystem.FileSystem> =
    Layer.effect(SessionSinks)(
      Effect.gen(function* () {
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
          const { dir, title, vocab, criteria, logShiftMs, send } = args;
          // updater を開く。Layer はメモ化されるので、Layer.fresh でセッションごとに別の実体にする（query を使い回さない）。
          const updaterContext = args.noMap === true ? undefined : yield* Layer.build(Layer.fresh(args.updaterLayer)).pipe(Effect.orDie);
          const baseUpdater = updaterContext === undefined ? undefined : Context.get(updaterContext, DiffUpdater);
          let observe: RecordedFeed["observe"] | undefined;
          const loggedOptions = {
            dir,
            title,
            criteria,
            logShiftMs,
            send: (frame: ViewerFrame) => Effect.gen(function* () {
              yield* send(frame);
              if ("type" in frame && frame.type === "diff-update" && observe !== undefined) yield* observe(frame);
            }),
            onDiff: Effect.suspend((): Effect.Effect<void> => flow.captionsChanged),
          };
          const { session, appendLog: appendRecordedLog } = yield* (args.noMap === true
            ? openLoggedTranscriptSession(loggedOptions)
            : openLoggedSession({ ...loggedOptions, model: args.model }).pipe(Effect.provideService(DiffUpdater, baseUpdater!))).pipe(Effect.provideContext(exportServices));
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
                yield* session.nameSpeaker({ label, name, source: "手入力" });
              }),
            screen: (change) => captions === "途中結果から"
              ? Effect.andThen(flow.screen(change), vocabulary.addScreen(change.lines)).pipe(Effect.asVoid)
              : Effect.andThen(vocabulary.addScreen(change.lines, change.start), flow.screen(change)),
            screenOff: flow.screenOff,
            stopRelays: flow.stop,
            appendLog: appendRecordedLog,
            end: Effect.fnUntraced(function* (ending) {
              yield* flow.settle(ending);
              return { writeOut: Effect.gen(function* () {
                yield* session.flush;
                yield* vocabulary.settled;
                yield* updatePoolFromSession(dir, dirname(dir));
                const paths = args.noMap === true ? [] : yield* Effect.flatMap(
                  Effect.all([session.snapshot, session.exportJson]),
                  ([snapshot, json]) => writeExportsAndCapture(dir, snapshot, errorMessage, new Map(Object.entries(json.speakerNames ?? {}))),
                );
                return { paths, ocrSummary: yield* flow.ocrSummary };
              }).pipe(Effect.provideContext(exportServices), Effect.orDie) };
            }),
          };
          return { sink, flow };
        });
        return SessionSinks.of({
          createDir: (sessionsDir, at) => createSessionDir(sessionsDir, at).pipe(Effect.provideContext(exportServices), Effect.orDie),
          open: Effect.fnUntraced(function* (args) {
            const { sink, flow } = yield* openSink(args, "途中結果から", (_session, inlet) => directFeed(inlet));
            return { ...sink, interrupted: Effect.andThen(flow.drainForRestart, flow.clearSpeaking) };
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
            };
          }),
        });
      }),
    );
}
