import { defaultClaude } from "../src/modelSelection.ts";
import { makeFakeHelpers, type AttemptScript } from "./fixtures/intakeHelpers.ts";
import { readyManagedDeps } from "./fixtures/readyManagedDeps.ts";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Console, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Scope, Stream } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { DiffUpdater, TAP_NOTICE_TEXT, type HelperPartial, type SettledRemark, type Track } from "../src/core/index.ts";
import { Helpers, HelperCreationDateFailure } from "../src/helpers.ts";
import { HelperExited, NoSession, SessionBusy } from "../src/sessionFailure.ts";
import { SessionSinks, type OpenSessionSink, type LiveSink, type RecordedSink } from "../src/sessionSinks.ts";
import { Sessions, SessionsDir, type SessionStart, type RecordedStart } from "../src/sessions.ts";
import { Viewers } from "../src/viewers.ts";
import { UpdaterUnavailable } from "../src/updaterUnavailable.ts";
import { settleUntil } from "./fixtures/sessionLayers.ts";
import { missingKeyNotice, type JudgeModel } from "../src/judgeSelection.ts";
import type { UpdatePlan } from "../src/updatePlan.ts";

// Issue #240 段 3（ADR 0008）: Sessions の状態・start・stop・resume・status と種類別の配線を、
// 偽の Helpers・SessionSinks の Layer と TestClock で確かめる（order.md:39）。本物の子プロセスは使わない。
// 本物の子プロセスのテストは server/test/server.heavy.test.ts の契約 6 本、SessionSinks 自身の実物 Layer の契約は
// server/test/sessionSinks.it.test.ts が確かめる（このファイルでは SessionSinks も偽物）。
//
// 想定する契約（このファイルが要求する Helpers・SessionSinks の形。段 3 の実装はこれを満たす）:
// - `Helpers.launch(args)` は 1 回分の起動を表す `HelperAttempt`（events の Stream・stop・exit・stderrTail）を
//   `Effect<HelperAttempt, HelperLaunchFailure, Scope.Scope>` で返す（Scope を閉じると後始末が走る。要件10,24,27,39,40）。
//   `events` はヘルパーが送った JSON 文字列を届いた順に流す Stream（helperSocket.ts の Queue を経由する想定）。
// - ライブの open と録画の openRecorded は、それぞれの sink をセッションの Scope で 1 回開く
//   （要件3,68,117,125）。Scope を閉じると updater が閉じる（CT-SINK-SCOPE）。

const APPS = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];

// sink の appendLog が受け取る型（intake の記録・自分の休止の記録）。speaker の記録は sink.speaker が受け取る（Issue #1021）
type LogLineEvent = Parameters<LiveSink["appendLog"]>[0];
type SpeakerLine = Parameters<LiveSink["speaker"]>[0];

type FakeSinksHandle = {
  readonly sinks: SessionSinks["Service"];
  readonly opened: { count: number; closed: number };
  readonly finals: { id: string; track: Track; text: string }[];
  readonly partials: { track: Track; text: string }[];
  readonly words: { final: unknown[]; partial: unknown[] }; // sink へ届いた発言・途中結果の words（Issue #639。無ければ undefined）
  readonly screens: { start: number; image: Uint8Array | null; lines?: readonly string[] }[];
  readonly screenOffs: { start: number; reason: "指定" | "許可なし" }[];
  readonly sequence: string[]; // screenOff と final が届いた順（ログの行の順を観測する）
  readonly relayStats: { drained: number; cleared: number; stopped: number };
  readonly appended: LogLineEvent[];
  readonly speakers: SpeakerLine[]; // sink.speaker へ届いた speaker・speaker-off（届いた順）
  readonly speakerCalls: string[]; // sink.speaker（speaker:<type>）と sink.speakersRenumbered（renumbered）が呼ばれた順（Issue #1025）
  readonly vocabAdded: string[][]; // 開始引数で受け取った語（空でない呼び出しごと）
  readonly order: string[]; // flush・exports・close が起きた順
  readonly control: { createDirFails: boolean };
};

// 偽の SessionSinks。ID の採番だけ本物の規則（セッションにつき 1 回のクロージャ、r1 から）を真似る。
// 覆い（settle.ts）の規則は真似ない（その規則は remarkSettling.test.ts・settle.test.ts が別に固定している）
function makeFakeSessionSinks(options: { exportsFails?: boolean } = {}): Effect.Effect<FakeSinksHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const opened = { count: 0, closed: 0 };
    const finals: { id: string; track: Track; text: string }[] = [];
    const partials: { track: Track; text: string }[] = [];
    const words: { final: unknown[]; partial: unknown[] } = { final: [], partial: [] };
    const screens: { start: number; image: Uint8Array | null; lines?: readonly string[] }[] = [];
    const screenOffs: { start: number; reason: "指定" | "許可なし" }[] = [];
    const sequence: string[] = [];
    const relayStats = { drained: 0, cleared: 0, stopped: 0 };
    const appended: LogLineEvent[] = [];
    const speakers: SpeakerLine[] = [];
    const vocabAdded: string[][] = [];
    const speakerCalls: string[] = [];
    const order: string[] = [];
    const control = { createDirFails: false };
    const openBase = (args: OpenSessionSink) =>
      Effect.gen(function* () {
        opened.count++;
        if (args.vocab !== undefined && args.vocab.length > 0) vocabAdded.push([...args.vocab]);
        let count = 0;
        const savedScreens: Parameters<LiveSink["screen"]>[0][] = [];
        yield* Effect.addFinalizer(() => Effect.sync(() => { opened.closed++; order.push("close"); }));
        const sink = {
          dir: args.dir,
          partial: (p: HelperPartial) => Effect.sync(() => { partials.push({ track: p.track, text: p.text }); words.partial.push((p as { words?: unknown }).words); }),
          final: (r: SettledRemark) => Effect.sync(() => { count++; sequence.push("final"); finals.push({ id: `r${count}`, track: r.track, text: r.text }); words.final.push((r as { words?: unknown }).words); }),
          ocrSummary: Effect.sync(() => ({ images: savedScreens.filter((s) => s.image !== null).length, failed: savedScreens.filter((s) => s.image !== null && s.ocrFailed === true).length })),
          screen: (s: Parameters<LiveSink["screen"]>[0]) => Effect.sync(() => { savedScreens.push(s); screens.push({ start: s.start, image: s.image, ...(s.lines !== undefined ? { lines: s.lines } : {}) }); }),
          screenOff: (e: Parameters<LiveSink["screenOff"]>[0]) => Effect.sync(() => { sequence.push(`screenOff:${e.reason}`); screenOffs.push({ start: e.start, reason: e.reason }); }),
          drain: Effect.sync(() => { relayStats.drained++; }),
          stopRelays: Effect.sync(() => { relayStats.stopped++; }),
          appendLog: (event: LogLineEvent) => Effect.sync(() => { appended.push(event); }),
          speaker: (event: SpeakerLine) => Effect.sync(() => { speakers.push(event); speakerCalls.push(`speaker:${event.type}`); }),
          speakersRenumbered: Effect.sync(() => { speakerCalls.push("renumbered"); }),
          nameSpeaker: () => Effect.void,
          flush: Effect.sync(() => { order.push("flush"); }),
          exports: options.exportsFails ? Effect.die(new Error("書き出しに失敗")) : Effect.sync(() => { order.push("exports"); return [`${args.dir}/map.md`, `${args.dir}/map.json`, `${args.dir}/map.drawnix`, `${args.dir}/map.png`]; }),
        };
        return sink;
      });
    const open = (args: OpenSessionSink): Effect.Effect<LiveSink, never, Scope.Scope> =>
      Effect.map(openBase(args), (sink) => ({ ...sink, clearSpeaking: Effect.sync(() => { relayStats.cleared++; }) }));
    const openRecorded: SessionSinks["Service"]["openRecorded"] = (args) =>
      Effect.map(openBase(args), (sink): RecordedSink => ({ ...sink, drainForRestart: Effect.succeed({}), finishBacklog: Effect.void, discardBacklog: Effect.void }));
    let dirCount = 0;
    const createDir = (_sessionsDir: string) => Effect.suspend(() => (control.createDirFails ? Effect.die(new Error("フォルダを作れません")) : Effect.succeed(`/tmp/live-mindmap-fake/${++dirCount}`)));
    return { sinks: SessionSinks.of({ open, openRecorded, createDir, prepare: () => Effect.succeed({ layer: Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.succeed({ ops: [] }) })) }) }), opened, finals, partials, words, screens, screenOffs, sequence, relayStats, appended, speakers, speakerCalls, vocabAdded, order, control };
  });
}

// 本物の startup と同じ形（Layer.build + Context.get。server/src/http.ts:214-217 が手本）で Sessions を取り出す。
// scope を自分で持つことで、「サーバーの Scope を閉じる」を明示的なタイミングで起こせる（CT-CLOSE-ONLY-INTERRUPT）
const bootSessions = (helpersLayer: Layer.Layer<Helpers>, sinksLayer: Layer.Layer<SessionSinks>) =>
  Effect.gen(function* () {
    // テストの終了で必ず解放する（closeServer で先に閉じても、二重の close は何もしない）
    const scope = yield* Effect.acquireRelease(Scope.make(), (made) => Scope.close(made, Exit.void));
    const context = yield* Scope.provide(Layer.build(Sessions.layer.pipe(Layer.provideMerge(Layer.mergeAll(readyManagedDeps, helpersLayer, sinksLayer, Layer.succeed(SessionsDir)("/tmp/live-mindmap-fake"), Viewers.layer)))), scope);
    return { sessions: Context.get(context, Sessions), viewers: Context.get(context, Viewers), closeServer: () => Scope.close(scope, Exit.void) };
  });

describe("現在のセッションの状態による操作の許可", () => {
  it.effect.each([
    { operation: "resume", state: "idle", expected: "NoSession" },
    { operation: "checkResume", state: "idle", expected: "NoSession" },
    { operation: "setSelfPause", state: "idle", expected: "NoSession" },
    { operation: "liveSession", state: "idle", expected: "NoSession" },
    { operation: "setSpeakerName", state: "idle", expected: "NoSession" },
    { operation: "resume", state: "starting", expected: "SessionTransition" },
    { operation: "checkResume", state: "starting", expected: "SessionTransition" },
    { operation: "setSelfPause", state: "starting", expected: "SessionTransition" },
    { operation: "liveSession", state: "starting", expected: "SessionTransition" },
    { operation: "setSpeakerName", state: "starting", expected: "SessionTransition" },
    { operation: "resume", state: "stopping", expected: "SessionTransition" },
    { operation: "checkResume", state: "stopping", expected: "SessionTransition" },
    { operation: "setSelfPause", state: "stopping", expected: "SessionTransition" },
    { operation: "liveSession", state: "stopping", expected: "SessionTransition" },
    { operation: "setSpeakerName", state: "stopping", expected: "SessionTransition" },
    { operation: "resume", state: "recorded", expected: "NotForRecordedSession" },
    { operation: "checkResume", state: "recorded", expected: "NotForRecordedSession" },
    { operation: "setSelfPause", state: "recorded", expected: "NotForRecordedSession" },
    { operation: "liveSession", state: "recorded", expected: "Success" },
    { operation: "setSpeakerName", state: "recorded", expected: "Success" },
  ] as const)("$state の $operation は $expected を返す", ({ operation, state, expected }) => Effect.gen(function* () {
    const launchEntered = yield* Deferred.make<void>();
    const releaseLaunch = yield* Deferred.make<void>();
    const flushEntered = yield* Deferred.make<void>();
    const releaseFlush = yield* Deferred.make<void>();
    const fakeHelpers = yield* makeFakeHelpers([{ connectGate: releaseLaunch }]);
    const helpers = Helpers.of({ ...fakeHelpers.helpers, launch: (args, stopRequested) => Effect.andThen(
      Deferred.succeed(launchEntered, undefined), fakeHelpers.helpers.launch(args, stopRequested),
    ) });
    const fake = yield* makeFakeSessionSinks();
    const named: Parameters<RecordedSink["nameSpeaker"]>[0][] = [];
    const sinks = SessionSinks.of({ ...fake.sinks,
      open: (args) => Effect.map(fake.sinks.open(args), (sink) => ({ ...sink,
        flush: Effect.andThen(Deferred.succeed(flushEntered, undefined), Effect.andThen(Deferred.await(releaseFlush), sink.flush)),
      })),
      openRecorded: (args) => Effect.map(fake.sinks.openRecorded(args), (sink) => ({ ...sink,
        nameSpeaker: (speaker) => Effect.sync(() => { named.push(speaker); }),
      })),
    });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers), Layer.succeed(SessionSinks, sinks));
    const invoke = Effect.gen(function* () {
      switch (operation) {
        case "resume": return yield* sessions.resume.pipe(Effect.asVoid);
        case "checkResume": return yield* sessions.checkResume.pipe(Effect.asVoid);
        case "setSelfPause": return yield* sessions.setSelfPause(true);
        case "liveSession": {
          const session = yield* sessions.liveSession;
          expect(session.local).toBe(false);
          expect(session.scope).toBeDefined();
          return;
        }
        case "setSpeakerName": return yield* sessions.setSpeakerName({ label: "相手 A", name: "山田" });
      }
    });

    const result = yield* Effect.gen(function* () {
      if (state === "idle") return yield* Effect.exit(invoke);
      if (state === "recorded") {
        yield* Deferred.succeed(releaseLaunch, undefined);
        yield* sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
        const result = yield* Effect.exit(invoke);
        yield* sessions.stop;
        return result;
      }
      const starting = yield* sessions.start(start()).pipe(Effect.forkChild);
      yield* Deferred.await(launchEntered);
      const duringStart = state === "starting" ? yield* Effect.exit(invoke) : undefined;
      yield* Deferred.succeed(releaseLaunch, undefined);
      yield* Fiber.join(starting);
      expect((yield* sessions.status).status).toBe("running");
      const stopping = yield* sessions.stop.pipe(Effect.forkChild);
      yield* Deferred.await(flushEntered);
      const result = duringStart ?? (yield* Effect.exit(invoke));
      yield* Deferred.succeed(releaseFlush, undefined);
      yield* Fiber.join(stopping);
      expect(yield* sessions.status).toEqual({ status: "none" });
      return result;
    });

    expect(Exit.isFailure(result) ? Cause.squash(result.cause) : { _tag: "Success" }).toMatchObject({ _tag: expected });
    expect(fakeHelpers.sentPauses).toEqual([]);
    expect(named).toEqual(state === "recorded" && operation === "setSpeakerName" ? [{ label: "相手 A", name: "山田" }] : []);
  }).pipe(Effect.scoped));

  it.effect.each(["live", "recorded"] as const)("%s の flush 待機中の二重 stop は拒否し、書き出しと close は1回だけ行う", (kind) => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holdFlush = (flush: Effect.Effect<void>) => Effect.andThen(
      Deferred.succeed(entered, undefined), Effect.andThen(Deferred.await(release), flush),
    );
    const sinks = SessionSinks.of({ ...fake.sinks,
      open: (args) => Effect.map(fake.sinks.open(args), (sink) => ({ ...sink, flush: holdFlush(sink.flush) })),
      openRecorded: (args) => Effect.map(fake.sinks.openRecorded(args), (sink) => ({ ...sink, flush: holdFlush(sink.flush) })),
    });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    if (kind === "live") yield* sessions.start(start());
    else yield* sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    const stopping = yield* sessions.stop.pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const second = yield* Effect.exit(sessions.stop);
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(stopping);

    expect(Exit.isFailure(second) && Cause.squash(second.cause)).toMatchObject({ _tag: "SessionTransition" });
    expect(result.kind).toBe(kind);
    expect(result.paths).toHaveLength(4);
    expect(fake.order).toEqual(["flush", "exports", "close"]);
    expect(fake.opened.closed).toBe(1);
    expect(yield* sessions.status).toEqual({ status: "none" });
  }).pipe(Effect.scoped));
});

describe("録画の引数と終了処理", () => {
  it.effect("閲覧の共有が使う録画のScopeは、録画の終了で1回だけ閉じる", () => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, fake.sinks));
    const run = yield* sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    const consuming = yield* Stream.runDrain(run.events).pipe(Effect.forkChild);
    const session = yield* sessions.liveSession;
    const sharing = yield* Scope.fork(session.scope, "sequential");
    let closed = 0;
    yield* Scope.addFinalizer(sharing, Effect.sync(() => { closed++; }));
    expect(session.local).toBe(false);
    expect(closed).toBe(0);
    yield* sessions.stop;
    yield* Fiber.join(consuming);
    expect(closed).toBe(1);
    yield* Scope.close(sharing, Exit.void);
    expect(closed).toBe(1);
  }).pipe(Effect.scoped));

  it.effect.each([
    { ends: {}, selfFile: undefined, flags: [] },
    { ends: { 相手: 10 }, selfFile: undefined, flags: ["--from", "10"] },
    { ends: { 相手: 10 }, selfFile: "/self.m4a", flags: ["--self-file", "/self.m4a", "--from", "10"] },
    { ends: { 相手: 10, 自分: 6 }, selfFile: "/self.m4a", flags: ["--self-file", "/self.m4a", "--from", "10", "--self-from", "6"] },
  ])("再起動はsinkのトラック別endを渡し、音声の書き出し先は初回だけ渡す（$flags）", ({ ends, selfFile, flags }) => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 1, exit: { code: 1, signal: null } } }, {}]);
    const fake = yield* makeFakeSessionSinks();
    let prepared = 0;
    const sinks = SessionSinks.of({ ...fake.sinks, openRecorded: (args) => Effect.map(fake.sinks.openRecorded(args), (sink) => ({
      ...sink, drainForRestart: Effect.sync(() => { prepared++; return ends; }),
    })) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    const run = yield* sessions.startRecorded({ file: "/meeting.m4a", selfFile, title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    yield* TestClock.adjust(1);
    expect(prepared).toBe(1);
    expect(helpers.calls).toEqual([
      ["transcribe-file", "--file", "/meeting.m4a", ...(selfFile === undefined ? [] : ["--self-file", selfFile]), "--audio-dir", run.dir],
      ["transcribe-file", "--file", "/meeting.m4a", ...flags],
    ]);
    expect(fake.opened.count).toBe(1);
    yield* sessions.stop;
  }).pipe(Effect.scoped));

  it.effect("録画の題名・語彙・モデルをsinkへ渡す", () => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const opened: Parameters<SessionSinks["Service"]["openRecorded"]>[0][] = [];
    const prepared: Parameters<SessionSinks["Service"]["prepare"]>[0][] = [];
    const sinks = SessionSinks.of({ ...fake.sinks,
      openRecorded: (args) => Effect.andThen(Effect.sync(() => { opened.push(args); }), fake.sinks.openRecorded(args)),
      prepare: (plan) => Effect.andThen(Effect.sync(() => { prepared.push(plan); }), fake.sinks.prepare(plan)),
    });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    const model = { ...defaultClaude, name: "fast", model: "claude-haiku-5-5" };
    yield* sessions.startRecorded({ file: "/meeting.m4a", title: "週次会議", vocab: ["ヤマダ商事", "アルファ"], realtime: false, plan: { kind: "single", model } });
    expect(prepared).toEqual([{ kind: "single", model }]);
    expect(opened).toEqual([expect.objectContaining({ title: "週次会議", model, vocab: ["ヤマダ商事", "アルファ"] })]);
    expect(fake.vocabAdded).toEqual([["ヤマダ商事", "アルファ"]]);
    const result = yield* Effect.exit(sessions.startRecorded({ file: "/other.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model } }));
    expect(result._tag).toBe("Failure");
    expect(helpers.calls).toHaveLength(1);
    yield* sessions.stop;
  }).pipe(Effect.scoped));

  it.effect("録画の判定を含む計画をそのまま sink の準備へ渡す", () => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const judge: JudgeModel = { name: "clef", route: "system-one", apiKeyEnv: "CLOUDFLARE_API_TOKEN", accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", model: "clef", timeoutMs: 2000 };
    const plan: UpdatePlan = { kind: "routed", judge };
    const prepared: UpdatePlan[] = [];
    const sinks = SessionSinks.of({ ...fake.sinks, prepare: (received) => Effect.andThen(
      Effect.sync(() => { prepared.push(received); }), fake.sinks.prepare(received),
    ) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    const input = { file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan };
    yield* sessions.startRecorded(input);

    expect(prepared).toEqual([{ kind: "routed", judge }]);
    expect(fake.opened.count).toBe(1);
    yield* sessions.stop;
  }).pipe(Effect.scoped));

  it.effect("録画の開始応答は準備の通知をライブと同じ warnings で返す", () => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const notice = missingKeyNotice({ name: "jev" }, ["TYPESAFE_AI_API_KEY"]);
    const sinks = SessionSinks.of({ ...fake.sinks, prepare: (plan) => Effect.map(fake.sinks.prepare(plan), (prepared) => ({ ...prepared, notice })) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    const live = yield* sessions.start(start({ screen: false }));
    yield* sessions.stop;
    const recorded = yield* sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });

    expect(recorded.warnings).toEqual(live.warnings);
    expect(recorded.warnings.filter((line) => line === notice)).toHaveLength(1);
    yield* sessions.stop;
  }).pipe(Effect.scoped));
});

describe("録画の開始と再送の配線", () => {
  it.effect.each([
    { name: "作成日時あり", created: "2026-10-01T01:02:03Z" },
    { name: "作成日時なし", created: null },
    { name: "問い合わせ失敗", created: "fail" },
  ])("$name の基準時刻・ずらし幅・既定題名をメインファイルから決める", ({ created }) => Effect.gen(function* () {
    const fakeHelpers = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const queried: string[] = [];
    const directories: { root: string; at: number }[] = [];
    const opened: Parameters<SessionSinks["Service"]["openRecorded"]>[0][] = [];
    const warnings: string[] = [];
    const console = yield* Console.Console;
    const helpers = Helpers.of({ ...fakeHelpers.helpers, creationDate: (file) => Effect.gen(function* () {
      queried.push(file);
      if (created === "fail") return yield* new HelperCreationDateFailure({ message: "日時を取得できない" });
      return created;
    }) });
    const dir = "/tmp/live-mindmap-fake/2026-10-01T01-02-03.000Z-2";
    const sinks = SessionSinks.of({ ...fake.sinks,
      createDir: (root, at) => Effect.sync(() => { directories.push({ root, at: DateTime.toEpochMillis(at!) }); return dir; }),
      openRecorded: (args) => Effect.andThen(Effect.sync(() => { opened.push(args); }), fake.sinks.openRecorded(args)),
    });
    const before = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers), Layer.succeed(SessionSinks, sinks));
    const run = yield* sessions.startRecorded({ file: "/main/meeting.m4a", selfFile: "/mine/other.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } }).pipe(
      Effect.provideService(Console.Console, { ...console, error: (...args) => { warnings.push(args.join(" ")); } }),
    );
    const after = DateTime.toEpochMillis(DateTime.nowUnsafe());
    expect(queried).toEqual(["/main/meeting.m4a"]);
    expect(directories).toHaveLength(1);
    expect(directories[0]!.root).toBe("/tmp/live-mindmap-fake");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ dir, title: "meeting" });
    const base = directories[0]!.at;
    if (created === null || created === "fail") {
      expect(base).toBeGreaterThanOrEqual(before);
      expect(base).toBeLessThanOrEqual(after);
      expect(opened[0]!.logShiftMs).toBe(0);
    } else {
      expect(base).toBe(DateTime.toEpochMillis(DateTime.makeUnsafe(created)));
      expect(base - opened[0]!.logShiftMs!).toBeGreaterThanOrEqual(before);
      expect(base - opened[0]!.logShiftMs!).toBeLessThanOrEqual(after);
    }
    expect(warnings).toEqual(created === "fail" ? [expect.stringContaining("作成日時を読めない")] : []);
    expect(run.dir).toBe(dir);
    expect(fakeHelpers.calls).toEqual([["transcribe-file", "--file", "/main/meeting.m4a", "--self-file", "/mine/other.m4a", "--audio-dir", dir]]);
    const consuming = yield* Stream.runDrain(run.events).pipe(Effect.forkChild);
    yield* sessions.stop;
    yield* Fiber.join(consuming);
  }).pipe(Effect.scoped));

  it.effect.each([
    { ends: {}, expected: [0, 5, 6, 7, 9, 10, 11] },
    { ends: { 相手: 10 }, expected: [10, 11] },
    { ends: { 相手: 10, 自分: 6 }, expected: [10, 11] },
  ])("再送の発言と途中結果をトラック別の開始位置で除外する（$ends）", ({ ends, expected }) => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 1, exit: { code: 1, signal: null } } }, {}]);
    const fake = yield* makeFakeSessionSinks();
    const sinks = SessionSinks.of({ ...fake.sinks, openRecorded: (args) => Effect.map(fake.sinks.openRecorded(args), (sink) => ({ ...sink, drainForRestart: Effect.succeed(ends) })) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    const run = yield* sessions.startRecorded({ file: "/meeting.m4a", selfFile: "/self.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    const consumed = yield* Deferred.make<void>();
    const consuming = yield* Stream.runForEach(run.events, (event) => event.type === "progress" && event.duration === 99 ? Deferred.succeed(consumed, undefined) : Effect.void).pipe(Effect.forkChild);
    helpers.send(0, { type: "remark", track: "相手", start: 8, end: 10, text: "再起動前" });
    yield* TestClock.adjust(1);
    expect(helpers.calls).toHaveLength(2);
    for (const track of ["相手", "自分"] as const) {
      for (const start of [0, 5, 6, 7, 9, 10, 11]) {
        for (const type of ["remark", "partial"] as const) helpers.send(1, { type, track, start, end: start + 1, text: `${track}:${start}` });
      }
    }
    helpers.send(1, { type: "file-duration", duration: 99 });
    yield* Deferred.await(consumed);
    const mine = "自分" in ends ? [6, 7, 9, 10, 11] : [0, 5, 6, 7, 9, 10, 11];
    const texts = [...expected.map((n) => `相手:${n}`), ...mine.map((n) => `自分:${n}`)];
    expect(fake.finals.map((r) => r.text)).toEqual(["再起動前", ...texts]);
    expect(fake.partials.map((p) => p.text)).toEqual(texts);
    expect(fake.opened.count).toBe(1);
    yield* sessions.stop;
    yield* Fiber.join(consuming);
  }).pipe(Effect.scoped));

  it.effect("ライブ中の録画開始はSessionBusyで断り、ヘルパーを追加起動しない", () => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, fake.sinks));
    yield* sessions.start(start());
    expect(helpers.calls).toHaveLength(1);
    const result = yield* Effect.exit(sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } }));
    expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(SessionBusy);
    expect(helpers.calls).toHaveLength(1);
    expect(yield* sessions.status).toMatchObject({ status: "running" });
    yield* sessions.stop;
  }).pipe(Effect.scoped));

  it.effect("音声1本とscreen-off不在では通知せず、複数音声とscreen-offは再起動をまたいで1回だけ通知する", () => Effect.gen(function* () {
    const fakeHelpers = yield* makeFakeHelpers([
      { unexpectedExit: { afterMs: 1, exit: { code: 1, signal: null } } }, {},
    ]);
    const fakeSinks = yield* makeFakeSessionSinks();
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, fakeHelpers.helpers), Layer.succeed(SessionSinks, fakeSinks.sinks));
    const run = yield* sessions.startRecorded({ file: "/recording.mp4", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    const firstRead = yield* Deferred.make<void>();
    const replayRead = yield* Deferred.make<void>();
    const initialRead = yield* Deferred.make<void>();
    const notices: string[] = [];
    const consuming = yield* Stream.runForEach(run.events, (event) => Effect.gen(function* () {
      if (event.type === "screen-off" || event.type === "audio-tracks") notices.push(event.type);
      if (event.type === "progress" && event.duration === 76) yield* Deferred.succeed(initialRead, undefined);
      if (event.type === "progress" && event.duration === 77) yield* Deferred.succeed(firstRead, undefined);
      if (event.type === "progress" && event.duration === 78) yield* Deferred.succeed(replayRead, undefined);
    })).pipe(Effect.forkChild);
    fakeHelpers.send(0, { type: "file-audio-tracks", count: 1 });
    fakeHelpers.send(0, { type: "file-duration", duration: 76 });
    yield* Deferred.await(initialRead);
    expect(notices).toEqual([]);
    fakeHelpers.send(0, { type: "file-audio-tracks", count: 2 });
    fakeHelpers.send(0, { type: "screen-off", start: 11, reason: "許可なし" });
    fakeHelpers.send(0, { type: "file-duration", duration: 77 });
    yield* Deferred.await(firstRead);
    expect(fakeSinks.screenOffs).toEqual([{ start: 11, reason: "許可なし" }]);
    yield* TestClock.adjust(1);
    expect(fakeHelpers.calls).toHaveLength(2);
    fakeHelpers.send(1, { type: "screen-off", start: 11, reason: "許可なし" });
    fakeHelpers.send(1, { type: "file-audio-tracks", count: 2 });
    fakeHelpers.send(1, { type: "file-duration", duration: 78 });
    yield* Deferred.await(replayRead);
    expect(fakeSinks.opened.count).toBe(1);
    expect(fakeSinks.screenOffs).toEqual([{ start: 11, reason: "許可なし" }, { start: 11, reason: "許可なし" }]);
    expect(notices).toEqual(["audio-tracks", "screen-off"]);
    yield* sessions.stop;
    yield* Fiber.join(consuming);
  }).pipe(Effect.scoped));
});

describe("録画の停止と一時停止の配線", () => {
  it.effect("一時停止の通知がなければ、発言を処理して終わるまでreading-pauseを送らない", () => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{
      events: [JSON.stringify({ type: "remark", track: "相手", start: 0, end: 1, text: "通常の発言" })],
      unexpectedExit: { afterMs: 1, exit: { code: 0, signal: null } },
    }]);
    const fake = yield* makeFakeSessionSinks();
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, fake.sinks));
    const run = yield* sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    const consuming = yield* Stream.runCollect(run.events).pipe(Effect.forkChild);
    yield* TestClock.adjust(1);
    const events = yield* Fiber.join(consuming);
    expect(fake.finals.map((r) => r.text)).toEqual(["通常の発言"]);
    expect(events.at(-1)?.type).toBe("finished");
    expect(helpers.sentInstructions).toEqual([]);
  }).pipe(Effect.scoped));

  it.effect("自然終了はdrainとfinishBacklogを待ち、溜まりを捨てずに書き出す", () => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 1, exit: { code: 0, signal: null } } }]);
    const fake = yield* makeFakeSessionSinks();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const order: string[] = [];
    const sinks = SessionSinks.of({ ...fake.sinks, openRecorded: (args) => Effect.map(fake.sinks.openRecorded(args), (sink) => ({
      ...sink,
      drain: Effect.sync(() => { order.push("drain"); }),
      discardBacklog: Effect.sync(() => { order.push("discard"); }),
      finishBacklog: Effect.gen(function* () { order.push("finish"); yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release); }),
    })) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    const run = yield* sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    const consuming = yield* Stream.runCollect(run.events).pipe(Effect.forkChild);
    yield* TestClock.adjust(1);
    yield* Deferred.await(entered);
    expect(order).toEqual(["drain", "finish"]);
    expect(fake.order).toEqual([]);
    expect(yield* sessions.status).toMatchObject({ status: "running", dir: run.dir });
    yield* Deferred.succeed(release, undefined);
    const events = yield* Fiber.join(consuming);
    expect(events.at(-1)).toMatchObject({ type: "finished" });
    expect(fake.order).toEqual(["flush", "exports", "close"]);
    expect(yield* sessions.status).toEqual({ status: "none" });
  }).pipe(Effect.scoped));

  it.effect("諦めたら溜まりを捨て、finishBacklogの後で失敗を知らせて閉じる", () => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 1, exit: { code: 1, signal: null } }, stderrTail: ["最後の標準エラー"] }]);
    const fake = yield* makeFakeSessionSinks();
    const order: string[] = [];
    const sinks = SessionSinks.of({ ...fake.sinks, openRecorded: (args) => Effect.map(fake.sinks.openRecorded(args), (sink) => ({
      ...sink,
      appendLog: (event) => Effect.andThen(Effect.sync(() => { if (event.type === "intake-gave-up") order.push("gave-up"); }), sink.appendLog(event)),
      drain: Effect.sync(() => { order.push("drain"); }),
      discardBacklog: Effect.sync(() => { order.push("discard"); }),
      finishBacklog: Effect.sync(() => { order.push("finish"); }),
      flush: Effect.andThen(Effect.sync(() => { order.push("flush"); }), sink.flush),
      exports: Effect.andThen(Effect.sync(() => { order.push("exports"); }), sink.exports),
    })) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    const run = yield* sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    const consuming = yield* Stream.runCollect(run.events).pipe(Effect.forkChild);
    yield* TestClock.adjust(3);
    const events = yield* Fiber.join(consuming);
    expect(order).toEqual(["gave-up", "discard", "finish", "flush", "exports"]);
    expect(events.at(-1)).toMatchObject({ type: "finished", failure: { code: 1, signal: null, stderrTail: ["最後の標準エラー"] } });
    expect(fake.opened.closed).toBe(1);
    expect(yield* sessions.status).toEqual({ status: "none" });
  }).pipe(Effect.scoped));

  it.effect.each(["stop", "自然終了"] as const)("自然終了とstopが重なっても%sが取得した終了処理だけで書き出す", (owner) => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 1, exit: { code: 0, signal: null } } }]);
    const fake = yield* makeFakeSessionSinks();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const concluding = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
    const exporting = yield* Deferred.make<void>();
    const releaseExport = yield* Deferred.make<void>();
    let finishes = 0;
    const sinks = SessionSinks.of({ ...fake.sinks, openRecorded: (args) => Effect.map(fake.sinks.openRecorded(args), (sink) => ({
      ...sink,
      finishBacklog: Effect.gen(function* () {
        finishes++;
        if (owner === "stop" && finishes === 1) {
          yield* Deferred.succeed(concluding, yield* Effect.fiber);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
      }),
      exports: Effect.gen(function* () {
        if (owner === "自然終了") {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        } else {
          yield* Deferred.succeed(exporting, undefined);
          yield* Deferred.await(releaseExport);
        }
        return yield* sink.exports;
      }),
    })) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    const run = yield* sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    const consuming = yield* Stream.runCollect(run.events).pipe(Effect.forkChild);
    yield* TestClock.adjust(1);
    yield* Deferred.await(entered);
    if (owner === "stop") {
      const stopping = yield* sessions.stop.pipe(Effect.forkChild);
      yield* Deferred.await(exporting);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(yield* Deferred.await(concluding));
      yield* Deferred.succeed(releaseExport, undefined);
      yield* Fiber.join(stopping);
    } else {
      const stopping = yield* Effect.exit(sessions.stop).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      expect(Exit.isFailure(yield* Fiber.join(stopping))).toBe(true);
    }
    const events = yield* Fiber.join(consuming);
    expect(events.filter((event) => event.type === "finished")).toHaveLength(1);
    expect(fake.order.filter((step) => step === "exports")).toHaveLength(1);
    expect(fake.opened.closed).toBe(1);
    expect(yield* sessions.status).toEqual({ status: "none" });
  }).pipe(Effect.scoped));

  it.effect.each([false, true])("終了処理のdefectでもイベント列と状態を解放し、次の録画を始められる（stop経由=%s）", (stopping) => Effect.gen(function* () {
    const helpers = yield* makeFakeHelpers(stopping ? [{}, {}] : [{ unexpectedExit: { afterMs: 1, exit: { code: 0, signal: null } } }, {}]);
    const fake = yield* makeFakeSessionSinks();
    let fail = true;
    const sinks = SessionSinks.of({ ...fake.sinks, openRecorded: (args) => Effect.map(fake.sinks.openRecorded(args), (sink) => ({
      ...sink, finishBacklog: Effect.suspend(() => fail ? Effect.die(new Error("書き込みに失敗")) : Effect.void),
    })) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, sinks));
    const input: RecordedStart = { file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } };
    const run = yield* sessions.startRecorded(input);
    const consuming = yield* Stream.runCollect(run.events).pipe(Effect.forkChild);
    if (stopping) {
      const result = yield* Effect.exit(sessions.stop);
      expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true);
    } else yield* TestClock.adjust(1);
    expect((yield* Fiber.join(consuming)).filter((event) => event.type === "finished")).toEqual([]);
    expect(yield* sessions.status).toEqual({ status: "none" });
    expect(fake.opened.closed).toBe(1);
    fail = false;
    const next = yield* sessions.startRecorded(input);
    expect(helpers.calls).toHaveLength(2);
    const reading = yield* Stream.runCollect(next.events).pipe(Effect.forkChild);
    yield* sessions.stop;
    expect((yield* Fiber.join(reading)).at(-1)?.type).toBe("finished");
    expect(fake.opened.closed).toBe(2);
  }).pipe(Effect.scoped));

  it.effect("stopは溜まりを捨ててからヘルパーを止め、finish後に書き出す", () => Effect.gen(function* () {
    const fakeHelpers = yield* makeFakeHelpers([{ stopDelayMs: 100 }]);
    const fakeSinks = yield* makeFakeSessionSinks();
    const order: string[] = [];
    const stopRequested = yield* Deferred.make<void>();
    const helpers = Helpers.of({ ...fakeHelpers.helpers, launch: Effect.fnUntraced(function* (args, stop) {
      const attempt = yield* fakeHelpers.helpers.launch(args, stop);
      return { ...attempt,
        stop: Effect.gen(function* () {
          order.push("helper-stop");
          yield* Deferred.succeed(stopRequested, undefined);
          yield* attempt.stop;
        }),
        exit: Effect.tap(attempt.exit, () => Effect.sync(() => { order.push("end"); })),
      };
    }) });
    const sinks = SessionSinks.of({ ...fakeSinks.sinks, openRecorded: (args) => Effect.map(fakeSinks.sinks.openRecorded(args), (sink) => ({
      ...sink,
      discardBacklog: Effect.sync(() => { order.push("discard"); }),
      finishBacklog: Effect.sync(() => { order.push("finish"); }),
      flush: Effect.sync(() => { order.push("flush"); }),
      exports: Effect.andThen(Effect.sync(() => { order.push("exports"); }), sink.exports),
    })) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helpers), Layer.succeed(SessionSinks, sinks));
    const run = yield* sessions.startRecorded({ file: "/recording.m4a", title: undefined, vocab: [], realtime: true, plan: { kind: "single", model: defaultClaude } });
    const consuming = yield* Stream.runDrain(run.events).pipe(Effect.forkChild);
    const stopping = yield* sessions.stop.pipe(Effect.forkChild);
    yield* Deferred.await(stopRequested);
    expect(order).toEqual(["discard", "helper-stop"]);
    yield* TestClock.adjust(100);
    yield* Fiber.join(stopping);
    yield* Fiber.join(consuming);
    expect(order).toEqual(["discard", "helper-stop", "end", "finish", "flush", "exports"]);
    expect(yield* sessions.status).toEqual({ status: "none" });
  }).pipe(Effect.scoped));

  it.effect("一時停止の理由と再開をprogressへ渡し、状態が変わったときだけ読み取りの指令を送る", () => Effect.gen(function* () {
    const fakeHelpers = yield* makeFakeHelpers([{}]);
    const fakeSinks = yield* makeFakeSessionSinks();
    const callbacks = yield* Deferred.make<Parameters<SessionSinks["Service"]["openRecorded"]>[0]["recorded"]>();
    const sinks = SessionSinks.of({ ...fakeSinks.sinks, openRecorded: (args) =>
      Effect.andThen(Deferred.succeed(callbacks, args.recorded), fakeSinks.sinks.openRecorded(args)) });
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, fakeHelpers.helpers), Layer.succeed(SessionSinks, sinks));
    const run = yield* sessions.startRecorded({ file: "/recording.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });
    const events: { type: string; paused?: { reason: string; retryAt: number } }[] = [];
    const consuming = yield* Stream.runForEach(run.events, (e) => Effect.sync(() => { events.push(e); })).pipe(Effect.forkChild);
    const control = yield* Deferred.await(callbacks);
    yield* control.paused({ reason: "ChatGPT の利用上限", retryAt: 100_000 });
    yield* control.paused({ reason: "Claude の利用上限", retryAt: 400_000 });
    expect(fakeHelpers.sentInstructions).toEqual([{ attempt: 0, instruction: { type: "reading-pause", paused: true } }]);
    yield* control.paused(undefined);
    yield* sessions.stop;
    yield* Fiber.join(consuming);
    expect(fakeHelpers.sentInstructions).toEqual([
      { attempt: 0, instruction: { type: "reading-pause", paused: true } },
      { attempt: 0, instruction: { type: "reading-pause", paused: false } },
    ]);
    expect(events.filter((e) => e.type === "progress").map((e) => e.paused)).toEqual([
      { reason: "ChatGPT の利用上限", retryAt: 100_000 }, { reason: "Claude の利用上限", retryAt: 400_000 }, undefined,
    ]);
  }).pipe(Effect.scoped));
});

describe("推論プロセスの準備をセッションが所有する", () => {
  const preparation = Effect.fnUntraced(function* (fake: FakeSinksHandle) {
    const ready = yield* Deferred.make<void, UpdaterUnavailable>();
    const control = { ready };
    const state = { opened: 0, closed: 0, createdDirs: 0, flushAlive: false, exportsAlive: false };
    const original = fake.sinks;
    const sinks = SessionSinks.of({
      ...original,
      createDir: (dir, at) => Effect.andThen(Effect.sync(() => { state.createdDirs++; }), original.createDir(dir, at)),
      prepare: () => Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => { state.opened++; }),
          () => Effect.sync(() => { state.closed++; }),
        );
        yield* Deferred.await(control.ready);
        return { layer: Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.succeed({ ops: [] }) })) };
      }),
      open: (args) => original.open(args).pipe(Effect.map((sink) => ({
        ...sink,
        flush: Effect.andThen(Effect.sync(() => { state.flushAlive = state.opened > state.closed; }), sink.flush),
        exports: Effect.andThen(Effect.sync(() => { state.exportsAlive = state.opened > state.closed; }), sink.exports),
      }))),
    });
    return { ready, control, state, layer: Layer.succeed(SessionSinks, sinks) };
  });

  it.effect("準備完了まではフォルダと取り込みを始めず、最後の更新と書き出しの後に推論子を閉じる", () => Effect.gen(function* () {
    const helper = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const prep = yield* preparation(fake);
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), prep.layer);
    const starting = yield* Effect.forkChild(sessions.start({ app: "us.zoom.xos", plan: { kind: "single", model: defaultClaude }, audio: false, screen: false, title: undefined, vocab: [] }));
    yield* settleUntil(() => prep.state.opened === 1);
    expect(prep.state).toMatchObject({ opened: 1, closed: 0 });
    expect(helper.calls).toEqual([]);
    expect(prep.state.createdDirs).toBe(0);
    expect(fake.opened.count).toBe(0);
    yield* Deferred.succeed(prep.ready, undefined);
    yield* Fiber.join(starting);
    expect(helper.calls).toHaveLength(1);
    expect(prep.state.createdDirs).toBe(1);
    expect(fake.opened.count).toBe(1);
    expect(prep.state.closed).toBe(0);
    yield* sessions.stop;
    expect({ ...prep.state }).toEqual({ opened: 1, closed: 1, createdDirs: 1, flushAlive: true, exportsAlive: true });
  }));

  it.effect("準備を拒否したら取得済みの推論子を閉じ、同じサーバーで次の開始を行える", () => Effect.gen(function* () {
    const helper = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const prep = yield* preparation(fake);
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), prep.layer);
    const input: SessionStart = { app: "us.zoom.xos", plan: { kind: "single", model: defaultClaude }, audio: false, screen: false, title: undefined, vocab: [] };
    const starting = yield* Effect.forkChild(Effect.exit(sessions.start(input)));
    yield* settleUntil(() => prep.state.opened === 1);
    expect(prep.state.opened).toBe(1);
    yield* Deferred.fail(prep.ready, new UpdaterUnavailable({ message: "モデルの準備中です\nしばらく待ってください" }));
    expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true);
    expect(prep.state.closed).toBe(1);
    expect(helper.calls).toEqual([]);
    expect(prep.state.createdDirs).toBe(0);
    expect(fake.opened.count).toBe(0);
    // 新しい開始は別の準備を取得する。失敗したセッションの状態を持ち越さない。
    prep.control.ready = yield* Deferred.make<void, UpdaterUnavailable>();
    yield* Deferred.succeed(prep.control.ready, undefined);
    yield* sessions.start(input);
    yield* sessions.stop;
    expect(helper.calls).toHaveLength(1);
    expect(prep.state).toMatchObject({ opened: 2, closed: 2 });
  }));

  it.effect.each([
    { kind: "live", failure: "フォルダ作成" },
    { kind: "live", failure: "ヘルパー起動" },
    { kind: "recorded", failure: "フォルダ作成" },
    { kind: "recorded", failure: "ヘルパー起動" },
  ] as const)("$kind の $failure 失敗で準備資源を閉じ、modeを送らず、同じサーバーで再開始できる", ({ kind, failure }) => Effect.gen(function* () {
    const launchFails = failure === "ヘルパー起動";
    const helper = yield* makeFakeHelpers(launchFails ? [{ connect: false }, {}] : [{}]);
    const fake = yield* makeFakeSessionSinks();
    const prep = yield* preparation(fake);
    yield* Deferred.succeed(prep.ready, undefined);
    fake.control.createDirFails = !launchFails;
    const { sessions, viewers } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), prep.layer);
    const client = yield* viewerClient();
    yield* Effect.forkChild(viewers.connect(client.socket));
    const begin = kind === "live"
      ? sessions.start(start({ audio: false, screen: false }))
      : sessions.startRecorded({ file: "/meeting.m4a", title: undefined, vocab: [], realtime: false, plan: { kind: "single", model: defaultClaude } });

    const result = yield* Effect.exit(begin);

    expect(Exit.isFailure(result)).toBe(true);
    expect(prep.state).toMatchObject({ opened: 1, closed: 1, createdDirs: 1 });
    expect(helper.calls).toHaveLength(launchFails ? 1 : 0);
    expect(fake.opened.count).toBe(0);
    expect(yield* sessions.status).toEqual({ status: "none" });
    expect(yield* client.sessionModes).toEqual([]);

    fake.control.createDirFails = false;
    yield* begin;
    expect((yield* sessions.status).status).toBe("running");
    expect(prep.state).toMatchObject({ opened: 2, closed: 1, createdDirs: 2 });
    expect(fake.opened.count).toBe(1);
    expect(yield* client.sessionModes).toEqual([false]);
    yield* sessions.stop;
    expect(yield* sessions.status).toEqual({ status: "none" });
    expect(prep.state.closed).toBe(2);
    expect(fake.opened.closed).toBe(1);
    expect(helper.calls).toHaveLength(launchFails ? 2 : 1);
    expect(yield* client.sessionModes).toEqual([false, false]);
  }).pipe(Effect.scoped));

  it.effect("取得済みの推論子の準備待ちを中断したら閉じ、会議を始めない", () => Effect.gen(function* () {
    const helper = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const prep = yield* preparation(fake);
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), prep.layer);
    const starting = yield* Effect.forkChild(sessions.start({ app: "us.zoom.xos", plan: { kind: "single", model: defaultClaude }, audio: false, screen: false, title: undefined, vocab: [] }));
    yield* settleUntil(() => prep.state.opened === 1);
    expect(prep.state.opened).toBe(1);
    yield* Fiber.interrupt(starting);
    expect(prep.state.closed).toBe(1);
    expect(helper.calls).toEqual([]);
    expect(prep.state.createdDirs).toBe(0);
    expect(fake.opened.count).toBe(0);
  }));

  // Issue #640: 開始時の語彙は open の引数へ渡す。読み取得は sink が所有する。
  it.effect("開始の要求の vocab はライブの open の引数へ渡し、空の語彙でも開始できる", () => Effect.gen(function* () {
    const withVocab = yield* makeFakeSessionSinks();
    const prepWith = yield* preparation(withVocab);
    yield* Deferred.succeed(prepWith.ready, undefined);
    const helperWith = yield* makeFakeHelpers([{}]);
    const booted = yield* bootSessions(Layer.succeed(Helpers, helperWith.helpers), prepWith.layer);
    yield* booted.sessions.start(start({ audio: false, screen: false, vocab: ["港南店", "Zendesk"] }));
    expect(withVocab.vocabAdded).toEqual([["港南店", "Zendesk"]]);
    yield* booted.closeServer();

    const without = yield* makeFakeSessionSinks();
    const prepWithout = yield* preparation(without);
    yield* Deferred.succeed(prepWithout.ready, undefined);
    const helperWithout = yield* makeFakeHelpers([{}]);
    const bootedWithout = yield* bootSessions(Layer.succeed(Helpers, helperWithout.helpers), prepWithout.layer);
    yield* bootedWithout.sessions.start(start({ audio: false, screen: false }));
    expect(without.vocabAdded).toEqual([]);
    yield* bootedWithout.closeServer();
  }));

  it.effect("音声ヘルパーを起動し直しても同じ推論子を保ち、サーバー終了で閉じる", () => Effect.gen(function* () {
    const helper = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } }, {}]);
    const fake = yield* makeFakeSessionSinks();
    const prep = yield* preparation(fake);
    yield* Deferred.succeed(prep.ready, undefined);
    const { sessions, closeServer } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), prep.layer);
    yield* sessions.start({ app: "us.zoom.xos", plan: { kind: "single", model: defaultClaude }, audio: false, screen: false, title: undefined, vocab: [] });
    helper.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "最初の発言" });
    yield* TestClock.adjust(500);
    yield* TestClock.adjust(10);
    expect(helper.calls).toHaveLength(2);
    helper.send(1, { type: "remark", track: "相手", start: 2, end: 3, text: "次の発言" });
    yield* TestClock.adjust(1);
    expect(fake.finals.map((r) => r.text)).toEqual(["最初の発言", "次の発言"]);
    expect(prep.state).toMatchObject({ opened: 1, closed: 0 });
    yield* closeServer();
    expect(prep.state.closed).toBe(1);
  }));
});

// ブラウザ側のクライアントの代わり。Viewers.connect に渡す Socket で、届いたフレームを溜める（server/test/ws.test.ts の client と同じ作り）
const viewerClient = Effect.fnUntraced(function* () {
  const frames = yield* Queue.make<unknown>();
  const modes = yield* Ref.make<ReadonlyArray<boolean>>([]);
  const closed = yield* Deferred.make<never, Socket.SocketError>();
  const write: Socket.Writer["write"] = (chunk) => Effect.gen(function* () {
    if (Socket.isCloseEvent(chunk)) return;
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const frame = JSON.parse(text);
    yield* Queue.offer(frames, frame);
    if (frame.type === "session-mode") yield* Ref.update(modes, (current) => [...current, frame.local]);
  });
  const socket = Socket.Socket.of({
    [Socket.TypeId]: Socket.TypeId,
    reader: Effect.succeed({ pull: Deferred.await(closed), upgrade: Socket.SocketUpgradeError.unsupported }),
    writer: Effect.acquireRelease(
      Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) }),
      () => Effect.void,
    ),
  });
  // 届いた状態のフレーム（type が intake のもの）の status を、届いた順に返す
  const intakeStatuses = Effect.gen(function* () {
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow; // 時計を進めずに、配信のファイバーへ処理を渡し切る
    const received: unknown[] = [];
    while ((yield* Queue.size(frames)) > 0) received.push(yield* Queue.take(frames));
    return received.filter((f): f is { type: "intake"; status: string } => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "intake").map((f) => f.status);
  });
  // 届いたフレームのうち、type が screen-notice のものの text を、届いた順に返す
  const screenNotices = Effect.gen(function* () {
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    const received: unknown[] = [];
    while ((yield* Queue.size(frames)) > 0) received.push(yield* Queue.take(frames));
    return received.filter((f): f is { type: "screen-notice"; text: string | null } => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "screen-notice").map((f) => f.text);
  });
  // 届いたフレームのうち、type が tap-notice のものの text を、届いた順に返す
  const tapNotices = Effect.gen(function* () {
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    const received: unknown[] = [];
    while ((yield* Queue.size(frames)) > 0) received.push(yield* Queue.take(frames));
    return received.filter((f): f is { type: "tap-notice"; text: string | null } => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "tap-notice").map((f) => f.text);
  });
  // 届いたフレームのうち、type が self-pause のものの paused を、届いた順に返す（Issue #1069）
  const selfPauses = Effect.gen(function* () {
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    const received: unknown[] = [];
    while ((yield* Queue.size(frames)) > 0) received.push(yield* Queue.take(frames));
    return received.filter((f): f is { type: "self-pause"; paused: boolean } => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "self-pause").map((f) => f.paused);
  });
  // 届いたフレームのうち、type が self-pause のものを、届いた順にそのまま返す（Issue #1071。休止中の理由を確かめる）
  const selfPauseFrames = Effect.gen(function* () {
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    const received: unknown[] = [];
    while ((yield* Queue.size(frames)) > 0) received.push(yield* Queue.take(frames));
    return received.filter((f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "self-pause");
  });
  const sessionModes = Effect.gen(function* () {
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    return yield* Ref.get(modes);
  });
  return { socket, intakeStatuses, screenNotices, tapNotices, selfPauses, selfPauseFrames, sessionModes };
});

// Console.error に渡された行を、Node の console と同じ形（引数を空白で連ねて末尾に改行 1 つ）で集める Console。
// note は Console.error を呼ぶので、標準エラーに出るバイト列（改行の数）をここで確かめられる
const collectingStderr = () => {
  const stderr: string[] = [];
  const service: Console.Console = { ...console, error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); } };
  return { stderr, service };
};

const withStderr = <A, E, R>(body: (stderr: string[]) => Effect.Effect<A, E, R>) => {
  const { stderr, service } = collectingStderr();
  return Effect.provideService(Effect.suspend(() => body(stderr)), Console.Console, service);
};

const start = (input: Partial<SessionStart> = {}): SessionStart => ({ app: "us.zoom.xos", title: undefined, audio: true, screen: true, vocab: [], plan: { kind: "single", model: defaultClaude }, ...input });

describe("ブラウザの会議タブの端末通知", () => {
  const warning = "会議のタブが前面にありません。共有画面を取り込めていません（マップは別のウィンドウで開いてください）\n";
  const restored = "会議のタブが前面に戻りました。共有画面の取り込みを再開しました\n";
  const boot = Effect.fnUntraced(function* (attempts: AttemptScript[]) {
    const helpers = yield* makeFakeHelpers(attempts);
    const fake = yield* makeFakeSessionSinks();
    const server = yield* bootSessions(Layer.succeed(Helpers, helpers.helpers), Layer.succeed(SessionSinks, fake.sinks));
    const screen = Effect.fnUntraced(function* (image: string | null, at: number, attempt: number) {
      const count = fake.screens.length;
      helpers.send(attempt, { type: "screen", start: at, image, lines: image === null ? [] : ["会議資料"] });
      yield* TestClock.adjust(0);
      expect(fake.screens).toHaveLength(count + 1);
    });
    return { helpers, fake, screen, ...server };
  });

  it.effect.each([0, 60])("受信60秒の画像start=%sでは過去画像だけを通知から除き、保存には渡す", (imageStart) => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, helpers, fake, screen } = yield* boot([{}]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    yield* TestClock.adjust(1_000);
    yield* screen("/9j/2Q==", 1, 0);
    yield* TestClock.adjust(1_000);
    yield* screen("/9j/2Q==", 2, 0);
    yield* TestClock.adjust(1_000);
    helpers.send(0, { type: "screen", start: 3, image: null, meetingTabTitle: "Gmail" });
    yield* TestClock.adjust(0);
    expect(fake.screens).toHaveLength(3);
    yield* TestClock.adjust(57_000);
    yield* screen("/9j/2Q==", imageStart, 0);
    helpers.send(0, { type: "screen", start: 3, image: null, meetingTabTitle: "Gmail" });
    yield* TestClock.adjust(0);
    expect(fake.screens).toHaveLength(5);
    expect(fake.screens[3]).toEqual({ start: imageStart, image: Uint8Array.from([255, 216, 255, 217]), lines: ["会議資料"] });
    yield* TestClock.adjust(2_999);
    expect(stderr).toEqual([]);
    yield* TestClock.adjust(1);
    const expected = imageStart === 0 ? ["会議のタブ（Gmail）が前面にありません。共有画面を取り込めていません（マップは別のウィンドウで開いてください）\n"] : [];
    expect(stderr).toEqual(expected);
    yield* TestClock.adjust(60_000);
    expect(stderr).toEqual(expected);
  }).pipe(Effect.scoped)));

  it.effect("同時刻の復帰画像は受理し、古いnullは新たな不在待機を始めない", () => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, screen } = yield* boot([{}]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    yield* screen(null, 3, 0);
    yield* TestClock.adjust(60_000);
    expect(stderr).toEqual([warning]);
    yield* screen("/9j/2Q==", 3, 0);
    expect(stderr).toEqual([warning, restored]);
    yield* screen(null, 0, 0);
    yield* TestClock.adjust(60_000);
    expect(stderr).toEqual([warning, restored]);
    yield* screen(null, 3, 0);
    yield* TestClock.adjust(60_000);
    expect(stderr).toEqual([warning, restored, warning]);
  }).pipe(Effect.scoped)));

  it.effect("screen-offで時刻の比較も初期化し、その後の不在を新しく監視する", () => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, helpers, fake, screen } = yield* boot([{}]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    yield* screen(null, 100, 0);
    yield* TestClock.adjust(59_000);
    helpers.send(0, { type: "screen-off", start: 101, reason: "許可なし" });
    yield* TestClock.adjust(0);
    expect(fake.screenOffs).toEqual([{ start: 101, reason: "許可なし" }]);
    const before = [...stderr];
    yield* screen(null, 0, 0);
    yield* TestClock.adjust(59_999);
    expect(stderr).toEqual(before);
    yield* TestClock.adjust(1);
    expect(stderr).toEqual([...before, warning]);
  }).pipe(Effect.scoped)));

  it.effect("受信JSONの会議タブの題名を不在通知に載せ、復帰後は覚え直した題名を使う", () => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, helpers, fake, screen } = yield* boot([{}]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    for (const [index, title] of ["Gmail - Inbox", "配信 - YouTube"].entries()) {
      if (index > 0) yield* screen("/9j/2Q==", 63, 0);
      const count = fake.screens.length;
      helpers.send(0, { type: "screen", start: 62 + index, image: null, meetingTabTitle: title });
      yield* TestClock.adjust(0);
      expect(fake.screens).toHaveLength(count + 1);
      const before = [...stderr];
      yield* TestClock.adjust(59_999);
      expect(stderr).toEqual(before);
      yield* TestClock.adjust(1);
      expect(stderr).toEqual([...before, `会議のタブ（${title}）が前面にありません。共有画面を取り込めていません（マップは別のウィンドウで開いてください）\n`]);
    }
    expect(stderr).toHaveLength(3);
    expect(stderr[1]).toBe(restored);
  }).pipe(Effect.scoped)));

  it.effect("既知の題名の通知後でも、題名のない次の不在イベントは従来の文面に戻る", () => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, helpers, fake, screen } = yield* boot([{}]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    helpers.send(0, { type: "screen", start: 0, image: null, meetingTabTitle: "配信 - YouTube" });
    yield* TestClock.adjust(0);
    expect(fake.screens).toHaveLength(1);
    yield* TestClock.adjust(60_000);
    const titledWarning = "会議のタブ（配信 - YouTube）が前面にありません。共有画面を取り込めていません（マップは別のウィンドウで開いてください）\n";
    expect(stderr).toEqual([titledWarning]);
    yield* screen("/9j/2Q==", 61, 0);
    yield* screen(null, 62, 0);
    yield* TestClock.adjust(60_000);
    expect(stderr).toEqual([titledWarning, restored, warning]);
  }).pipe(Effect.scoped)));

  it.effect.each([
    "com.google.Chrome", "com.microsoft.edgemac", "com.apple.Safari",
    "company.thebrowser.Browser", "com.brave.Browser", "org.mozilla.firefox",
  ])("%s は最初の null の受信から60秒で一行だけ通知し、後続イベントを必要としない", (app) => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, viewers, screen, fake } = yield* boot([{}]);
    const watcher = yield* viewerClient();
    yield* Effect.forkChild(viewers.connect(watcher.socket));
    yield* sessions.start(start({ app }));
    yield* TestClock.adjust(300_000);
    expect(stderr).toEqual([]);
    yield* screen("/9j/2Q==", 1, 0);
    yield* screen(null, 999_999, 0);
    yield* TestClock.adjust(30_000);
    yield* screen(null, 0, 0);
    yield* TestClock.adjust(29_999);
    expect(stderr).toEqual([]);
    yield* TestClock.adjust(1);
    expect(stderr).toEqual([warning]);
    yield* screen(null, 2, 0);
    yield* TestClock.adjust(180_000);
    expect(stderr).toEqual([warning]);
    expect(fake.screens).toEqual([
      { start: 1, image: Uint8Array.from([255, 216, 255, 217]), lines: ["会議資料"] },
      { start: 999_999, image: null, lines: [] },
      { start: 0, image: null, lines: [] },
      { start: 2, image: null, lines: [] },
    ]);
    expect(yield* watcher.screenNotices).toEqual([]);
    expect(fake.appended).toEqual([]);
    expect((yield* sessions.status).status).toBe("running");
  }).pipe(Effect.scoped)));

  it.effect("同じセッションで警告後の復帰を一度知らせ、次の離脱から60秒で再通知する", () => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, screen } = yield* boot([{}]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    yield* screen(null, 0, 0);
    yield* TestClock.adjust(60_000);
    expect(stderr).toEqual([warning]);
    yield* screen("/9j/2Q==", 61, 0);
    yield* screen("/9j/2Q==", 62, 0);
    expect(stderr).toEqual([warning, restored]);
    yield* screen(null, 63, 0);
    yield* TestClock.adjust(59_999);
    expect(stderr).toEqual([warning, restored]);
    yield* TestClock.adjust(1);
    expect(stderr).toEqual([warning, restored, warning]);
  }).pipe(Effect.scoped)));

  it.effect("60秒未満で戻ると無通知で、取り消した期限が次の離脱を早めない", () => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, screen } = yield* boot([{}]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    yield* screen(null, 0, 0);
    yield* TestClock.adjust(59_000);
    yield* screen("/9j/2Q==", 59, 0);
    yield* TestClock.adjust(2_000);
    expect(stderr).toEqual([]);
    yield* screen(null, 61, 0);
    yield* TestClock.adjust(59_999);
    expect(stderr).toEqual([]);
    yield* TestClock.adjust(1);
    expect(stderr).toEqual([warning]);
  }).pipe(Effect.scoped)));

  it.effect.each([
    { app: "us.zoom.xos", screen: true },
    { app: "com.google.Chrome", screen: false },
  ])("$app / screen:$screen は画面イベントが届いても端末通知しない", (input) => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, screen } = yield* boot([{}]);
    yield* sessions.start(start(input));
    yield* screen(null, 0, 0);
    yield* TestClock.adjust(120_000);
    yield* screen("/9j/2Q==", 120, 0);
    expect(stderr).toEqual([]);
  }).pipe(Effect.scoped)));

  it.effect.each(["stop", "server", "screen-off"] as const)("待機中の %s で古い警告を取り消す", (end) => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, closeServer, helpers, fake, screen } = yield* boot([{}]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    yield* screen(null, 0, 0);
    yield* TestClock.adjust(59_000);
    if (end === "stop") {
      yield* sessions.stop;
      expect(helpers.stops).toEqual([0]);
    } else if (end === "server") {
      yield* closeServer();
      expect(helpers.stops).toEqual([0]);
    } else {
      helpers.send(0, { type: "screen-off", start: 59, reason: "許可なし" });
      yield* TestClock.adjust(0);
      expect(fake.screenOffs).toEqual([{ start: 59, reason: "許可なし" }]);
    }
    yield* TestClock.adjust(120_000);
    expect(stderr).toEqual([]);
  }).pipe(Effect.scoped)));

  it.effect("stop がヘルパー終了を待つ間も警告せず、その間の null で監視を再開しない", () => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, helpers, screen } = yield* boot([{ stopDelayMs: 120_000 }]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    yield* screen(null, 0, 0);
    yield* TestClock.adjust(59_000);
    const stopping = yield* Effect.forkChild(sessions.stop);
    yield* TestClock.adjust(0);
    expect(helpers.stops).toEqual([0]);
    yield* screen(null, 59, 0);
    yield* TestClock.adjust(120_000);
    yield* Fiber.join(stopping);
    expect(stderr).toEqual([]);
  }).pipe(Effect.scoped)));

  it.effect("ヘルパー終了で待機を取り消し、再接続の画像を復帰通知にせず新たな離脱を監視する", () => withStderr((stderr) => Effect.gen(function* () {
    const { sessions, helpers, screen } = yield* boot([
      { unexpectedExit: { afterMs: 59_000, exit: { code: 1, signal: null } } }, {},
    ]);
    yield* sessions.start(start({ app: "com.google.Chrome" }));
    yield* screen(null, 100, 0);
    yield* TestClock.adjust(59_000);
    expect(helpers.calls).toHaveLength(2);
    const restartOutput = [...stderr];
    expect(restartOutput.join("")).toContain("ヘルパーを起動し直しました");
    yield* screen("/9j/2Q==", 59, 1);
    yield* TestClock.adjust(2_000);
    expect(stderr).toEqual(restartOutput);
    yield* screen(null, 61, 1);
    yield* TestClock.adjust(60_000);
    expect(stderr).toEqual([...restartOutput, warning]);
  }).pipe(Effect.scoped)));
});

describe("依存導入の予約", () => {
  it.effect("複数の導入の全予約が解放されるまで開始せず、会議中は予約を拒否する", () => Effect.gen(function* () {
    const helper = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), Layer.succeed(SessionSinks, fake.sinks));
    const scopes = [yield* Scope.make(), yield* Scope.make()];
    for (const scope of scopes) yield* sessions.reserveDeps.pipe(Scope.provide(scope));
    expect(Exit.isFailure(yield* Effect.exit(sessions.start(start())))).toBe(true);
    expect(helper.calls).toHaveLength(0);
    yield* Scope.close(scopes[0]!, Exit.void);
    expect(Exit.isFailure(yield* Effect.exit(sessions.start(start())))).toBe(true);
    yield* Scope.close(scopes[1]!, Exit.void);
    yield* sessions.start(start());
    expect(helper.calls).toHaveLength(1);
    const refused = yield* Effect.scoped(Effect.exit(sessions.reserveDeps));
    expect(Exit.isFailure(refused)).toBe(true);
    yield* sessions.stop;
    yield* Effect.scoped(sessions.reserveDeps);
  }).pipe(Effect.scoped));

  it.effect("導入の中断時も後片付け中は開始を拒否し、後片付け後に予約を解放する", () => Effect.gen(function* () {
    const helper = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), Layer.succeed(SessionSinks, fake.sinks));
    const entered = yield* Deferred.make<void>();
    const cleaning = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const interrupting = yield* Effect.gen(function* () {
      const installation = yield* Effect.scoped(Effect.gen(function* () {
        yield* sessions.reserveDeps;
        yield* Effect.addFinalizer(() => Effect.andThen(Deferred.succeed(cleaning, undefined), Deferred.await(release)));
        yield* Deferred.succeed(entered, undefined);
        return yield* Effect.never;
      })).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const interrupting = yield* Fiber.interrupt(installation).pipe(Effect.forkChild);
      yield* Deferred.await(cleaning);
      expect(Exit.isFailure(yield* Effect.exit(sessions.start(start())))).toBe(true);
      expect(helper.calls).toHaveLength(0);
      return interrupting;
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    yield* Fiber.join(interrupting);
    yield* sessions.start(start());
    expect(helper.calls).toHaveLength(1);
    yield* sessions.stop;
  }).pipe(Effect.scoped));
});

describe("Sessions（偽の Helpers・SessionSinks・TestClock）", () => {
  it.effect("apps は Helpers の一覧をそのまま返す（CT-SESSIONS-ONE）", () =>
    Effect.gen(function* () {
      const fakeHelpers = yield* makeFakeHelpers([]);
      const fakeSinks = yield* makeFakeSessionSinks();
      const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));

      expect(yield* sessions.apps).toEqual(APPS);
    }));

  it.effect("start は SessionSinks を 1 回だけ開き、stop で閉じる。次のセッションは新しく開く（CT-SINK-SCOPE）", () =>
    Effect.gen(function* () {
      const fakeHelpers = yield* makeFakeHelpers([{}, {}]);
      const fakeSinks = yield* makeFakeSessionSinks();
      const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
      expect(fakeSinks.opened).toMatchObject({ count: 0, closed: 0 }); // 開始していなければ開かない

      yield* sessions.start(start());
      expect(fakeSinks.opened).toMatchObject({ count: 1, closed: 0 }); // 会議中は閉じない

      yield* sessions.stop;
      expect(fakeSinks.opened).toMatchObject({ count: 1, closed: 1 });

      yield* sessions.start(start());
      yield* sessions.stop;
      expect(fakeSinks.opened).toMatchObject({ count: 2, closed: 2 });
    }));

  it.effect("セッションが無いまま server scope が終わっても、SessionSinks は開かれない", () =>
    Effect.gen(function* () {
      const fakeHelpers = yield* makeFakeHelpers([]);
      const fakeSinks = yield* makeFakeSessionSinks();
      const { closeServer } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));

      yield* closeServer();

      expect(fakeSinks.opened).toMatchObject({ count: 0, closed: 0 });
    }));

  it.effect("進行中に server scope が終わると、SessionSinks を閉じる（CT-CLOSE-ONLY-INTERRUPT）", () =>
    Effect.gen(function* () {
      const fakeHelpers = yield* makeFakeHelpers([{}]);
      const fakeSinks = yield* makeFakeSessionSinks();
      const { sessions, closeServer } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
      yield* sessions.start(start());
      expect(fakeSinks.opened).toMatchObject({ count: 1, closed: 0 });

      yield* closeServer();

      expect(fakeSinks.opened).toMatchObject({ count: 1, closed: 1 });
    }));

  describe("ヘルパーのイベントの配線（CT-DECODE-WIRED / CT-DECODE-UNKNOWN / CT-DECODE-BROKEN）", () => {
    it.effect("remark は sink.final へ、partial は sink.partial へ届き、origin は次の起動の argv に渡る", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}, {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));

        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "origin", hostTime: "9007199254740993" });
        fakeHelpers.send(0, { type: "partial", track: "相手", start: 0, end: 1, text: "とちゅう" });
        fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "かくてい" });
        yield* TestClock.adjust(1);

        expect(fakeSinks.partials).toContainEqual({ track: "相手", text: "とちゅう" });
        expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "かくてい" });
        // 原点が次の起動し直しの argv に渡ることは「argv（--origin・--audio-index）」の describe で確かめる
      }));

    // Issue #639: words 付きの JSON はそのまま sink へ届く。words の無い JSON も今までどおり届く
    it.effect("words 付きの remark・partial は words のまま sink へ届き、words の無いイベントには words が付かない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const partialWords = [{ surface: "とちゅう", romaji: "tochū", location: 0, length: 4 }];
        const finalWords = [{ surface: "かくてい", romaji: "kakutei", location: 0, length: 4 }];

        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "partial", track: "相手", start: 0, end: 1, text: "とちゅう", words: partialWords });
        fakeHelpers.send(0, { type: "partial", track: "相手", start: 5, end: 6, text: "むき" });
        fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "かくてい", words: finalWords });
        fakeHelpers.send(0, { type: "remark", track: "相手", start: 8, end: 9, text: "むき" });
        yield* TestClock.adjust(1);

        expect(fakeSinks.words.partial).toEqual([partialWords, undefined]);
        expect(fakeSinks.words.final).toEqual([finalWords, undefined]);
        expect(fakeSinks.finals.map((r) => r.text)).toEqual(["かくてい", "むき"]);
      }));

  });

  // 共有画面の変化（Issue #278）。screen は sink.screen（Session.pushScreen への口）へ届く。原点・取り込みの状態・ログには触れない
  describe("共有画面の配線", () => {

    it.effect("screen は start とバイト列のまま sink.screen へ届く。image が null でも届く", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

        fakeHelpers.send(0, { type: "screen", start: 1.5, image: Buffer.from(jpeg).toString("base64") });
        fakeHelpers.send(0, { type: "screen", start: 4, image: null });
        yield* TestClock.adjust(1);

        expect(fakeSinks.screens).toHaveLength(2);
        expect(fakeSinks.screens[0]!.start).toBe(1.5);
        expect([...fakeSinks.screens[0]!.image!]).toEqual([...jpeg]);
        expect(fakeSinks.screens[1]).toEqual({ start: 4, image: null });
      }));

    // Issue #643: helper の screen の lines は、読み取った文字列のまま sink.screen へ届く。古い helper（lines なし）は lines を付けずに届く
    it.effect("screen の lines は sink.screen へそのまま届く。空の配列は空のまま、lines が無い screen は lines なしで届く", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        fakeHelpers.send(0, { type: "screen", start: 1, image: "/9j/2Q==", lines: ["港南店", "Zendesk"] });
        fakeHelpers.send(0, { type: "screen", start: 2, image: "/9j/2Q==", lines: [] });
        fakeHelpers.send(0, { type: "screen", start: 3, image: "/9j/2Q==" });
        fakeHelpers.send(0, { type: "screen", start: 4, image: null });
        yield* TestClock.adjust(1);

        expect(fakeSinks.screens.map((s) => s.lines)).toEqual([["港南店", "Zendesk"], [], undefined, undefined]);
        expect("lines" in fakeSinks.screens[2]!).toBe(false);
        expect((yield* sessions.status).status).toBe("running");
      }));

    it.effect("screen は取り込みの記録（appendLog）を書かず、発言や途中結果にも流れず、セッションは running のまま", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        fakeHelpers.send(0, { type: "screen", start: 1, image: "/9j/2Q==" });
        fakeHelpers.send(0, { type: "screen", start: 2, image: null });
        yield* TestClock.adjust(1);

        expect(fakeSinks.screens).toHaveLength(2); // 届いたうえで
        expect(fakeSinks.appended).toEqual([]);
        expect(fakeSinks.finals).toEqual([]);
        expect(fakeSinks.partials).toEqual([]);
        expect((yield* sessions.status).status).toBe("running");
      }));

    it.effect("壊れた screen は今の文面で stderr に 1 行出して読み飛ばし、sink.screen には届かず、続く発言は届く", () =>
      withStderr((stderr) =>
        Effect.gen(function* () {
          const fakeHelpers = yield* makeFakeHelpers([{}]);
          const fakeSinks = yield* makeFakeSessionSinks();
          const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
          yield* sessions.start(start());

          fakeHelpers.send(0, { type: "screen", start: 1, image: "%%%" }); // base64 として不正
          fakeHelpers.send(0, { type: "screen", start: 2 }); // image のキーが無い
          fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "つづく" });
          yield* TestClock.adjust(1);

          expect(stderr.filter((s) => s.includes("ヘルパーのイベントを読み飛ばしました"))).toHaveLength(2);
          expect(fakeSinks.screens).toEqual([]);
          expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "つづく" }); // セッションは止まらず続く
          expect((yield* sessions.status).status).toBe("running");
        })));
  });

  describe("相手の音声が届かない知らせ（tap-silent。Issue #863）", () => {
    const boot = (attempts: AttemptScript[]) =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers(attempts);
        const fakeSinks = yield* makeFakeSessionSinks();
        const booted = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        return { fakeHelpers, fakeSinks, ...booted };
      });

    it.effect("tap-silent は start のまま log（sink）へ 1 行残り、画面へ固定の一文のフレームが届く。セッションは running のまま", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "tap-silent", start: 10.5 });
        yield* TestClock.adjust(1);

        expect(fakeSinks.appended).toEqual([{ type: "tap-silent", start: 10.5 }]);
        expect(yield* watcher.tapNotices).toEqual([TAP_NOTICE_TEXT]);
        expect((yield* sessions.status).status).toBe("running");
      }));

    it.effect("一文は 10 秒では消えない（時計を進めても null は届かず、後からつないだブラウザにも出る）", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([{}]);
        const early = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(early.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "tap-silent", start: 10 });
        yield* TestClock.adjust(1);
        expect(yield* early.tapNotices).toEqual([TAP_NOTICE_TEXT]);

        yield* TestClock.adjust(60_000);
        expect(yield* early.tapNotices).toEqual([]);

        const late = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(late.socket));
        expect(yield* late.tapNotices).toEqual([TAP_NOTICE_TEXT]);
      }));

    it.effect("同じセッションで、tap-silent の後に新しい origin が届くと、一文を消すフレーム（null）が届き、その後につないだブラウザには解除のフレームだけが届く", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "tap-silent", start: 10 });
        yield* TestClock.adjust(1);
        expect(yield* watcher.tapNotices).toEqual([TAP_NOTICE_TEXT]);

        fakeHelpers.send(0, { type: "origin", hostTime: "1" });
        yield* TestClock.adjust(1);
        expect(yield* watcher.tapNotices).toEqual([null]);

        const late = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(late.socket));
        expect(yield* late.tapNotices).toEqual([null]);
      }));

    it.effect("起動し直した回でも tap-silent がまた届けば、一文を出し直し、ログにも届くたびに残る", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([
          { unexpectedExit: { afterMs: 20_000, exit: { code: 1, signal: null } } },
          {},
        ]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "tap-silent", start: 10 });
        yield* TestClock.adjust(1);
        expect(yield* watcher.tapNotices).toEqual([TAP_NOTICE_TEXT]);

        yield* TestClock.adjust(20_000);
        yield* TestClock.adjust(1_000);
        yield* TestClock.adjust(10);
        expect(fakeHelpers.calls).toHaveLength(2);
        fakeHelpers.send(1, { type: "origin", hostTime: "2" });
        fakeHelpers.send(1, { type: "tap-silent", start: 10 });
        yield* TestClock.adjust(1);

        expect(yield* watcher.tapNotices).toEqual([null, TAP_NOTICE_TEXT]);
        expect(fakeSinks.appended.filter((e) => e.type === "tap-silent")).toHaveLength(2);
      }));

    it.effect("stop で一文を解除し、stop 後につないだブラウザには null だけが届く", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "tap-silent", start: 10 });
        yield* TestClock.adjust(1);
        expect(yield* watcher.tapNotices).toEqual([TAP_NOTICE_TEXT]);

        yield* sessions.stop;
        expect(yield* watcher.tapNotices).toEqual([null]);

        const after = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(after.socket));
        expect(yield* after.tapNotices).toEqual([null]);
      }));

    it.effect("tap-silent は共有画面の知らせ（screen-notice）のフレームを出さず、screen-off のログ・状態にも触れない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "tap-silent", start: 10 });
        yield* TestClock.adjust(1);
        expect(fakeSinks.screenOffs).toEqual([]);
        const frames = yield* watcher.screenNotices;
        expect(frames).toEqual([]);
      }));

    it.effect("start が数でない壊れた tap-silent は sink にも画面にも届かない", () =>
      withStderr(() =>
        Effect.gen(function* () {
          const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
          const watcher = yield* viewerClient();
          yield* Effect.forkChild(viewers.connect(watcher.socket));
          yield* sessions.start(start());
          fakeHelpers.send(0, { type: "tap-silent", start: "10" });
          yield* TestClock.adjust(1);
          expect(fakeSinks.appended).toEqual([]);
          expect(yield* watcher.tapNotices).toEqual([]);
        })));
  });

  describe("自分の休止（self-pause。Issue #1069）", () => {
    const boot = (attempts: AttemptScript[]) =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers(attempts);
        const fakeSinks = yield* makeFakeSessionSinks();
        const booted = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        return { fakeHelpers, fakeSinks, ...booted };
      });
    const pauseEvent = (paused: boolean, startSeconds: number, reason: string = "手動") => ({ type: "self-pause", paused, reason, start: startSeconds });
    const stateEvent = (manual: string, basis: string, lastKnown: string, idleFor: number) => ({ type: "self-pause-state", manual, basis, lastKnown, idleFor });
    // 次の起動の argv のうち、自分の休止の引き継ぎの引数だけ（フラグと値を、並んだまま）
    const carryOverArgs = (argv: ReadonlyArray<string>) => argv.flatMap((arg, i) => (arg.startsWith("--self-") ? [arg, argv[i + 1] ?? ""] : []));
    const selfLogs = (appended: ReadonlyArray<LogLineEvent>) => appended.filter((e) => e.type === "self-paused" || e.type === "self-resumed");

    it.effect("setSelfPause は動いている起動回の helper へ指示を送る。値は呼んだとおり（true → false）", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([{}]);
        yield* sessions.start(start());

        yield* sessions.setSelfPause(true);
        expect(fakeHelpers.sentPauses).toEqual([{ attempt: 0, paused: true }]);
        yield* sessions.setSelfPause(false);
        expect(fakeHelpers.sentPauses).toEqual([{ attempt: 0, paused: true }, { attempt: 0, paused: false }]);
      }));

    it.effect("helper の休止イベントは self-paused / self-resumed の組として start・reason のままログ（sink）に残り、画面へフレームが届く。セッションは running のまま", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());

        fakeHelpers.send(0, pauseEvent(true, 12.5));
        yield* TestClock.adjust(1);
        fakeHelpers.send(0, pauseEvent(false, 30));
        yield* TestClock.adjust(1);

        expect(selfLogs(fakeSinks.appended)).toEqual([
          { type: "self-paused", reason: "手動", start: 12.5 },
          { type: "self-resumed", reason: "手動", start: 30 },
        ]);
        expect(yield* watcher.selfPauses).toEqual([true, false]);
        expect((yield* sessions.status).status).toBe("running");
      }));

    it.effect("同じ paused のイベントが重ねて届いても、ログもフレームも変わった 1 回だけ（組が崩れない）", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());

        fakeHelpers.send(0, pauseEvent(true, 1));
        fakeHelpers.send(0, pauseEvent(true, 2));
        yield* TestClock.adjust(1);
        expect(selfLogs(fakeSinks.appended)).toEqual([{ type: "self-paused", reason: "手動", start: 1 }]);
        expect(yield* watcher.selfPauses).toEqual([true]);

        // 休止していない状態への「再開」も、変わっていなければ何も書かない
        fakeHelpers.send(0, pauseEvent(false, 3));
        fakeHelpers.send(0, pauseEvent(false, 4));
        yield* TestClock.adjust(1);
        expect(selfLogs(fakeSinks.appended).map((e) => e.type)).toEqual(["self-paused", "self-resumed"]);
        expect(yield* watcher.selfPauses).toEqual([false]);
      }));

    it.effect("休止していない状態で最初に届いた paused:false は何も変えない（ログもフレームもなし）", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, pauseEvent(false, 1));
        yield* TestClock.adjust(1);

        expect(selfLogs(fakeSinks.appended)).toEqual([]);
        expect(yield* watcher.selfPauses).toEqual([]);
      }));

    it.effect("休止中に後からつないだ画面にも休止のフレームが届く。再開した後につないだ画面には false が届く", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([{}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, pauseEvent(true, 5));
        yield* TestClock.adjust(1);

        const late = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(late.socket));
        expect(yield* late.selfPauses).toEqual([true]);

        fakeHelpers.send(0, pauseEvent(false, 9));
        yield* TestClock.adjust(1);
        expect(yield* late.selfPauses).toEqual([false]);

        const after = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(after.socket));
        expect(yield* after.selfPauses).toEqual([false]);
      }));

    it.effect("stop で休止を解除するフレーム（paused:false）が届き、その後につないだ画面にも届く", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, pauseEvent(true, 5));
        yield* TestClock.adjust(1);
        expect(yield* watcher.selfPauses).toEqual([true]);

        yield* sessions.stop;
        expect(yield* watcher.selfPauses).toEqual([false]);

        const after = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(after.socket));
        expect(yield* after.selfPauses).toEqual([false]);
      }));

    it.effect("壊れた self-pause（paused が真偽値でない・reason が手動・自動・判定できないのどれでもない・start が数でない）はログにも画面にも届かない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "self-pause", paused: "true", reason: "手動", start: 1 });
        fakeHelpers.send(0, { type: "self-pause", paused: true, reason: "不明", start: 1 });
        fakeHelpers.send(0, { type: "self-pause", paused: true, start: 1 });
        fakeHelpers.send(0, { type: "self-pause", paused: true, reason: "手動", start: "1" });
        yield* TestClock.adjust(1);

        expect(selfLogs(fakeSinks.appended)).toEqual([]);
        expect(yield* watcher.selfPauseFrames).toEqual([]);
      }));

    it.effect("自動・手動・判定できないの理由は、それぞれ log.jsonl の reason に残り、self-paused / self-resumed の組は崩れない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions } = yield* boot([{}]);
        yield* sessions.start(start());

        fakeHelpers.send(0, pauseEvent(true, 3, "自動"));
        yield* TestClock.adjust(1);
        fakeHelpers.send(0, pauseEvent(false, 4, "判定できない"));
        yield* TestClock.adjust(1);
        fakeHelpers.send(0, pauseEvent(true, 5, "手動"));
        yield* TestClock.adjust(1);
        fakeHelpers.send(0, pauseEvent(false, 6, "自動"));
        yield* TestClock.adjust(1);

        expect(selfLogs(fakeSinks.appended)).toEqual([
          { type: "self-paused", reason: "自動", start: 3 },
          { type: "self-resumed", reason: "判定できない", start: 4 },
          { type: "self-paused", reason: "手動", start: 5 },
          { type: "self-resumed", reason: "自動", start: 6 },
        ]);
      }));

    it.effect("休止の一言のフレームは、休止中は理由（手動 / 自動）を持ち、再開では paused:false だけを送る", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());

        fakeHelpers.send(0, pauseEvent(true, 1, "自動"));
        yield* TestClock.adjust(1);
        fakeHelpers.send(0, pauseEvent(false, 2, "自動"));
        yield* TestClock.adjust(1);
        fakeHelpers.send(0, pauseEvent(true, 3, "手動"));
        yield* TestClock.adjust(1);
        fakeHelpers.send(0, pauseEvent(false, 4, "判定できない"));
        yield* TestClock.adjust(1);

        expect(yield* watcher.selfPauseFrames).toEqual([
          { type: "self-pause", paused: true, reason: "自動" },
          { type: "self-pause", paused: false },
          { type: "self-pause", paused: true, reason: "手動" },
          { type: "self-pause", paused: false },
        ]);
      }));

    it.effect("休止中に理由だけが変わったとき（手動の休止が外れて自動の休止になる）は、フレームだけ置き換え、ログは書かない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());

        fakeHelpers.send(0, pauseEvent(true, 1, "手動"));
        yield* TestClock.adjust(1);
        fakeHelpers.send(0, pauseEvent(true, 2, "自動"));
        yield* TestClock.adjust(1);
        // 理由が同じ重ねての報告は、何も送らない
        fakeHelpers.send(0, pauseEvent(true, 3, "自動"));
        yield* TestClock.adjust(1);

        expect(selfLogs(fakeSinks.appended)).toEqual([{ type: "self-paused", reason: "手動", start: 1 }]);
        expect(yield* watcher.selfPauseFrames).toEqual([
          { type: "self-pause", paused: true, reason: "手動" },
          { type: "self-pause", paused: true, reason: "自動" },
        ]);

        // 休止中に後からつないだ画面には、最新の理由が届く
        const late = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(late.socket));
        expect(yield* late.selfPauseFrames).toEqual([{ type: "self-pause", paused: true, reason: "自動" }]);
      }));

    const relaunchAfter = (ms: number) => Effect.andThen(TestClock.adjust(ms), TestClock.adjust(10));

    it.effect("helper が知らせた引き継ぎの状態（self-pause-state）は、起動し直した新しい起動回の引数になる。--self-paused は渡さない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([{ unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } }, {}]);
        yield* sessions.start(start());
        expect(carryOverArgs(fakeHelpers.calls[0] ?? [])).toEqual([]);

        fakeHelpers.send(0, pauseEvent(true, 1));
        fakeHelpers.send(0, stateEvent("pause", "using", "idle", 1.5));
        yield* TestClock.adjust(1);
        yield* relaunchAfter(500);

        expect(fakeHelpers.calls).toHaveLength(2);
        expect(carryOverArgs(fakeHelpers.calls[1] ?? [])).toEqual([
          "--self-manual", "pause", "--self-basis", "using", "--self-last-known", "idle", "--self-idle-for", "1.5",
        ]);
        expect(fakeHelpers.calls[1]).not.toContain("--self-paused");
      }));

    it.effect("引き継ぎの状態は最新の 1 件だけが次の起動の引数になり、既定の値（手動なし・基準なし・読めた値なし・待ち 0）の引数は渡さない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([{ unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } }, {}]);
        yield* sessions.start(start());

        fakeHelpers.send(0, stateEvent("pause", "using", "using", 0));
        fakeHelpers.send(0, stateEvent("none", "unknown", "idle", 2));
        yield* TestClock.adjust(1);
        yield* relaunchAfter(500);

        expect(carryOverArgs(fakeHelpers.calls[1] ?? [])).toEqual(["--self-last-known", "idle", "--self-idle-for", "2"]);
      }));

    it.effect("引き継ぎの状態が一度も届いていない、または初期状態に戻ったときは、起動し直しに休止の引数を渡さない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([
          { unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } },
          { unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } },
          {},
        ]);
        yield* sessions.start(start());
        yield* relaunchAfter(500);
        expect(carryOverArgs(fakeHelpers.calls[1] ?? [])).toEqual([]);

        fakeHelpers.send(1, stateEvent("take", "idle", "idle", 3));
        fakeHelpers.send(1, stateEvent("none", "unknown", "unknown", 0));
        yield* TestClock.adjust(1);
        yield* relaunchAfter(500);
        expect(carryOverArgs(fakeHelpers.calls[2] ?? [])).toEqual([]);
      }));

    it.effect("壊れた self-pause-state（値が決まった語でない・待ちが負や数でない）は引き継がない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([{ unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } }, {}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, stateEvent("resume", "using", "idle", 1));
        fakeHelpers.send(0, stateEvent("pause", "pause", "idle", 1));
        fakeHelpers.send(0, stateEvent("pause", "using", "take", 1));
        fakeHelpers.send(0, stateEvent("pause", "using", "idle", -1));
        fakeHelpers.send(0, { type: "self-pause-state", manual: "pause", basis: "using", lastKnown: "idle", idleFor: "1" });
        yield* TestClock.adjust(1);
        yield* relaunchAfter(500);

        expect(carryOverArgs(fakeHelpers.calls[1] ?? [])).toEqual([]);
      }));

    it.effect("self-pause-state はログにも画面にも出ない（server が覚えるだけ）", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        const before = fakeSinks.appended.length;
        fakeHelpers.send(0, stateEvent("pause", "using", "idle", 1.5));
        yield* TestClock.adjust(1);

        expect(fakeSinks.appended.length).toBe(before);
        expect(yield* watcher.selfPauseFrames).toEqual([]);
        expect((yield* sessions.status).status).toBe("running");
      }));

    it.effect("接続中の helper が無視した休止の要求（イベントが無い）は、起動し直した回の引数にも送信にも残らない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([{ unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } }, {}]);
        yield* sessions.start(start());

        yield* sessions.setSelfPause(true);
        expect(fakeHelpers.sentPauses).toEqual([{ attempt: 0, paused: true }]);
        yield* relaunchAfter(500);

        expect(fakeHelpers.calls).toHaveLength(2);
        expect(carryOverArgs(fakeHelpers.calls[1] ?? [])).toEqual([]);
        expect(fakeHelpers.sentPauses.filter((s) => s.attempt === 1)).toEqual([]);
      }));

    it.effect("接続待ちの間の休止の要求は、接続した回へ送られる。helper が無視したら（イベントが無い）、その次の回の引数にも送信にも残らない", () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const { fakeHelpers, sessions } = yield* boot([
          { unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } },
          { connectGate: gate, unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } },
          {},
        ]);
        yield* sessions.start(start());
        yield* relaunchAfter(500); // 起動回 1 が接続待ちで止まる
        expect(fakeHelpers.calls).toHaveLength(2);

        yield* sessions.setSelfPause(true);
        expect(fakeHelpers.sentPauses).toEqual([]);
        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust(1);
        expect(fakeHelpers.sentPauses).toEqual([{ attempt: 1, paused: true }]);

        yield* relaunchAfter(500);
        expect(fakeHelpers.calls).toHaveLength(3);
        expect(carryOverArgs(fakeHelpers.calls[2] ?? [])).toEqual([]);
        expect(fakeHelpers.sentPauses.filter((s) => s.attempt === 2)).toEqual([]);
      }));

    it.effect("引き継ぎの状態で起動し直した回の接続待ちの間に再開を求めると、その起動回へ paused:false が送られる", () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const { fakeHelpers, sessions } = yield* boot([{ unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } }, { connectGate: gate }]);
        yield* sessions.start(start());
        fakeHelpers.send(0, pauseEvent(true, 1));
        fakeHelpers.send(0, stateEvent("pause", "using", "using", 0));
        yield* TestClock.adjust(1);
        yield* relaunchAfter(500);
        expect(carryOverArgs(fakeHelpers.calls[1] ?? [])).toContain("--self-manual");

        yield* sessions.setSelfPause(false);
        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust(1);

        expect(fakeHelpers.sentPauses.filter((s) => s.attempt === 1)).toEqual([{ attempt: 1, paused: false }]);
      }));

    it.effect("再開が受け付けられた（pause → resume のイベント）後に起動し直すと、引き継ぎの引数を渡さず、休止も送らない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([{ unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } }, {}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, pauseEvent(true, 1));
        fakeHelpers.send(0, pauseEvent(false, 2));
        yield* TestClock.adjust(1);
        yield* relaunchAfter(500);

        expect(fakeHelpers.calls).toHaveLength(2);
        expect(carryOverArgs(fakeHelpers.calls[1] ?? [])).toEqual([]);
        expect(fakeHelpers.sentPauses.filter((s) => s.attempt === 1)).toEqual([]);
      }));

    it.effect("手動の休止の状態を覚えたまま諦めて止まったセッションを resume すると、覚えた状態が新しい起動回の引数になる（自動の起動し直しと同じ内容）", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { connect: false, stderrTail: ["失敗2"] },
          { connect: false, stderrTail: ["失敗3"] },
          {}, // resume
        ]);
        yield* sessions.start(start());
        fakeHelpers.send(0, pauseEvent(true, 1));
        fakeHelpers.send(0, stateEvent("pause", "using", "idle", 1.5));
        yield* TestClock.adjust(1);
        yield* relaunchAfter(500);
        expect((yield* sessions.status).status).toBe("stopped");
        expect(fakeHelpers.calls).toHaveLength(3);

        yield* sessions.resume;

        const expected = ["--self-manual", "pause", "--self-basis", "using", "--self-last-known", "idle", "--self-idle-for", "1.5"];
        expect(fakeHelpers.calls).toHaveLength(4);
        expect(carryOverArgs(fakeHelpers.calls[1] ?? [])).toEqual(expected); // 失敗した起動回は状態を上書きしない
        expect(carryOverArgs(fakeHelpers.calls[2] ?? [])).toEqual(expected);
        expect(carryOverArgs(fakeHelpers.calls[3] ?? [])).toEqual(expected);
        expect(fakeHelpers.calls[3]).not.toContain("--self-paused");
      }));

    it.effect("自動で休止していた状態（手動なし・待ちが済んだ）も、止まったセッションの resume で新しい起動回の引数になる", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { connect: false, stderrTail: ["失敗2"] },
          { connect: false, stderrTail: ["失敗3"] },
          {}, // resume
        ]);
        yield* sessions.start(start());
        fakeHelpers.send(0, stateEvent("none", "unknown", "idle", 3));
        yield* TestClock.adjust(1);
        yield* relaunchAfter(500);
        expect((yield* sessions.status).status).toBe("stopped");

        yield* sessions.resume;

        expect(fakeHelpers.calls).toHaveLength(4);
        expect(carryOverArgs(fakeHelpers.calls[3] ?? [])).toEqual(["--self-last-known", "idle", "--self-idle-for", "3"]);
      }));

    it.effect("次のセッションには休止も引き継ぎの状態も持ち越さない（stop 後の start は引き継ぎの引数なし）", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([{}, {}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, pauseEvent(true, 1));
        fakeHelpers.send(0, stateEvent("pause", "using", "idle", 1.5));
        yield* TestClock.adjust(1);
        yield* sessions.stop;
        yield* sessions.start(start());

        expect(carryOverArgs(fakeHelpers.calls[1] ?? [])).toEqual([]);
      }));
  });

  describe("話者の区間（speaker・speaker-off。Issue #1020）", () => {
    const boot = (attempts: AttemptScript[]) =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers(attempts);
        const fakeSinks = yield* makeFakeSessionSinks();
        const booted = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        return { fakeHelpers, fakeSinks, ...booted };
      });

    it.effect("speaker・speaker-mixed・speaker-settled・speaker-off は届いた値のまま、届いた順に sink.speaker へ渡る（話者の決定と log への記録は sink が行う）。セッションは running のまま", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions } = yield* boot([{}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "speaker", track: "相手", start: 1.5, end: 2.5, slot: 2, final: false });
        fakeHelpers.send(0, { type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true });
        fakeHelpers.send(0, { type: "speaker-mixed", track: "相手", slot: 2, start: 95.5 });
        fakeHelpers.send(0, { type: "speaker-settled", track: "相手", to: 1.5 });
        fakeHelpers.send(0, { type: "speaker-off", start: 9, reason: "途中で停止" });
        yield* TestClock.adjust(1);

        expect(fakeSinks.appended).toEqual([]); // 話者の記録は appendLog 経由ではなく sink.speaker 経由の 1 経路だけ
        expect(fakeSinks.speakers).toEqual([
          { type: "speaker", track: "相手", start: 1.5, end: 2.5, slot: 2, final: false },
          { type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true },
          { type: "speaker-mixed", track: "相手", slot: 2, start: 95.5 },
          { type: "speaker-settled", track: "相手", to: 1.5 },
          { type: "speaker-off", start: 9, reason: "途中で停止" },
        ]);
        expect((yield* sessions.status).status).toBe("running");
      }));

    // Issue #1025: 起動し直すたびに Sortformer の枠は振り直される。sink へは、新しいヘルパーのイベントより前に 1 回だけ知らせる
    it.effect("speaker-centroid は届いた値のまま、届いた順に sink.speaker へ渡る。差分更新・appendLog には載らない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions } = yield* boot([{}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true });
        fakeHelpers.send(0, { type: "speaker-centroid", track: "相手", slot: 0, centroid: [0.25, -0.5, 1] });
        fakeHelpers.send(0, { type: "speaker-settled", track: "相手", to: 1.5 });
        yield* TestClock.adjust(1);

        expect(fakeSinks.appended).toEqual([]);
        expect(fakeSinks.speakers).toEqual([
          { type: "speaker", track: "相手", start: 0, end: 1.5, slot: 0, final: true },
          { type: "speaker-centroid", track: "相手", slot: 0, centroid: [0.25, -0.5, 1] },
          { type: "speaker-settled", track: "相手", to: 1.5 },
        ]);
        expect((yield* sessions.status).status).toBe("running");
      }));

    it.effect("1 回目の起動では sink.speakersRenumbered を呼ばない。ヘルパーが起動し直して接続したとき、新しいヘルパーのイベントより前に 1 回だけ呼ぶ", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions } = yield* boot([{ unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } }, {}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "speaker", track: "相手", start: 0, end: 1, slot: 0, final: true });
        yield* TestClock.adjust(1);
        expect(fakeSinks.speakerCalls).toEqual(["speaker:speaker"]);

        yield* TestClock.adjust(500); // 構成の変化（75）による終了: 待たずに起動し直す
        yield* TestClock.adjust(10);
        expect(fakeHelpers.calls).toHaveLength(2);
        fakeHelpers.send(1, { type: "speaker", track: "相手", start: 2, end: 3, slot: 0, final: true });
        fakeHelpers.send(1, { type: "speaker-centroid", track: "相手", slot: 0, centroid: [1, 0, 0] });
        yield* TestClock.adjust(1);

        expect(fakeSinks.speakerCalls).toEqual(["speaker:speaker", "renumbered", "speaker:speaker", "speaker:speaker-centroid"]);
      }));

    it.effect("ヘルパーを起動し直すたびに（2 回起動し直すなら 2 回）sink.speakersRenumbered を呼ぶ", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions } = yield* boot([
          { unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } },
          { unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } },
          {},
        ]);
        yield* sessions.start(start());
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);
        expect(fakeHelpers.calls).toHaveLength(3);

        expect(fakeSinks.speakerCalls).toEqual(["renumbered", "renumbered"]);
      }));

    it.effect("起動し直しの接続待ちの間に stop が求められ、その後に接続が追いついても、sink.speakersRenumbered を呼ぶ（届いていたイベントを読むため）", () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const { fakeHelpers, fakeSinks, sessions } = yield* boot([{ unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } }, { connectGate: gate }]);
        yield* sessions.start(start());
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);
        expect(fakeHelpers.calls).toHaveLength(2);
        expect(fakeSinks.speakerCalls).toEqual([]);

        const stopping = yield* Effect.forkChild(sessions.stop);
        yield* TestClock.adjust(1);
        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust(1);
        yield* Fiber.join(stopping);

        expect(fakeSinks.speakerCalls).toEqual(["renumbered"]);
      }));

    // Issue #1021: 枠とラベルの対応は SessionSink が 1 つだけ持つ。ヘルパーを起動し直しても、同じ sink へ届ける（セッションの寿命で 1 つ）
    it.effect("ヘルパーを起動し直した後の speaker・speaker-off も、起動し直す前と同じ sink（開いたのは 1 回）へ届く", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions } = yield* boot([{ unexpectedExit: { afterMs: 500, exit: { code: 75, signal: null } } }, {}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "speaker", track: "相手", start: 0, end: 1, slot: 2, final: true });
        yield* TestClock.adjust(500); // 構成の変化（75）による終了: 待たずに起動し直す
        yield* TestClock.adjust(10);
        expect(fakeHelpers.calls).toHaveLength(2);
        fakeHelpers.send(1, { type: "origin", hostTime: "2" });
        fakeHelpers.send(1, { type: "speaker", track: "相手", start: 1, end: 2, slot: 0, final: true });
        fakeHelpers.send(1, { type: "speaker-off", start: 3, reason: "途中で停止" });
        yield* TestClock.adjust(1);

        expect(fakeSinks.opened.count).toBe(1);
        expect(fakeSinks.speakers).toEqual([
          { type: "speaker", track: "相手", start: 0, end: 1, slot: 2, final: true },
          { type: "speaker", track: "相手", start: 1, end: 2, slot: 0, final: true },
          { type: "speaker-off", start: 3, reason: "途中で停止" },
        ]);
      }));

    it.effect("speaker・speaker-off は発言・途中結果・画面の記録に触れない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions } = yield* boot([{}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "speaker", track: "相手", start: 0, end: 1, slot: 1, final: true });
        fakeHelpers.send(0, { type: "speaker-off", start: 2, reason: "モデルなし" });
        yield* TestClock.adjust(1);

        expect(fakeSinks.finals).toEqual([]);
        expect(fakeSinks.partials).toEqual([]);
        expect(fakeSinks.screenOffs).toEqual([]);
        expect(fakeSinks.screens).toEqual([]);
      }));

    it.effect.each([
      ["slot が数でない", { type: "speaker", track: "相手", start: 0, end: 1, slot: "0", final: true }],
      ["final が真偽値でない", { type: "speaker", track: "相手", start: 0, end: 1, slot: 0, final: "yes" }],
      ["speaker-settled の to が数でない", { type: "speaker-settled", track: "相手", to: "14" }],
      ["speaker-settled に to が無い", { type: "speaker-settled", track: "相手" }],
      ["reason が知らない文字列", { type: "speaker-off", start: 0, reason: "other" }],
    ])("壊れた speaker 系のイベントは sink に届かない（%s）", (row) =>
      withStderr(() =>
        Effect.gen(function* () {
          const [, data] = row;
          const { fakeHelpers, fakeSinks, sessions } = yield* boot([{}]);
          yield* sessions.start(start());
          fakeHelpers.send(0, data);
          yield* TestClock.adjust(1);
          expect(fakeSinks.speakers).toEqual([]);
          expect(fakeSinks.appended).toEqual([]);
        })));
  });

  describe("共有画面を使わない（screen-off・--no-screen。Issue #280）", () => {
    const NOTICE_MS = 10_000; // 「届いてから約 10 秒」
    const boot = (attempts: AttemptScript[]) =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers(attempts);
        const fakeSinks = yield* makeFakeSessionSinks();
        const booted = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        return { fakeHelpers, fakeSinks, ...booted };
      });

    it.effect("screen:false は初回・自動の起動し直し・resume のすべての argv に --no-screen を付ける", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([
          { unexpectedExit: { afterMs: 5, exit: { code: 1, signal: null } } }, // 初回。すぐ終わる
          { connect: false, stderrTail: ["失敗2"] }, // 自動の起動し直し
          { connect: false, stderrTail: ["失敗3"] }, // 自動の起動し直し。ここで諦める
          {}, // resume
        ]);
        yield* sessions.start(start({ screen: false }));
        yield* TestClock.adjust(10);
        expect((yield* sessions.status).status).toBe("stopped");
        yield* sessions.resume;

        expect(fakeHelpers.calls).toHaveLength(4);
        for (const argv of fakeHelpers.calls) expect(argv).toContain("--no-screen");
      }));

    it.effect("screen:true では、初回も起動し直しも resume も --no-screen を付けない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([
          { unexpectedExit: { afterMs: 5, exit: { code: 1, signal: null } } },
          { connect: false, stderrTail: ["失敗2"] },
          { connect: false, stderrTail: ["失敗3"] },
          {},
        ]);
        yield* sessions.start(start({ screen: true }));
        yield* TestClock.adjust(10);
        yield* sessions.resume;

        expect(fakeHelpers.calls).toHaveLength(4);
        for (const argv of fakeHelpers.calls) expect(argv).not.toContain("--no-screen");
      }));

    it.effect("--no-screen は値を取らない: 次の引数（--audio-dir など）を食わず、--no-audio とも独立している", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions } = yield* boot([{}, {}]);
        yield* sessions.start(start({ screen: false, audio: true }));
        const argv = fakeHelpers.calls[0]!;
        expect(argv).toContain("--audio-dir");
        expect(argv[argv.indexOf("--no-screen") + 1]?.startsWith("--") ?? true).toBe(true);

        yield* sessions.stop;
        yield* sessions.start(start({ screen: false, audio: false }));
        expect(fakeHelpers.calls[1]).toContain("--no-screen");
        expect(fakeHelpers.calls[1]).not.toContain("--audio-dir");
      }));

    it.effect("screen:false のセッションは、開いた直後に screen-off（指定、start は 0）を 1 件だけ sink へ入れる。最初の発言より前で、知らせは出ない。起動し直し・resume では足さない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([
          { unexpectedExit: { afterMs: 5, exit: { code: 1, signal: null } } },
          { connect: false, stderrTail: ["失敗2"] },
          { connect: false, stderrTail: ["失敗3"] },
          {},
        ]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start({ screen: false }));
        fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "はじめ" });
        yield* TestClock.adjust(1);
        expect(fakeSinks.screenOffs).toEqual([{ start: 0, reason: "指定" }]);
        expect(fakeSinks.sequence).toEqual(["screenOff:指定", "final"]);

        yield* TestClock.adjust(10);
        yield* sessions.resume;
        expect(fakeHelpers.calls).toHaveLength(4); // 起動し直しと resume が起きたうえで
        expect(fakeSinks.screenOffs).toEqual([{ start: 0, reason: "指定" }]);
        yield* TestClock.adjust(NOTICE_MS * 2);
        expect(yield* watcher.screenNotices).toEqual([]); // 指定では知らせを出さない
      }));

    it.effect("screen:true（既定）のセッションは screen-off を残さない", () =>
      Effect.gen(function* () {
        const { fakeSinks, sessions } = yield* boot([{}]);
        yield* sessions.start(start({ screen: true }));
        yield* TestClock.adjust(1);
        expect(fakeSinks.screenOffs).toEqual([]);
      }));

    it.effect("ヘルパーの screen-off（許可なし）は start と reason のまま sink へ届き、取り込みの記録・状態には触れず、発言は流れ続ける", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions } = yield* boot([{}]);
        yield* sessions.start(start());

        fakeHelpers.send(0, { type: "screen-off", start: 2.5, reason: "許可なし" });
        fakeHelpers.send(0, { type: "remark", track: "相手", start: 3, end: 4, text: "つづく" });
        yield* TestClock.adjust(1);

        expect(fakeSinks.screenOffs).toEqual([{ start: 2.5, reason: "許可なし" }]);
        expect(fakeSinks.appended).toEqual([]);
        expect(fakeSinks.screens).toEqual([]);
        expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "つづく" });
        expect((yield* sessions.status).status).toBe("running");
      }));

    it.effect("許可なしの知らせは、同じセッションで起動し直しの後に screen-off がまた届いても 1 回だけ。ログ（sink）には届くたびに残る。取り込みの途切れにはならない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          {},
        ]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());

        fakeHelpers.send(0, { type: "screen-off", start: 1, reason: "許可なし" });
        yield* TestClock.adjust(1);
        const first = yield* watcher.screenNotices;
        expect(first).toHaveLength(1);
        expect(first[0]).toContain("共有画面は使っていません");
        expect(fakeSinks.screenOffs).toHaveLength(1);

        yield* TestClock.adjust(500); // 予期しない終了
        yield* TestClock.adjust(10); // 起動し直し
        expect(fakeHelpers.calls).toHaveLength(2);
        fakeHelpers.send(1, { type: "screen-off", start: 0.5, reason: "許可なし" });
        fakeHelpers.send(1, { type: "remark", track: "相手", start: 0, end: 1, text: "再開後" });
        yield* TestClock.adjust(1);

        expect(fakeSinks.screenOffs).toEqual([{ start: 1, reason: "許可なし" }, { start: 0.5, reason: "許可なし" }]);
        expect(yield* watcher.screenNotices).toEqual([]); // 一文は出し直さない
        expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "再開後" }); // 発言は流れ続ける
        expect((yield* sessions.status).status).toBe("running");
      }));

    it.effect("知らせは届いてから約 10 秒で消すフレーム（text: null）が届き、その後につないだブラウザには解除のフレームだけが届く", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([{}]);
        const early = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(early.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "screen-off", start: 1, reason: "許可なし" });
        yield* TestClock.adjust(1);
        expect((yield* early.screenNotices).map((t) => t !== null)).toEqual([true]);

        yield* TestClock.adjust(NOTICE_MS - 2_000);
        const within = yield* viewerClient(); // 10 秒以内につないだブラウザには送り直す
        yield* Effect.forkChild(viewers.connect(within.socket));
        const seen = yield* within.screenNotices;
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain("共有画面は使っていません");

        yield* TestClock.adjust(2_000 + 1);
        expect(yield* early.screenNotices).toEqual([null]); // 消すフレーム
        expect(yield* within.screenNotices).toEqual([null]);

        const late = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(late.socket));
        expect(yield* late.screenNotices).toEqual([null]); // 期限後は再び出さない
      }));

    it.effect("10 秒たった後に起動し直しで screen-off がまた届いても、一文は出し直さない", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([
          { unexpectedExit: { afterMs: NOTICE_MS + 1_000, exit: { code: 1, signal: null } } },
          {},
        ]);
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "screen-off", start: 1, reason: "許可なし" });
        yield* TestClock.adjust(NOTICE_MS + 1);
        expect((yield* watcher.screenNotices).map((t) => t === null)).toEqual([false, true]);

        yield* TestClock.adjust(1_000);
        yield* TestClock.adjust(10);
        expect(fakeHelpers.calls).toHaveLength(2);
        fakeHelpers.send(1, { type: "screen-off", start: 0, reason: "許可なし" });
        yield* TestClock.adjust(NOTICE_MS * 2);
        expect(yield* watcher.screenNotices).toEqual([]);
      }));

    it.effect("stop で知らせを解除し、stop 後につないだブラウザには null だけが届く", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([{}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "screen-off", start: 1, reason: "許可なし" });
        yield* TestClock.adjust(1);
        yield* sessions.stop;

        const after = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(after.socket));
        expect(yield* after.screenNotices).toEqual([null]);
      }));

    it.effect("壊れた screen-off は stderr に 1 行出して読み飛ばし、sink にも知らせにも届かず、続く発言は届く", () =>
      withStderr((stderr) =>
        Effect.gen(function* () {
          const { fakeHelpers, fakeSinks, sessions, viewers } = yield* boot([{}]);
          const watcher = yield* viewerClient();
          yield* Effect.forkChild(viewers.connect(watcher.socket));
          yield* sessions.start(start());

          fakeHelpers.send(0, { type: "screen-off", start: 1, reason: "指定" }); // reason はヘルパーが流さない値
          fakeHelpers.send(0, { type: "screen-off", reason: "許可なし" }); // start が無い
          fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "つづく" });
          yield* TestClock.adjust(1);

          expect(stderr.filter((s) => s.includes("ヘルパーのイベントを読み飛ばしました"))).toHaveLength(2);
          expect(fakeSinks.screenOffs).toEqual([]);
          expect(yield* watcher.screenNotices).toEqual([]);
          expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "つづく" });
          expect((yield* sessions.status).status).toBe("running");
        })));
  });

  describe("stop は印を立てるだけで中断しない（CT-STOP-MARK）", () => {
    it.effect("close の前に届いた発言を読み終えてから書き出す", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "ぎりぎり" });
        yield* TestClock.adjust(1);

        const result = yield* sessions.stop;

        expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "ぎりぎり" });
        expect(result.paths).toHaveLength(4);
      }));

    it.effect("stop の呼び出し側が中断されても（HTTP 要求の切断と同じ）、読み終える・書き出す・閉じるまで続き、idle に戻る", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ stopDelayMs: 1_000 }, {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "ぎりぎり" });
        yield* TestClock.adjust(1);

        const stopFiber = yield* Effect.forkChild(sessions.stop);
        yield* TestClock.adjust(10); // ヘルパーの停止の待ちに入る
        yield* Fiber.interrupt(stopFiber);
        yield* TestClock.adjust(1_000);

        expect(fakeSinks.order).toEqual(["flush", "exports", "close"]);
        expect(fakeSinks.relayStats.drained).toBeGreaterThanOrEqual(1);
        expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "ぎりぎり" });
        expect((yield* sessions.status).status).toBe("none");
        yield* sessions.start(start()); // idle に戻っているので続けて開始できる
      }));

    it.effect("サーバーの終了（serverScope を閉じる）による中断は維持される。書き出さずに閉じ、stop の呼び出し側も中断で終わる", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ stopDelayMs: 1_000 }]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions, closeServer } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        const stopFiber = yield* Effect.forkChild(sessions.stop);
        yield* TestClock.adjust(10);
        yield* closeServer();
        yield* TestClock.adjust(1_000);
        const exit = yield* Fiber.await(stopFiber);

        expect(fakeSinks.order).toEqual(["close"]);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      }));
  });

  describe("起動し直し・諦め・resume（CT-RESTART-DECISION / CT-REF-STATE）", () => {

    it.effect("途切れた瞬間に drain と字幕のクリアが走る（CT-DRAIN / CT-SPEAKING-CLEAR）。stopRelays はまだ呼ばない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          {},
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);

        expect(fakeSinks.relayStats.drained).toBeGreaterThan(0);
        expect(fakeSinks.relayStats.cleared).toBeGreaterThan(0);
        expect(fakeSinks.relayStats.stopped).toBe(0); // セッションはまだ続いている（stop の後だけ 1）

        yield* sessions.stop;
        expect(fakeSinks.relayStats.stopped).toBe(1);
      }));

    it.effect("動いている最中・起動し直しの最中の resume は IntakeNotStopped で拒否され、起動の回数が増えない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        const result = yield* Effect.exit(sessions.resume);

        expect(Exit.isFailure(result)).toBe(true);
        expect(fakeHelpers.calls).toHaveLength(1);
      }));

    it.effect.each([false, true])("resume後、接続失敗では途切れ時刻を保持し、接続後の終了で更新する（接続成功=%s）", (connected) =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { connect: false, stderrTail: ["失敗2"] },
          { connect: false, stderrTail: ["失敗3"] },
          connected ? { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } } : { connect: false, stderrTail: ["失敗4"] },
          { connect: false, stderrTail: ["失敗5"] },
          { connect: false, stderrTail: ["最後の失敗"] },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);
        const before = yield* sessions.status;
        expect(before.status).toBe("stopped");
        expect(before.lastInterruptedAt).toMatch(/^1970-01-01T00:00:00\.500Z$/);
        yield* TestClock.adjust(1_000);

        const resumeFiber = yield* Effect.forkChild(Effect.exit(sessions.resume));
        yield* TestClock.adjust(10);
        const result = yield* Fiber.join(resumeFiber);

        expect(Exit.isSuccess(result)).toBe(connected);
        expect(fakeHelpers.calls.length).toBeGreaterThan(3);
        expect((yield* sessions.status).lastInterruptedAt).toBe(before.lastInterruptedAt);
        if (connected) {
          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);
        }
        const after = yield* sessions.status;
        expect(after.status).toBe("stopped");
        if (connected) expect(after.lastInterruptedAt! > before.lastInterruptedAt!).toBe(true);
        else expect(after.lastInterruptedAt).toBe(before.lastInterruptedAt);
      }));
  });

  // ヘルパーの終了コード 75（シグナルなし）は、マイクの入力の構成の変化（入力の機器の切り替えなど）による終了。
  // 失敗の連続には数えず、別の歯止め（60 秒に 10 回を超えたら諦める）で数える。
  describe("構成の変化による終了（終了コード 75）は諦める回数に数えない", () => {
    const configChange = (afterMs = 500): AttemptScript => ({ unexpectedExit: { afterMs, exit: { code: 75, signal: null } } });
    const repeat = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => value);
    // 終了が 1 回起きて、起動し直しのループが次の launch まで進むための時間（時計は 500ms 進めたあとに少し進める）
    const cycle = Effect.gen(function* () {
      yield* TestClock.adjust(500);
      yield* TestClock.adjust(10);
    });

    it.effect("構成の変化の終了も途切れとして扱う（drain・字幕のクリア・interrupted のフレーム・起動し直した回数・intake-stopped の code 75）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([configChange(), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions, viewers } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        const client = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(client.socket));
        yield* client.intakeStatuses; // 接続時のスナップショットの状態を読み捨てる

        yield* cycle;

        expect(fakeSinks.relayStats.drained).toBeGreaterThan(0);
        expect(fakeSinks.relayStats.cleared).toBeGreaterThan(0);
        expect((yield* sessions.status).restarts).toBe(1);
        expect(yield* client.intakeStatuses).toEqual(["interrupted", "running"]);
        expect(fakeSinks.appended.some((e) => e.type === "intake-stopped" && e.code === 75 && e.signal === null)).toBe(true);
        expect(fakeSinks.appended.some((e) => e.type === "intake-restarted" && e.trigger === "auto")).toBe(true);
      }));

    it.effect("歯止めで止まったとき、ブラウザへのフレームは今までどおり stopped（理由で分けない）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([...repeat(11, configChange()), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions, viewers } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        for (let i = 0; i < 11; i++) yield* cycle;

        const client = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(client.socket));

        expect(yield* client.intakeStatuses).toEqual(["stopped"]);
      }));

  });

  describe("起動し直しの最中に stop・close が来る場合（CT-CLOSE-ONLY-INTERRUPT）", () => {
    it.effect("起動し直しの最中に stop すると、起動中のヘルパーも止まる", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: null, signal: "SIGKILL" } } },
          { connect: true }, // 2 回目は接続するが、台本内でまだ events を送らない＝起動し直しの最中とみなす
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10); // 2 回目の起動し直しが始まる

        const result = yield* sessions.stop;

        expect(result.paths).toHaveLength(4);
        expect(fakeHelpers.calls).toHaveLength(2);
      }));

    it.effect("起動し直しの最中に server scope が終わると、起動中のヘルパーも止まる", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: null, signal: "SIGKILL" } } },
          { connect: true },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions, closeServer } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);

        yield* closeServer();

        expect(fakeSinks.opened).toMatchObject({ count: 1, closed: 1 });
      }));

    it.effect("stop・server scope の終了で止めたヘルパーは、起動し直さない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        yield* sessions.stop;
        yield* TestClock.adjust(1_000);

        expect(fakeHelpers.calls).toHaveLength(1); // stop による終了を、予期せぬ終了と誤認しない
      }));
  });

  describe("録音が不完全かもしれない警告（CT-WARN-AUDIO / CT-WARN-SIGKILL-LINE）", () => {
    it.effect("stop で止めたヘルパーの終わり方が SIGKILL で録音が有効なとき、両方の警告が出る。文面はそのときの起動回のファイル名を示す", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ stopExit: { code: null, signal: "SIGKILL" } }]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start({ audio: true }));

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(true);
          const warning = stderr.find((s) => s.includes("録音の書き終わりを確認できない"));
          expect(warning).toBeDefined();
          expect(warning).toContain("相手.m4a");
          expect(warning).toContain("自分.m4a");
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("--no-audio では、SIGKILL で止めますは出るが、録音の警告は出ない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ stopExit: { code: null, signal: "SIGKILL" } }]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start({ audio: false }));

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(true);
          expect(stderr.some((s) => s.includes("録音の書き終わり"))).toBe(false);
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("SIGTERM で終わったときは、どちらの行も出ない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ stopExit: { code: null, signal: "SIGTERM" } }]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start({ audio: true }));

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(false);
          expect(stderr.some((s) => s.includes("録音の書き終わり"))).toBe(false);
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("警告の起動回（attempt）は、起動し直した後の録音ファイル名を示す", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { stopExit: { code: null, signal: "SIGKILL" } },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start({ audio: true }));
          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);

          yield* sessions.stop;

          const warning = stderr.find((s) => s.includes("録音の書き終わりを確認できない"));
          expect(warning).toContain("相手-2.m4a");
          expect(warning).toContain("自分-2.m4a");
          expect(warning).not.toContain("相手.m4a");
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("起動し直しの接続待ちの最中に stop し、SIGKILL で終わったとき、録音が有効なら両方の警告が出る（相手-2.m4a）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { hold: true, stopExit: { code: null, signal: "SIGKILL" } },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start({ audio: true }));
          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);
          expect(fakeHelpers.calls).toHaveLength(2); // 2 回目が接続待ちのまま
          expect(fakeHelpers.stops).toEqual([]);

          yield* sessions.stop;

          expect(fakeHelpers.stops).toEqual([1]);
          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(true);
          const warning = stderr.find((s) => s.includes("録音の書き終わりを確認できない"));
          expect(warning).toContain("相手-2.m4a");
          expect(warning).toContain("自分-2.m4a");
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("起動し直しの接続待ちの最中に stop し、SIGKILL で終わったとき、--no-audio なら SIGKILL の行だけが出る", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { hold: true, stopExit: { code: null, signal: "SIGKILL" } },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start({ audio: false }));
          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);
          expect(fakeHelpers.calls).toHaveLength(2); // 2 回目が接続待ちのまま
          expect(fakeHelpers.stops).toEqual([]);

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(true);
          expect(stderr.some((s) => s.includes("録音の書き終わり"))).toBe(false);
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("起動し直しの接続待ちの最中に stop し、SIGTERM で終わったときは、どちらの行も出ない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { hold: true, stopExit: { code: null, signal: "SIGTERM" } },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start({ audio: true }));
          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);
          expect(fakeHelpers.calls).toHaveLength(2); // 2 回目が接続待ちのまま
          expect(fakeHelpers.stops).toEqual([]);

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(false);
          expect(stderr.some((s) => s.includes("録音の書き終わり"))).toBe(false);
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("resume の接続待ちの最中に stop し、SIGKILL で終わったとき、警告は resume の起動回（相手-4.m4a）を示す。resume は Aborted で終わる", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 5, exit: { code: 1, signal: null } } },
          { connect: false },
          { connect: false },
          { hold: true, stopExit: { code: null, signal: "SIGKILL" } },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start({ audio: true }));
          yield* TestClock.adjust(5);
          yield* TestClock.adjust(10);
          expect((yield* sessions.status).status).toBe("stopped");
          expect(fakeHelpers.calls).toHaveLength(3);

          const resumeFiber = yield* Effect.forkChild(Effect.exit(sessions.resume));
          yield* TestClock.adjust(10);
          expect(fakeHelpers.calls).toHaveLength(4); // 4 回目が接続待ちのまま
          expect(fakeHelpers.stops).toEqual([]);

          yield* sessions.stop;
          const resumed = yield* Fiber.join(resumeFiber);

          expect(Exit.isFailure(resumed) && Cause.squash(resumed.cause)).toMatchObject({ _tag: "Aborted" });
          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(true);
          const warning = stderr.find((s) => s.includes("録音の書き終わりを確認できない"));
          expect(warning).toContain("相手-4.m4a");
        }).pipe(Effect.provideService(Console.Console, service));
      }));
  });

  describe("argv（--origin・--audio-index）", () => {
    it.effect("既定の start は --audio-dir を渡す。--no-audio では渡さない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));

        yield* sessions.start(start({ audio: true }));
        expect(fakeHelpers.calls[0]).toContain("--audio-dir");

        yield* sessions.stop;
        yield* sessions.start(start({ audio: false }));
        expect(fakeHelpers.calls[1]).not.toContain("--audio-dir");
      }));

    it.effect("録音ファイルの番号（--audio-index）は起動回で、1 回目は番号なし", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          {},
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));

        yield* sessions.start(start({ audio: true }));
        const first = fakeHelpers.calls[0]!;
        expect(first[first.indexOf("--audio-index") + 1]).toBe("1"); // 1 回目は 1（録音ファイルの名前は番号なしになる）

        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);
        const second = fakeHelpers.calls[1]!;
        expect(second[second.indexOf("--audio-index") + 1]).toBe("2");
      }));

    it.effect("原点（--origin）は最初のヘルパーの値だけ採用し、文字列のまま次の起動し直しへ渡る", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          {},
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));

        yield* sessions.start(start());
        expect(fakeHelpers.calls[0]).not.toContain("--origin"); // 1 回目は、まだ原点を受け取る前に起動している
        fakeHelpers.send(0, { type: "origin", hostTime: "9007199254740993" });
        yield* TestClock.adjust(1);
        fakeHelpers.send(0, { type: "origin", hostTime: "1" }); // 2 回目以降は無視される（最初の値だけ採用）
        yield* TestClock.adjust(1);

        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);

        const second = fakeHelpers.calls[1]!;
        const originIndex = second.indexOf("--origin");
        expect(originIndex).toBeGreaterThan(-1);
        expect(second[originIndex + 1]).toBe("9007199254740993");
      }));

    it.effect("壊れた原点のイベントは保持されず、起動し直しの argv にも現れない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          {},
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start());
          fakeHelpers.send(0, { type: "origin", hostTime: 123 }); // 壊れた形（number）
          yield* TestClock.adjust(1);

          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);

          expect(fakeHelpers.calls[1]).not.toContain("--origin");
        }).pipe(Effect.provideService(Console.Console, service));
      }));
  });

  describe("状態のフレーム・cli status 相当の値（status）", () => {
    it.effect("セッションなし・動いている・途切れている・止まったで、status の値が変わる", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { connect: false, stderrTail: ["起動に失敗"] },
          { connect: false, stderrTail: ["起動に失敗"] },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));

        expect((yield* sessions.status).status).toBe("none");

        yield* sessions.start(start());
        const running = yield* sessions.status;
        expect(running.status).toBe("running");
        expect(running.dir).toBe("/tmp/live-mindmap-fake/1"); // cli status が出すセッションのフォルダ
        expect(running.restarts).toBe(0);
        expect(running.lastInterruptedAt).toBeUndefined();

        yield* TestClock.adjust(500);
        const interrupted = yield* sessions.status;
        expect(interrupted.status).toBe("interrupted");
        expect(interrupted.lastInterruptedAt).toMatch(/^1970-01-01T00:00:00\.50[01]Z$/); // Clock（TestClock）の時刻を ISO 形式で書く

        yield* TestClock.adjust(10);
        const stopped = yield* sessions.status;
        expect(stopped.status).toBe("stopped");
        expect(stopped.dir).toBe("/tmp/live-mindmap-fake/1"); // 止まった後もセッションのフォルダは引き続き出る
        expect(stopped.restarts).toBe(0); // 起動し直しに成功した回がない
        expect(stopped.lastInterruptedAt).toBe(interrupted.lastInterruptedAt);
      }));

    it.effect("自動再接続に成功した後の途切れは、新しい時刻としてstatusに出る", () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { connectGate: gate, unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { hold: true },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        yield* TestClock.adjust(500);
        const before = yield* sessions.status;
        expect(before.status).toBe("interrupted");
        expect(before.lastInterruptedAt).toBe("1970-01-01T00:00:00.500Z");
        yield* TestClock.adjust(1_000);
        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust(1);
        expect((yield* sessions.status).status).toBe("running");
        expect((yield* sessions.status).lastInterruptedAt).toBe(before.lastInterruptedAt);
        yield* TestClock.adjust(500);
        const after = yield* sessions.status;
        expect(after.status).toBe("interrupted");
        expect(after.lastInterruptedAt! > before.lastInterruptedAt!).toBe(true);
        yield* sessions.stop;
      }));
  });

  describe("開始の失敗（HelperExited）", () => {
    it.effect("1 回目の接続に失敗すると、HelperExited として失敗し、セッションは開始されない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ connect: false, stderrTail: ["マイクが許可されていません"] }]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));

        const result = yield* Effect.exit(sessions.start(start()));

        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result)) return;
        expect(Cause.squash(result.cause)).toBeInstanceOf(HelperExited);
        expect((yield* sessions.status).status).toBe("none");
        expect(fakeSinks.opened).toMatchObject({ count: 0, closed: 0 }); // 開始の失敗では SessionSinks を開かない
      }));
  });

  describe("拒否・失敗・状態のフレームの連続観測", () => {
    it.effect("進行中の start は拒否されて進行中のセッションを壊さず、セッションが無い stop も拒否される。終了後は新しいセッションを開始できる", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));

        const noSession = yield* Effect.flip(sessions.stop);
        expect(noSession).toBeInstanceOf(NoSession);

        yield* sessions.start(start({ title: "1 つ目" }));
        const busy = yield* Effect.flip(sessions.start(start({ title: "2 つ目" })));
        expect(busy).toBeInstanceOf(SessionBusy);
        expect(fakeHelpers.calls).toHaveLength(1); // 拒否された start はヘルパーを起動しない
        expect(fakeSinks.opened).toMatchObject({ count: 1, closed: 0 });

        yield* sessions.stop; // 拒否された start の後でも、1 つ目のセッションを終了できる
        yield* sessions.start(start({ title: "2 つ目" }));
        yield* sessions.stop;
        expect(fakeHelpers.calls).toHaveLength(2);
      }));

    it.effect("stop が書き出しで失敗しても、local 表示を解除し、updater は 1 回閉じ、予約は止まり、状態は none に戻って、次のセッションを開始できる（CT-SINK-SCOPE / 要件128,129）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks({ exportsFails: true });
        const { sessions, viewers } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        const local = start({ plan: { kind: "single", model: { name: "apple", route: "apple", local: true } } });
        yield* sessions.start(local);
        expect(yield* watcher.sessionModes).toEqual([true]);

        const exit = yield* Effect.exit(sessions.stop);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(fakeSinks.opened).toMatchObject({ count: 1, closed: 1 });
        expect(fakeSinks.relayStats.stopped).toBe(1);
        expect((yield* sessions.status).status).toBe("none");
        expect((yield* watcher.intakeStatuses).at(-1)).toBe("none"); // 失敗しても、接続中のクライアントの一言は消える
        expect(yield* watcher.sessionModes).toEqual([true, false]);
        yield* sessions.start(local);
        expect(yield* watcher.sessionModes).toEqual([true, false, true]);
        expect(fakeSinks.opened).toMatchObject({ count: 2, closed: 1 });
      }));

    it.effect("接続を保ったままのクライアントに interrupted → stopped の状態のフレームが届き続け、途中から接続したクライアントにも今の状態が届き、stop で none になる。終了後に新しく接続したクライアントには none だけが届く", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: null, signal: "SIGKILL" } } },
          { connect: false, stderrTail: ["起動に失敗"] },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions, viewers } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const before = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(before.socket));
        yield* sessions.start(start());
        expect(yield* before.intakeStatuses).toEqual([]); // 動いている間は状態のフレームを送らない

        yield* TestClock.adjust(500);
        expect((yield* before.intakeStatuses).at(-1)).toBe("interrupted");
        const during = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(during.socket));
        expect((yield* during.intakeStatuses).at(-1)).toBe("interrupted"); // 途中から接続しても、今の状態が届く

        yield* TestClock.adjust(10);
        expect((yield* before.intakeStatuses).at(-1)).toBe("stopped");
        expect((yield* during.intakeStatuses).at(-1)).toBe("stopped");

        yield* sessions.stop;
        // "running" ではなく "none"。"running" だと、直前が stopped だったクライアントが「再開した」と解釈する（CT-NOTICE-CLEAR）
        expect((yield* before.intakeStatuses).at(-1)).toBe("none");
        expect((yield* during.intakeStatuses).at(-1)).toBe("none");

        const after = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(after.socket));
        expect(yield* after.intakeStatuses).toEqual(["none"]);
      }));
  });

  // base の server.heavy.test.ts の移動先のうち、偽の Helpers・SessionSinks と TestClock で観測できる残りの条件
  describe("セッションの中身の寿命・起動し直しをまたぐ連続性・ログ（base server.heavy.test.ts の移動先）", () => {
    it.effect("stop は、最後の差分更新（flush）が終わってから updater（Scope）を閉じ、閉じた後には何も呼ばない（base:581）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "r1 の発言" });
        yield* TestClock.adjust(1);

        yield* sessions.stop;

        expect(fakeSinks.order.filter((e) => e === "close")).toHaveLength(1);
        expect(fakeSinks.order.indexOf("flush")).toBeGreaterThanOrEqual(0);
        expect(fakeSinks.order.indexOf("flush")).toBeLessThan(fakeSinks.order.indexOf("close"));
        expect(fakeSinks.order.at(-1)).toBe("close"); // 閉じた後に flush などが呼ばれない
      }));

    it.effect("--audio-dir の値は、SessionSinks が作ったセッションのフォルダで、起動し直しでも変わらない（base:733）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } }, {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start({ audio: true }));
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);

        const dirOf = (argv: ReadonlyArray<string>) => argv[argv.indexOf("--audio-dir") + 1];
        expect(dirOf(fakeHelpers.calls[0]!)).toBe("/tmp/live-mindmap-fake/1");
        expect(dirOf(fakeHelpers.calls[1]!)).toBe("/tmp/live-mindmap-fake/1"); // フォルダは増えない（base:848）
      }));

    it.effect("起動し直しをまたいで、SessionSinks は開き直さず、発言の ID は連番で、接続中のクライアントに running のフレームが届く（base:848, 900）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } }, {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions, viewers } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const client = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(client.socket));
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "前の回 1" });
        fakeHelpers.send(0, { type: "remark", track: "自分", start: 1, end: 2, text: "前の回 2" });
        yield* TestClock.adjust(1);
        expect(fakeSinks.finals.map((f) => f.id)).toEqual(["r1", "r2"]);

        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);
        fakeHelpers.send(1, { type: "remark", track: "相手", start: 2, end: 3, text: "後の回" });
        yield* TestClock.adjust(1);

        expect(fakeSinks.finals).toEqual([
          { id: "r1", track: "相手", text: "前の回 1" },
          { id: "r2", track: "自分", text: "前の回 2" },
          { id: "r3", track: "相手", text: "後の回" },
        ]);
        expect(fakeSinks.opened).toMatchObject({ count: 1, closed: 0 }); // 起動し直しで開き直さず、閉じない
        expect(yield* client.intakeStatuses).toEqual(["interrupted", "running"]);
      }));

    it.effect("起動し直しの最中に stop すると、起動中のヘルパー（2 回目）の stop が走る（base:1190）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } }, {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);

        yield* sessions.stop;

        expect(fakeHelpers.stops).toContain(1);
      }));

    it.effect("起動し直しの接続待ちの最中に server scope が終わると、起動中のヘルパー（2 回目）の stop が走る（base:1206）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } }, { hold: true }]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions, closeServer } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);

        expect(fakeHelpers.calls).toHaveLength(2); // 2 回目が接続待ちのまま
        expect(fakeHelpers.stops).not.toContain(1);

        yield* closeServer();

        expect(fakeHelpers.stops).toContain(1);
      }));
  });
});
