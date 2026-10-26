import { Cause, Clock, Console, Context, DateTime, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Result, Scope, Stream } from "effect";
import { parse } from "node:path";
import {
  type RecordedEvent,
  type RecordedProgress,
  isScreenBrowser,
  makeMeetingTabNotice,
  SCREEN_NOTICE_MS,
  SCREEN_NOTICE_TEXT,
  INITIAL_SELF_PAUSE_STATE,
  TAP_NOTICE_TEXT,
  type HelperEvent,
  type IntakeStatusReport,
  type SelfPauseFrame,
  type SelfPauseState,
  type Track,
} from "./core/index.ts";
import { openIntake } from "./intakeAttempts.ts";
import { withoutFinalNewline } from "./consoleText.ts";
import { Helpers, HELPER_STOP_TIMEOUT_MS } from "./helpers.ts";
import {
  Aborted,
  IntakeNotStopped,
  NoSession,
  NotForRecordedSession,
  RestartGaveUp,
  SessionBusy,
  SessionTransition,
  type SessionFailure,
  type SpeakerNameRejected,
} from "./sessionFailure.ts";
import { planModel } from "./updatePlan.ts";
import { audioFileNames, SessionSinks, type LiveSink, type RecordedSink } from "./sessionSinks.ts";
import { Viewers, type SendFrame } from "./viewers.ts";
import { ManagedDeps } from "./managedDeps.ts";
import { checkManagedDeps, requireRecordedTranscriptDeps, requireStartupDeps, startupPreparationFailure } from "./managedDepsCheck.ts";
import type { CheckReport } from "./managedDepsProtocol.ts";

export type SessionStart = { app: string; title: string | undefined; audio: boolean; screen: boolean; vocab: ReadonlyArray<string>; plan: import("./updatePlan.ts").UpdatePlan };

export type RecordedStart = { file: string; selfFile?: string; title: string | undefined; vocab: ReadonlyArray<string>; realtime: boolean } & ({ noMap: true; plan?: never } | { noMap?: false; plan: import("./updatePlan.ts").UpdatePlan });

export class SessionsDir extends Context.Service<SessionsDir, string>()("live-mindmap/server/SessionsDir") {}

type IntakeKind = "running" | "interrupted" | "stopped";

type Intake = Effect.Success<ReturnType<typeof openIntake>>;
type IntakeRun = Effect.Success<ReturnType<Intake["run"]>>;

type Live = {
  model: import("./modelSelection.ts").ExecutableModel;
  app: string;
  dir: string;
  audio: boolean;
  screen: boolean;
  noticeShown: Ref.Ref<boolean>;
  meetingTabNotice: Effect.Success<ReturnType<typeof makeMeetingTabNotice>>;
  sink: LiveSink;
  send: SendFrame;
  controller: Intake;
  running: Ref.Ref<IntakeRun | undefined>;
  scope: Scope.Closeable;
  intake: Ref.Ref<IntakeKind>;
  origin: Ref.Ref<string | undefined>;
  lastInterruptedAt: Ref.Ref<string | undefined>;
  selfPauseFrame: Ref.Ref<SelfPauseFrame>;
  selfPauseState: Ref.Ref<SelfPauseState>;
};

type RecordedProgressState = { position: number; duration: number | null; rounds: number; paused?: RecordedPause };
type RecordedPause = NonNullable<RecordedProgress["paused"]>;

type Recorded = {
  local: boolean;
  dir: string;
  file: string;
  selfFile: string | undefined;
  sink: RecordedSink;
  controller: Intake;
  running: Ref.Ref<IntakeRun | undefined>;
  scope: Scope.Closeable;
  events: Queue.Queue<RecordedEvent, Cause.Done>;
  progress: Ref.Ref<RecordedProgressState>;
  from: Ref.Ref<Partial<Readonly<Record<Track, number>>>>;
  announced: Ref.Ref<Announced>;
};

type Announced = { audioTracks: boolean; screenOff: boolean; speakerOff: boolean };

type State =
  | { kind: "idle"; installations: number }
  | { kind: "starting" }
  | { kind: "live"; live: Live }
  | { kind: "recorded"; recorded: Recorded }
  | { kind: "stopping" };

export type RecordedRun = { dir: string; warnings: ReadonlyArray<string>; events: Stream.Stream<RecordedEvent> };

export class Sessions extends Context.Service<Sessions, {
  apps: Effect.Effect<unknown>;
  start: (input: SessionStart) => Effect.Effect<{ dir: string; warnings: ReadonlyArray<string> }, SessionFailure>;
  startRecorded: (input: RecordedStart) => Effect.Effect<RecordedRun, SessionFailure>;
  stop: Effect.Effect<{ paths: string[]; ocrSummary: typeof import("./core/recordedProgress.ts").OcrSummary.Type; kind: "live" | "recorded" }, SessionFailure>;
  status: Effect.Effect<IntakeStatusReport>;
  resume: Effect.Effect<{ warnings: ReadonlyArray<string> }, SessionFailure>;
  checkResume: Effect.Effect<typeof CheckReport.Type, SessionFailure>;
  reserveDeps: Effect.Effect<void, SessionFailure, Scope.Scope>;
  liveSession: Effect.Effect<{ readonly scope: Scope.Scope; readonly local: boolean }, SessionFailure>;
  setSelfPause: (paused: boolean) => Effect.Effect<void, SessionFailure>;
  setSpeakerName: (speaker: { label: string; name: string }) => Effect.Effect<void, SessionFailure | SpeakerNameRejected>;
}>()("live-mindmap/server/Sessions") {
  static readonly layer: Layer.Layer<Sessions, never, Helpers | SessionSinks | SessionsDir | Viewers | ManagedDeps> = Layer.effect(Sessions)(
    Effect.gen(function* () {
      const helpers = yield* Helpers;
      const sinks = yield* SessionSinks;
      const viewers = yield* Viewers;
      const sessionsDir = yield* SessionsDir;
      const deps = yield* ManagedDeps;
      const serverScope = yield* Effect.scope;
      const stopTimeoutMs = yield* HELPER_STOP_TIMEOUT_MS;
      const state = yield* Ref.make<State>({ kind: "idle", installations: 0 });
      type Active = Extract<State, { kind: "live" | "recorded" }>;
      function current(need: "live", claim?: "stopping"): Effect.Effect<Live, NoSession | SessionTransition | NotForRecordedSession>;
      function current(need: "any", claim?: "stopping"): Effect.Effect<Active, NoSession | SessionTransition>;
      function current(need: "live" | "any", claim?: "stopping"): Effect.Effect<Live | Active, NoSession | SessionTransition | NotForRecordedSession> {
        return Effect.gen(function* () {
          const claimed = yield* Ref.modify(state, (value): [Result.Result<Active, NoSession | SessionTransition | NotForRecordedSession>, State] => {
            switch (value.kind) {
              case "idle":
                return [Result.fail(new NoSession()), value];
              case "starting":
              case "stopping":
                return [Result.fail(new SessionTransition()), value];
              case "recorded":
                if (need === "live") return [Result.fail(new NotForRecordedSession()), value];
                break;
              case "live":
                break;
            }
            return [Result.succeed(value), claim === "stopping" ? { kind: "stopping" } : value];
          });
          if (Result.isFailure(claimed)) return yield* claimed.failure;
          const target = claimed.success;
          return need === "live" && target.kind === "live" ? target.live : target;
        });
      }

      const reserveDeps = Effect.acquireRelease(
        Effect.gen(function* () {
          const refusal = yield* Ref.modify(state, (current): [Option.Option<SessionFailure>, State] =>
            current.kind === "idle"
              ? [Option.none(), { kind: "idle", installations: current.installations + 1 }]
              : [Option.some(current.kind === "live" || current.kind === "recorded" ? new SessionBusy() : new SessionTransition()), current]);
          if (Option.isSome(refusal)) return yield* refusal.value;
        }),
        () => Ref.update(state, (current): State => current.kind === "idle" ? { kind: "idle", installations: current.installations - 1 } : current),
      );

      const note = (text: string) => Console.error(withoutFinalNewline(text));

      const runArgs = (live: Pick<Live, "app" | "dir" | "audio" | "screen">, attempt: number, origin: string | undefined, selfPause: SelfPauseState): string[] => [
        "run",
        "--app",
        live.app,
        ...(live.audio ? ["--audio-dir", live.dir, "--audio-index", String(attempt)] : []),
        ...(live.screen ? [] : ["--no-screen"]),
        ...(origin !== undefined ? ["--origin", origin] : []),
        ...(selfPause.manual !== INITIAL_SELF_PAUSE_STATE.manual ? ["--self-manual", selfPause.manual] : []),
        ...(selfPause.basis !== INITIAL_SELF_PAUSE_STATE.basis ? ["--self-basis", selfPause.basis] : []),
        ...(selfPause.lastKnown !== INITIAL_SELF_PAUSE_STATE.lastKnown ? ["--self-last-known", selfPause.lastKnown] : []),
        ...(selfPause.idleFor !== INITIAL_SELF_PAUSE_STATE.idleFor ? ["--self-idle-for", String(selfPause.idleFor)] : []),
      ];

      const applyEvent = (live: Live, event: HelperEvent): Effect.Effect<void> => {
        switch (event.type) {
          case "origin":
            return Effect.andThen(
              Ref.update(live.origin, (origin) => origin ?? event.hostTime),
              live.send({ type: "tap-notice", text: null }),
            );
          case "remark": {
            const { type: _type, ...settled } = event;
            return live.sink.final(settled);
          }
          case "partial": {
            const { type: _type, ...partial } = event;
            return live.sink.partial(partial);
          }
          case "screen":
            return Effect.andThen(
              live.meetingTabNotice.screen({ start: event.start, hasImage: event.image !== null, meetingTabTitle: event.meetingTabTitle }),
              live.sink.screen({ start: event.start, image: event.image, lines: event.lines, ...(event.ocrFailed === true ? { ocrFailed: event.ocrFailed } : {}) }),
            );
          case "screen-off":
            return Effect.andThen(live.meetingTabNotice.reset,
              Effect.andThen(live.sink.screenOff({ start: event.start, reason: event.reason }), showScreenNotice(live)));
          case "tap-silent":
            return Effect.andThen(
              live.sink.appendLog({ type: "tap-silent", start: event.start }),
              live.send({ type: "tap-notice", text: TAP_NOTICE_TEXT }),
            );
          case "self-pause": {
            const frame: SelfPauseFrame = event.paused ? { type: "self-pause", paused: true, reason: event.reason } : { type: "self-pause", paused: false };
            return Effect.flatMap(
              Ref.modify(live.selfPauseFrame, (current): ["transition" | "reason" | "same", SelfPauseFrame] => [
                current.paused !== frame.paused ? "transition" : current.paused && frame.paused && current.reason !== frame.reason ? "reason" : "same",
                frame,
              ]),
              (change) =>
                change === "transition"
                  ? Effect.andThen(
                      live.sink.appendLog({ type: event.paused ? "self-paused" : "self-resumed", reason: event.reason, start: event.start }),
                      live.send(frame),
                    )
                  : change === "reason" ? live.send(frame) : Effect.void,
            );
          }
          case "self-pause-state": {
            const { type: _type, ...state } = event;
            return Ref.set(live.selfPauseState, state);
          }
          case "file-duration":
          case "file-audio-tracks":
            return Effect.void;
          case "speaker":
          case "speaker-off":
          case "speaker-settled":
          case "speaker-mixed":
          case "speaker-centroid":
            return live.sink.speaker(event);
        }
      };

      const showScreenNotice = Effect.fnUntraced(function* (live: Live) {
        const first = yield* Ref.modify(live.noticeShown, (shown): [boolean, boolean] => [!shown, true]);
        if (!first) return;
        yield* live.send({ type: "screen-notice", text: SCREEN_NOTICE_TEXT });
        yield* Effect.forkIn(
          Effect.andThen(Effect.sleep(SCREEN_NOTICE_MS), live.send({ type: "screen-notice", text: null })),
          live.scope,
        );
      });

      const runLive = (live: Live, trigger: "auto" | "resume") => live.controller.run({
        trigger, exitZero: "restart", log: live.sink.appendLog,
        apply: (event) => applyEvent(live, event),
        observe: (transition) => Effect.gen(function* () {
          switch (transition.kind) {
            case "connected":
              if ((yield* live.controller.stats).attempt > 1) yield* live.sink.speakersRenumbered;
              break;
            case "crashed":
              yield* live.meetingTabNotice.reset;
              yield* live.sink.drain;
              yield* live.sink.clearSpeaking;
              yield* Ref.set(live.lastInterruptedAt, DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)));
              break;
            case "running":
            case "interrupted":
            case "stopped":
              yield* Ref.set(live.intake, transition.kind);
              yield* live.send({ type: "intake", status: transition.kind });
          }
        }),
      });

      const claimStart = Effect.gen(function* () {
        const refusal = yield* Ref.modify(state, (current): [Option.Option<SessionFailure>, State] =>
          current.kind === "idle" && current.installations === 0
            ? [Option.none(), { kind: "starting" }]
            : [Option.some(current.kind === "live" || current.kind === "recorded" ? new SessionBusy() : new SessionTransition()), current],
        );
        if (Option.isSome(refusal)) return yield* refusal.value;
      });

      const openSession = <A>(body: (scope: Scope.Closeable, send: SendFrame) => Effect.Effect<{
        active: Active;
        local: boolean;
        result: A;
        afterPublish?: Effect.Effect<void>;
      }, SessionFailure>): Effect.Effect<A, SessionFailure> => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        yield* claimStart;
        return yield* Effect.gen(function* () {
          const scope = yield* Scope.fork(serverScope, "sequential");
          const send = yield* viewers.forSession.pipe(Scope.provide(scope));
          return yield* restore(Effect.gen(function* () {
            const opened = yield* body(scope, send);
            yield* Ref.set(state, opened.active);
            if (opened.afterPublish !== undefined) yield* opened.afterPublish;
            yield* send({ type: "session-mode", local: opened.local });
            return opened.result;
          })).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        }).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? Ref.set(state, { kind: "idle", installations: 0 }) : Effect.void));
      }));

      const prepareMap = Effect.fnUntraced(function* (
        plan: SessionStart["plan"],
        options: { mode: "start"; screen: boolean } | { mode: "recorded" },
        scope: Scope.Closeable,
      ) {
        const model = planModel(plan);
        const checkArgs: Parameters<typeof requireStartupDeps> = options.mode === "start"
          ? ["start", model.route, { screen: options.screen, check: helpers.check({ screen: options.screen }) }]
          : ["recorded", model.route, { check: helpers.check({ screen: false }) }];
        const startupWarnings = yield* requireStartupDeps(...checkArgs).pipe(Effect.provideService(ManagedDeps, deps));
        const { layer: updaterLayer, notice } = yield* sinks.prepare(plan).pipe(Scope.provide(scope), Effect.mapError(startupPreparationFailure));
        return { model, updaterLayer, warnings: notice === undefined ? startupWarnings : [...startupWarnings, notice] };
      });

      const start = (input: SessionStart) => openSession((scope, send) => Effect.gen(function* () {
        const { model, updaterLayer, warnings } = yield* prepareMap(input.plan, { mode: "start", screen: input.screen }, scope);
        const dir = yield* sinks.createDir(sessionsDir);
        const origin = yield* Ref.make<string | undefined>(undefined);
        const selfPauseState = yield* Ref.make<SelfPauseState>(INITIAL_SELF_PAUSE_STATE);
        const controller = yield* openIntake({
          scope, commands: { "self-pause": "pending-once" },
          argv: (attemptNo) => Effect.gen(function* () {
            return runArgs({ app: input.app, dir, audio: input.audio, screen: input.screen }, attemptNo, yield* Ref.get(origin), yield* Ref.get(selfPauseState));
          }),
        }).pipe(Effect.provideService(Helpers, helpers));
        const sink = yield* sinks.open({ dir, title: input.title, vocab: input.vocab, model, updaterLayer, send }).pipe(Scope.provide(scope));
        if (!input.screen) yield* sink.screenOff({ start: 0, reason: "指定" });
        const live: Live = {
          model,
          app: input.app,
          dir,
          audio: input.audio,
          screen: input.screen,
          noticeShown: yield* Ref.make(false),
          meetingTabNotice: yield* makeMeetingTabNotice({ enabled: input.screen && isScreenBrowser(input.app), notify: note }).pipe(Scope.provide(scope)),
          sink,
          send,
          scope,
          controller,
          running: yield* Ref.make<IntakeRun | undefined>(undefined),
          intake: yield* Ref.make<IntakeKind>("running"),
          origin,
          lastInterruptedAt: yield* Ref.make<string | undefined>(undefined),
          selfPauseFrame: yield* Ref.make<SelfPauseFrame>({ type: "self-pause", paused: false }),
          selfPauseState,
        };
        yield* Ref.set(live.running, yield* runLive(live, "auto"));
        return { active: { kind: "live", live } satisfies Active, local: model.local, result: { dir, warnings } };
      }));

      const closeSession = (sink: Pick<LiveSink, "stopRelays">, scope: Scope.Closeable) =>
        Effect.gen(function* () {
          yield* sink.stopRelays;
          yield* Scope.close(scope, Exit.void);
        }).pipe(Effect.ensuring(Ref.set(state, { kind: "idle", installations: 0 })));

      const publishProgress = ({ progress, events }: Pick<Recorded, "progress" | "events">) =>
        Effect.flatMap(Ref.get(progress), (current) => Queue.offer(events, { type: "progress", ...current }));

      const announceOnce = (recorded: Recorded, key: "audioTracks" | "screenOff" | "speakerOff") =>
        Ref.modify(recorded.announced, (announced): [boolean, Announced] => [!announced[key], { ...announced, [key]: true }]);

      const applyRecordedEvent = (recorded: Recorded, event: HelperEvent): Effect.Effect<void> => {
        switch (event.type) {
          case "remark": {
            const { type: _type, ...settled } = event;
            return recorded.sink.final(settled);
          }
          case "partial": {
            const { type: _type, ...partial } = event;
            return recorded.sink.partial(partial);
          }
          case "file-duration":
            return Effect.andThen(Ref.update(recorded.progress, (p) => ({ ...p, duration: event.duration })), publishProgress(recorded));
          case "file-audio-tracks":
            return event.count > 1
              ? Effect.flatMap(announceOnce(recorded, "audioTracks"), (first) => first ? Queue.offer(recorded.events, { type: "audio-tracks", count: event.count }) : Effect.void)
              : Effect.void;
          case "screen":
            return recorded.sink.screen({ start: event.start, image: event.image, lines: event.lines, ...(event.ocrFailed === true ? { ocrFailed: event.ocrFailed } : {}) });
          case "screen-off":
            return Effect.flatMap(announceOnce(recorded, "screenOff"), (first) =>
              Effect.andThen(recorded.sink.screenOff({ start: event.start, reason: event.reason }), first ? Queue.offer(recorded.events, { type: "screen-off" }) : Effect.void));
          case "speaker":
          case "speaker-settled":
          case "speaker-mixed":
          case "speaker-centroid":
            return recorded.sink.speaker(event);
          case "speaker-off":
            return Effect.flatMap(announceOnce(recorded, "speakerOff"), (first) =>
              Effect.andThen(recorded.sink.speaker(event), first ? Queue.offer(recorded.events, { type: "speaker-off", reason: event.reason }) : Effect.void));
          case "origin":
          case "tap-silent":
          case "self-pause":
          case "self-pause-state":
            return Effect.void;
        }
      };

      const applyRecordedEventFrom = (recorded: Recorded, event: HelperEvent): Effect.Effect<void> =>
        event.type === "remark" || event.type === "partial"
          ? Effect.flatMap(Ref.get(recorded.from), (from) => from[event.track] !== undefined && event.start < from[event.track]! ? Effect.void : applyRecordedEvent(recorded, event))
          : applyRecordedEvent(recorded, event);

      const closeRecorded = (recorded: Recorded) => Effect.andThen(Queue.end(recorded.events), closeSession(recorded.sink, recorded.scope));

      const finishRecorded = (recorded: Recorded, failure: { code: number | null; signal: string | null; stderrTail: ReadonlyArray<string> } | undefined) =>
        Effect.gen(function* () {
          yield* recorded.sink.flush;
          const paths = yield* recorded.sink.exports;
          const ocrSummary = yield* recorded.sink.ocrSummary;
          yield* Queue.offer(recorded.events, { type: "finished", paths, ocrSummary, ...(failure === undefined ? {} : { failure }) });
          return { paths, ocrSummary };
        });

      const transcribeArgs = (recorded: Pick<Recorded, "file" | "selfFile">, from: Partial<Readonly<Record<Track, number>>>, audioDir: string | undefined): string[] => [
        "transcribe-file",
        "--file",
        recorded.file,
        ...(recorded.selfFile === undefined ? [] : ["--self-file", recorded.selfFile]),
        ...(from.相手 === undefined ? [] : ["--from", String(from.相手)]),
        ...(recorded.selfFile === undefined || from.自分 === undefined ? [] : ["--self-from", String(from.自分)]),
        ...(audioDir === undefined ? [] : ["--audio-dir", audioDir]),
      ];

      const concludeRecorded = Effect.fnUntraced(function* (recorded: Recorded, prepare: Effect.Effect<void>, failure: { code: number | null; signal: string | null; stderrTail: ReadonlyArray<string> } | undefined) {
        const prepared = yield* Effect.exit(prepare);
        const claimed = yield* Ref.modify(state, (current): [boolean, State] =>
          current.kind === "recorded" && current.recorded === recorded ? [true, { kind: "stopping" }] : [false, current]);
        if (!claimed) return;
        const finishing = Exit.isFailure(prepared)
          ? Effect.andThen(note(`録画の取り込みの終了処理に失敗した: ${Cause.pretty(prepared.cause)}\n`), Effect.failCause(prepared.cause))
          : finishRecorded(recorded, failure === undefined ? undefined : { code: failure.code, signal: failure.signal, stderrTail: [...failure.stderrTail] });
        yield* Effect.forkIn(finishing.pipe(Effect.ensuring(closeRecorded(recorded))), serverScope);
      });

      const startRecorded = (input: RecordedStart) => openSession((scope, send) => Effect.gen(function* () {
        const prepared = input.noMap === true
          ? { noMap: true as const, warnings: yield* requireRecordedTranscriptDeps(helpers.check({ screen: false })) }
          : { noMap: false as const, ...yield* prepareMap(input.plan, { mode: "recorded" }, scope) };
        const { warnings } = prepared;
        const now = DateTime.nowUnsafe();
        const created = yield* helpers.creationDate(input.file).pipe(
          Effect.catchTag("HelperCreationDateFailure", (failure) =>
            Effect.as(note(`作成日時を読めないので、今の時刻でセッションを作ります: ${failure.message}\n`), null)),
        );
        const createdAt = created === null ? Option.none() : DateTime.make(created);
        const base = Option.getOrElse(createdAt, () => now);
        const dir = yield* sinks.createDir(sessionsDir, base);
        const from = yield* Ref.make<Partial<Readonly<Record<Track, number>>>>({});
        const controller = yield* openIntake({
          scope, commands: { "reading-pause": "sticky" },
          argv: (attemptNo) => Effect.map(Ref.get(from), (position) => transcribeArgs({ file: input.file, selfFile: input.selfFile }, position, attemptNo === 1 ? dir : undefined)),
        }).pipe(Effect.provideService(Helpers, helpers));
        const events = yield* Queue.unbounded<RecordedEvent, Cause.Done>();
        const progress = yield* Ref.make<RecordedProgressState>({ position: 0, duration: null, rounds: 0 });
        const sink = yield* sinks.openRecorded({
          dir, title: input.title ?? parse(input.file).name, logShiftMs: DateTime.toEpochMillis(base) - DateTime.toEpochMillis(now),
          ...(prepared.noMap ? { noMap: true as const } : { model: prepared.model, updaterLayer: prepared.updaterLayer }), vocab: input.vocab, send,
          recorded: {
            realtime: input.realtime,
            excluded: (surfaces) => Effect.asVoid(Queue.offer(events, { type: "vocabulary-excluded", surfaces })),
            selfTrack: input.selfFile !== undefined,
            progress: ({ position, rounds }) =>
              Effect.andThen(
                Ref.update(progress, (p) => ({ ...p, position: Math.max(p.position, position), rounds })),
                publishProgress({ progress, events }),
              ),
            paused: (pause) =>
              Effect.gen(function* () {
                const changedState = yield* Ref.modify(progress, (p): [boolean, RecordedProgressState] => {
                  const { paused: before, ...rest } = p;
                  return [(before !== undefined) !== (pause !== undefined), pause === undefined ? rest : { ...rest, paused: pause }];
                });
                if (changedState) yield* controller.send({ type: "reading-pause", paused: pause !== undefined });
                yield* publishProgress({ progress, events });
              }),
          },
        }).pipe(Scope.provide(scope));
        const recorded: Recorded = {
          local: prepared.noMap ? false : prepared.model.local,
          dir,
          file: input.file,
          selfFile: input.selfFile,
          sink,
          scope,
          controller,
          running: yield* Ref.make<IntakeRun | undefined>(undefined),
          events,
          progress,
          from,
          announced: yield* Ref.make({ audioTracks: false, screenOff: false, speakerOff: false }),
        };
        const running = yield* controller.run({
          trigger: "auto", exitZero: "finish", log: sink.appendLog,
          apply: (event) => applyRecordedEventFrom(recorded, event),
          observe: (transition) => Effect.gen(function* () {
            if (transition.kind === "crashed") yield* Ref.set(from, yield* sink.drainForRestart);
            if (transition.kind === "connected" && (yield* controller.stats).attempt > 1) yield* sink.speakersRenumbered;
          }),
        });
        yield* Ref.set(recorded.running, running);
        return {
          active: { kind: "recorded", recorded } satisfies Active,
          local: recorded.local,
          result: { dir, warnings, events: Stream.fromQueue(events) },
          afterPublish: Effect.asVoid(Effect.forkIn(Effect.flatMap(running.end, (end) => {
            if (end.kind === "stopped") return Effect.void;
            return end.kind === "finished"
              ? concludeRecorded(recorded, Effect.andThen(sink.drain, sink.finishBacklog), undefined)
              : concludeRecorded(recorded, Effect.andThen(sink.discardBacklog, sink.finishBacklog), { ...end.last.exit, stderrTail: end.last.stderrTail });
          }), scope)),
        };
      }));

      const stopLive = (live: Live) =>
        Effect.gen(function* () {
          yield* live.meetingTabNotice.stop;
          yield* live.controller.stop;
          const running = yield* Ref.get(live.running);
          const end = running === undefined ? { kind: "stopped" as const, exit: undefined } : yield* running.end;
          yield* live.sink.drain;
          if (end.kind === "stopped" && end.exit?.signal === "SIGKILL") {
            yield* note(`ヘルパーが SIGTERM から ${stopTimeoutMs}ms 経っても終了しないので、SIGKILL で止めます\n`);
            if (live.audio) {
              const names = audioFileNames((yield* live.controller.stats).attempt).join("・");
              yield* note(`録音の書き終わりを確認できないまま、セッションを閉じます。${live.dir} の ${names} が不完全なことがあります\n`);
            }
          }
          yield* live.sink.flush;
          return { paths: yield* live.sink.exports, ocrSummary: yield* live.sink.ocrSummary };
        }).pipe(Effect.ensuring(closeSession(live.sink, live.scope)));

      const stopRecorded = (recorded: Recorded) =>
        Effect.gen(function* () {
          yield* recorded.sink.discardBacklog;
          yield* recorded.controller.stop;
          const running = yield* Ref.get(recorded.running);
          if (running !== undefined) yield* running.end;
          yield* recorded.sink.finishBacklog;
          return yield* finishRecorded(recorded, undefined);
        }).pipe(Effect.ensuring(closeRecorded(recorded)));

      const stop = Effect.uninterruptible(
        Effect.gen(function* () {
          const target = yield* current("any", "stopping");
          const body = target.kind === "live" ? stopLive(target.live) : stopRecorded(target.recorded);
          const running = yield* Effect.forkIn(Effect.interruptible(body), serverScope);
          return { ...yield* Effect.interruptible(Fiber.join(running)), kind: target.kind };
        }),
      );

      const resume = Effect.gen(function* () {
        const live = yield* current("live");
        if ((yield* Ref.get(live.intake)) !== "stopped") return yield* new IntakeNotStopped();
        const warnings = yield* requireStartupDeps("resume", live.model.route, { screen: live.screen, check: helpers.check({ screen: live.screen }) }).pipe(Effect.provideService(ManagedDeps, deps));
        const afterCheck = yield* Ref.get(state);
        if (afterCheck.kind !== "live" || afterCheck.live !== live) return yield* new Aborted();
        const taken = yield* Ref.modify(live.intake, (kind): [boolean, IntakeKind] => (kind === "stopped" ? [true, "interrupted"] : [false, kind]));
        if (!taken) return yield* new IntakeNotStopped();
        const previous = yield* Ref.get(live.running);
        if (previous !== undefined) yield* previous.end;
        const beforeRun = yield* Ref.get(state);
        if (beforeRun.kind !== "live" || beforeRun.live !== live) return yield* new Aborted();
        const running = yield* runLive(live, "resume");
        yield* Ref.set(live.running, running);
        yield* live.send({ type: "intake", status: "interrupted" });
        const result = yield* running.reached;
        if (result.kind === "gaveUp") return yield* new RestartGaveUp({ stderrTail: result.stderrTail });
        if (result.kind === "aborted") return yield* new Aborted();
        return { warnings };
      });

      const checkResume = Effect.gen(function* () {
        const live = yield* current("live");
        return yield* checkManagedDeps("resume", live.model.route, { screen: live.screen, check: helpers.check({ screen: live.screen }) }).pipe(Effect.provideService(ManagedDeps, deps));
      });

      const status: Effect.Effect<IntakeStatusReport> = Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.kind === "recorded") return { status: "running", dir: current.recorded.dir, restarts: 0 };
        if (current.kind !== "live") return { status: "none" };
        const { live } = current;
        const lastInterruptedAt = yield* Ref.get(live.lastInterruptedAt);
        return {
          status: yield* Ref.get(live.intake),
          dir: live.dir,
          restarts: (yield* live.controller.stats).restarts,
          ...(lastInterruptedAt === undefined ? {} : { lastInterruptedAt }),
        };
      });

      const liveSession: Effect.Effect<{ readonly scope: Scope.Scope; readonly local: boolean }, SessionFailure> = Effect.gen(function* () {
        const target = yield* current("any");
        return target.kind === "live"
          ? { scope: target.live.scope, local: target.live.model.local }
          : { scope: target.recorded.scope, local: target.recorded.local };
      });

      const setSelfPause = (paused: boolean): Effect.Effect<void, SessionFailure> =>
        Effect.gen(function* () {
          const live = yield* current("live");
          yield* live.controller.send({ type: "self-pause", paused });
        });

      const setSpeakerName = (speaker: { label: string; name: string }): Effect.Effect<void, SessionFailure | SpeakerNameRejected> =>
        Effect.gen(function* () {
          const target = yield* current("any");
          const sink = target.kind === "live" ? target.live.sink : target.recorded.sink;
          yield* sink.nameSpeaker(speaker);
        });

      return Sessions.of({ apps: helpers.apps, start, startRecorded, stop, status, resume, checkResume, reserveDeps, liveSession, setSelfPause, setSpeakerName });
    }),
  );
}
