import { defaultClaude } from "../src/modelSelection.ts";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Console, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Scope, Stream } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { DiffUpdater, type HelperPartial, type IntakeLogEvent, type SettledRemark, type Track } from "../src/core/index.ts";
import { Helpers, HelperLaunchFailure, type HelperAttempt, type HelperExitInfo } from "../src/helpers.ts";
import { HelperExited, NoSession, SessionBusy } from "../src/sessionFailure.ts";
import { SessionSinks, type SessionSink } from "../src/sessionSinks.ts";
import { Sessions, SessionsDir, type SessionStart } from "../src/sessions.ts";
import { Viewers } from "../src/viewers.ts";
import { UpdaterUnavailable } from "../src/updaterUnavailable.ts";
import { settleUntil } from "./fixtures/sessionLayers.ts";

// Issue #240 段 3（ADR 0008）: Sessions の状態・start・stop・resume・status と起動し直しのループを、
// 偽の Helpers・SessionSinks の Layer と TestClock で確かめる（order.md:39）。本物の子プロセスは使わない。
// 本物の子プロセスのテストは server/test/server.heavy.test.ts の契約 6 本、SessionSinks 自身の実物 Layer の契約は
// server/test/sessionSinks.it.test.ts が確かめる（このファイルでは SessionSinks も偽物）。
//
// 想定する契約（このファイルが要求する Helpers・SessionSinks の形。段 3 の実装はこれを満たす）:
// - `Helpers.launch(args)` は 1 回分の起動を表す `HelperAttempt`（events の Stream・stop・exit・stderrTail）を
//   `Effect<HelperAttempt, HelperLaunchFailure, Scope.Scope>` で返す（Scope を閉じると後始末が走る。要件10,24,27,39,40）。
//   `events` はヘルパーが送った JSON 文字列を届いた順に流す Stream（helperSocket.ts の Queue を経由する想定）。
// - `SessionSinks.open(args)` はセッションの Scope の中で 1 回だけ呼ばれ、`SessionSink`
//   （partial・final・drain・clearSpeaking・stopRelays・appendLog・flush・exports・audioFileNames）を返す
//   （要件3,68,117,125）。Scope を閉じると updater が閉じる（CT-SINK-SCOPE）。

const APPS = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];

type AttemptScript = {
  connect?: boolean; // 既定 true。false なら接続失敗（HelperLaunchFailure）
  launchExit?: HelperExitInfo; // connect: false のとき、接続する前にヘルパーが終わった終わり方（HelperLaunchFailure.exit）。省略すると exit なし
  stderrTail?: string[];
  unexpectedExit?: { afterMs: number; exit: HelperExitInfo }; // 自発的な予期せぬ終了
  stopExit?: HelperExitInfo; // stop が呼ばれたときの終わり方（既定 SIGTERM）
  stopDelayMs?: number; // stop が呼ばれてから終わるまでの時間（既定 0）
  hold?: boolean; // 接続待ちのまま保つ。stopRequested が立つと止めて、stopExit（既定 SIGTERM）の HelperLaunchFailure で終わる
};

type FakeHelpersHandle = {
  readonly helpers: Helpers["Service"];
  readonly calls: ReadonlyArray<ReadonlyArray<string>>; // launch に渡された argv（起動した回数も分かる）
  readonly send: (attemptIndex: number, event: unknown) => void; // 指定した起動回の events へ 1 件流す
  readonly stops: number[]; // stop が実際に走った起動回（0 始まり）。ヘルパーが止められたことを観測する
};

// 偽の Helpers。台本（attempts）の数を超えたら最後の台本を使い回す
function makeFakeHelpers(attempts: AttemptScript[]): Effect.Effect<FakeHelpersHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const calls: string[][] = [];
    const queues: Queue.Queue<unknown, Cause.Done>[] = [];
    const stops: number[] = [];
    const launch = (args: ReadonlyArray<string>, stopRequested: Deferred.Deferred<void>): Effect.Effect<HelperAttempt, HelperLaunchFailure, Scope.Scope> =>
      Effect.gen(function* () {
        const index = calls.length;
        calls.push([...args]);
        const script = attempts[Math.min(index, attempts.length - 1)] ?? {};
        if (script.connect === false) {
          // 起動し直しの接続は、試みて失敗するまでに少し時間がかかる（失敗が同じ瞬間に連鎖して、途切れの状態を飛ばさない）
          if (index > 0) yield* Effect.sleep(1);
          return yield* new HelperLaunchFailure({ stderrTail: script.stderrTail ?? [], exit: script.launchExit });
        }
        if (script.hold) {
          // 接続待ちのまま、印か Scope の終了を待つ。止められたら 1 回だけ stops に記録する
          let stopped = false;
          const recordStop = Effect.sync(() => {
            if (stopped) return;
            stopped = true;
            stops.push(index);
          });
          yield* Effect.addFinalizer(() => recordStop);
          yield* Deferred.await(stopRequested);
          yield* recordStop;
          return yield* new HelperLaunchFailure({ stderrTail: script.stderrTail ?? [], exit: script.stopExit ?? { code: null, signal: "SIGTERM" } });
        }
        const queue = yield* Queue.make<unknown, Cause.Done>();
        queues[index] = queue;
        const exitDeferred = yield* Deferred.make<HelperExitInfo>();
        const stoppedRef = yield* Ref.make(false);
        if (script.unexpectedExit) {
          yield* Effect.forkScoped(Effect.gen(function* () {
            yield* Effect.sleep(script.unexpectedExit!.afterMs);
            const already = yield* Ref.getAndSet(stoppedRef, true);
            if (already) return;
            yield* Queue.end(queue);
            yield* Deferred.succeed(exitDeferred, script.unexpectedExit!.exit);
          }));
        }
        const stop = Effect.gen(function* () {
          const already = yield* Ref.getAndSet(stoppedRef, true);
          if (already) return;
          stops.push(index);
          if (script.stopDelayMs) yield* Effect.sleep(script.stopDelayMs);
          yield* Queue.end(queue);
          yield* Deferred.succeed(exitDeferred, script.stopExit ?? { code: null, signal: "SIGTERM" });
        });
        yield* Effect.addFinalizer(() => Effect.ignore(stop));
        return {
          events: Stream.fromQueue(queue) as Stream.Stream<string>,
          stop,
          exit: Deferred.await(exitDeferred),
          stderrTail: Effect.succeed(script.stderrTail ?? []),
        };
      });
    const send = (attemptIndex: number, event: unknown) => {
      const queue = queues[attemptIndex];
      if (!queue) throw new Error(`起動回 ${attemptIndex} はまだ接続していない`);
      Queue.offerUnsafe(queue, JSON.stringify(event));
    };
    return { helpers: Helpers.of({ apps: Effect.succeed(APPS), launch }), calls, send, stops };
  });
}

type FakeSinksHandle = {
  readonly sinks: SessionSinks["Service"];
  readonly opened: { count: number; closed: number };
  readonly finals: { id: string; track: Track; text: string }[];
  readonly partials: { track: Track; text: string }[];
  readonly screens: { start: number; image: Uint8Array | null }[];
  readonly screenOffs: { start: number; reason: "指定" | "許可なし" }[];
  readonly sequence: string[]; // screenOff と final が届いた順（ログの行の順を観測する）
  readonly relayStats: { drained: number; cleared: number; stopped: number };
  readonly appended: IntakeLogEvent[];
  readonly order: string[]; // flush・exports・close が起きた順
  readonly control: { createDirFails: boolean; finalDiesOn: string | undefined }; // finalDiesOn: この text の remark を final に渡すと defect になる
};

// 偽の SessionSinks。ID の採番だけ本物の規則（セッションにつき 1 回のクロージャ、r1 から）を真似る。
// 覆い（settle.ts）の規則は真似ない（その規則は remarkSettling.test.ts・settle.test.ts が別に固定している）
function makeFakeSessionSinks(options: { exportsFails?: boolean } = {}): Effect.Effect<FakeSinksHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const opened = { count: 0, closed: 0 };
    const finals: { id: string; track: Track; text: string }[] = [];
    const partials: { track: Track; text: string }[] = [];
    const screens: { start: number; image: Uint8Array | null }[] = [];
    const screenOffs: { start: number; reason: "指定" | "許可なし" }[] = [];
    const sequence: string[] = [];
    const relayStats = { drained: 0, cleared: 0, stopped: 0 };
    const appended: IntakeLogEvent[] = [];
    const order: string[] = [];
    const control: { createDirFails: boolean; finalDiesOn: string | undefined } = { createDirFails: false, finalDiesOn: undefined };
    const open = (args: { dir: string }): Effect.Effect<SessionSink, never, Scope.Scope> =>
      Effect.gen(function* () {
        opened.count++;
        let count = 0;
        yield* Effect.addFinalizer(() => Effect.sync(() => { opened.closed++; order.push("close"); }));
        const sink: SessionSink = {
          dir: args.dir,
          partial: (p: HelperPartial) => Effect.sync(() => { partials.push({ track: p.track, text: p.text }); }),
          final: (r: SettledRemark) => Effect.suspend(() => r.text === control.finalDiesOn ? Effect.die(new Error("ログに書けません")) : Effect.sync(() => { count++; sequence.push("final"); finals.push({ id: `r${count}`, track: r.track, text: r.text }); })),
          screen: (s) => Effect.sync(() => { screens.push({ start: s.start, image: s.image }); }),
          screenOff: (e) => Effect.sync(() => { sequence.push(`screenOff:${e.reason}`); screenOffs.push({ start: e.start, reason: e.reason }); }),
          drain: Effect.sync(() => { relayStats.drained++; }),
          clearSpeaking: Effect.sync(() => { relayStats.cleared++; }),
          stopRelays: Effect.sync(() => { relayStats.stopped++; }),
          appendLog: (event: IntakeLogEvent) => Effect.sync(() => { appended.push(event); }),
          flush: Effect.sync(() => { order.push("flush"); }),
          exports: options.exportsFails ? Effect.die(new Error("書き出しに失敗")) : Effect.sync(() => { order.push("exports"); return [`${args.dir}/map.md`, `${args.dir}/map.json`, `${args.dir}/map.drawnix`, `${args.dir}/map.png`]; }),
          audioFileNames: (attempt: number) => (attempt > 1 ? [`相手-${attempt}.m4a`, `自分-${attempt}.m4a`] : ["相手.m4a", "自分.m4a"]),
        };
        return sink;
      });
    let dirCount = 0;
    const createDir = (_sessionsDir: string) => Effect.suspend(() => (control.createDirFails ? Effect.die(new Error("フォルダを作れません")) : Effect.succeed(`/tmp/live-mindmap-fake/${++dirCount}`)));
    return { sinks: SessionSinks.of({ open, createDir, prepare: () => Effect.succeed(Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.succeed({ ops: [] }) }))) }), opened, finals, partials, screens, screenOffs, sequence, relayStats, appended, order, control };
  });
}

// 本物の startup と同じ形（Layer.build + Context.get。server/src/http.ts:214-217 が手本）で Sessions を取り出す。
// scope を自分で持つことで、「サーバーの Scope を閉じる」を明示的なタイミングで起こせる（CT-CLOSE-ONLY-INTERRUPT）
const bootSessions = (helpersLayer: Layer.Layer<Helpers>, sinksLayer: Layer.Layer<SessionSinks>) =>
  Effect.gen(function* () {
    // テストの終了で必ず解放する（closeServer で先に閉じても、二重の close は何もしない）
    const scope = yield* Effect.acquireRelease(Scope.make(), (made) => Scope.close(made, Exit.void));
    const context = yield* Scope.provide(Layer.build(Sessions.layer.pipe(Layer.provideMerge(Layer.mergeAll(helpersLayer, sinksLayer, Layer.succeed(SessionsDir)("/tmp/live-mindmap-fake"), Viewers.layer)))), scope);
    return { sessions: Context.get(context, Sessions), viewers: Context.get(context, Viewers), closeServer: () => Scope.close(scope, Exit.void) };
  });

describe("推論プロセスの準備をセッションが所有する", () => {
  const preparation = Effect.fnUntraced(function* (fake: FakeSinksHandle) {
    const ready = yield* Deferred.make<void, UpdaterUnavailable>();
    const control = { ready };
    const state = { opened: 0, closed: 0, createdDirs: 0, flushAlive: false, exportsAlive: false };
    const original = fake.sinks;
    const sinks = SessionSinks.of({
      ...original,
      createDir: (dir) => Effect.andThen(Effect.sync(() => { state.createdDirs++; }), original.createDir(dir)),
      prepare: () => Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => { state.opened++; }),
          () => Effect.sync(() => { state.closed++; }),
        );
        yield* Deferred.await(control.ready);
        return Layer.succeed(DiffUpdater, DiffUpdater.of({ update: () => Effect.succeed({ ops: [] }) }));
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
    const starting = yield* Effect.forkChild(sessions.start({ app: "us.zoom.xos", model: defaultClaude, audio: false, screen: false, title: undefined }));
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
    const input = { app: "us.zoom.xos", model: defaultClaude, audio: false, screen: false, title: undefined };
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

  it.effect("準備完了後に音声ヘルパーの起動が失敗しても推論子を閉じる", () => Effect.gen(function* () {
    const helper = yield* makeFakeHelpers([{ connect: false }]);
    const fake = yield* makeFakeSessionSinks();
    const prep = yield* preparation(fake);
    yield* Deferred.succeed(prep.ready, undefined);
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), prep.layer);
    const result = yield* Effect.exit(sessions.start({ app: "us.zoom.xos", model: defaultClaude, audio: false, screen: false, title: undefined }));
    expect(Exit.isFailure(result)).toBe(true);
    expect(helper.calls).toHaveLength(1);
    expect(prep.state).toMatchObject({ opened: 1, closed: 1 });
    expect(fake.opened.count).toBe(0);
  }));

  it.effect("取得済みの推論子の準備待ちを中断したら閉じ、会議を始めない", () => Effect.gen(function* () {
    const helper = yield* makeFakeHelpers([{}]);
    const fake = yield* makeFakeSessionSinks();
    const prep = yield* preparation(fake);
    const { sessions } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), prep.layer);
    const starting = yield* Effect.forkChild(sessions.start({ app: "us.zoom.xos", model: defaultClaude, audio: false, screen: false, title: undefined }));
    yield* settleUntil(() => prep.state.opened === 1);
    expect(prep.state.opened).toBe(1);
    yield* Fiber.interrupt(starting);
    expect(prep.state.closed).toBe(1);
    expect(helper.calls).toEqual([]);
    expect(prep.state.createdDirs).toBe(0);
    expect(fake.opened.count).toBe(0);
  }));

  it.effect("音声ヘルパーを起動し直しても同じ推論子を保ち、サーバー終了で閉じる", () => Effect.gen(function* () {
    const helper = yield* makeFakeHelpers([{ unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } }, {}]);
    const fake = yield* makeFakeSessionSinks();
    const prep = yield* preparation(fake);
    yield* Deferred.succeed(prep.ready, undefined);
    const { sessions, closeServer } = yield* bootSessions(Layer.succeed(Helpers, helper.helpers), prep.layer);
    yield* sessions.start({ app: "us.zoom.xos", model: defaultClaude, audio: false, screen: false, title: undefined });
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
  const closed = yield* Deferred.make<never, Socket.SocketError>();
  const write: Socket.Writer["write"] = (chunk) => Effect.gen(function* () {
    if (Socket.isCloseEvent(chunk)) return;
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    yield* Queue.offer(frames, JSON.parse(text));
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
  return { socket, intakeStatuses, screenNotices };
});

// Console.error に渡された行を、Node の console と同じ形（引数を空白で連ねて末尾に改行 1 つ）で集める Console。
// note は Console.error を呼ぶので、標準エラーに出るバイト列（改行の数）をここで確かめられる
const collectingStderr = () => {
  const stderr: string[] = [];
  const service: Console.Console = { ...console, error: (...args: unknown[]) => { stderr.push(args.map(String).join(" ") + "\n"); } };
  return { stderr, service };
};

// run の間に Console.error へ渡された文字列を集める（サーバーの標準エラーへの記録を観測する）。
// start を呼ぶ fiber の context を、ヘルパーを読むループが受け継ぐので、start を含む Effect 全体を渡す
const captureStderr = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { stderr, service } = collectingStderr();
    yield* Effect.provideService(run, Console.Console, service);
    return stderr;
  });

const withStderr = <A, E, R>(body: (stderr: string[]) => Effect.Effect<A, E, R>) => {
  const { stderr, service } = collectingStderr();
  return Effect.provideService(Effect.suspend(() => body(stderr)), Console.Console, service);
};

const start = (input: Partial<SessionStart> = {}): SessionStart => ({ app: "us.zoom.xos", title: undefined, audio: true, screen: true, model: defaultClaude, ...input });

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

    it.effect("知らない type は読み飛ばされ、stderr に何も出さずセッションが続く", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start());
          fakeHelpers.send(0, { type: "heartbeat" });
          fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "つづく" });
          yield* TestClock.adjust(1);

          expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "つづく" });
          expect(stderr).toEqual([]);
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("知っている type で項目が壊れていれば、今の文面で stderr に 1 行出して読み続ける", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start());
          fakeHelpers.send(0, { type: "remark", track: "司会", start: 0, end: 1, text: "あ" }); // 不正な track
          fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "つづく" });
          yield* TestClock.adjust(1);

          expect(stderr.some((s) => s.includes("ヘルパーのイベントを読み飛ばしました"))).toBe(true);
          expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "つづく" }); // セッションは止まらず続く
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("受け渡しの途中で defect になれば、読み飛ばしとは別の文面で stderr に 1 行出して読み続ける", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        fakeSinks.control.finalDiesOn = "こわれる";
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start());
          fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "こわれる" }); // 形は正しいが、sink.final が defect になる
          fakeHelpers.send(0, { type: "remark", track: "相手", start: 1, end: 2, text: "つづく" });
          yield* TestClock.adjust(1);

          expect(stderr.filter((s) => s.includes("ヘルパーのイベントの処理に失敗しました"))).toHaveLength(1);
          expect(stderr.filter((s) => s.includes("ログに書けません"))).toHaveLength(1); // 理由が付く
          expect(stderr.some((s) => s.includes("読み飛ばしました"))).toBe(false); // decode の失敗の文面は出ない
          expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "つづく" }); // セッションは止まらず続く
        }).pipe(Effect.provideService(Console.Console, service));
      }));

    it.effect("形が読めない失敗には「処理に失敗しました」の文面を使わない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const { stderr, service } = collectingStderr();
        yield* Effect.gen(function* () {
          yield* sessions.start(start());
          fakeHelpers.send(0, { type: "remark", track: "司会", start: 0, end: 1, text: "あ" });
          yield* TestClock.adjust(1);

          expect(stderr.filter((s) => s.includes("ヘルパーのイベントを読み飛ばしました"))).toHaveLength(1);
          expect(stderr.some((s) => s.includes("処理に失敗しました"))).toBe(false);
        }).pipe(Effect.provideService(Console.Console, service));
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

    it.effect("知らせは届いてから約 10 秒で消すフレーム（text: null）が届き、その後につないだブラウザには出ない", () =>
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
        expect(yield* late.screenNotices).toEqual([]); // 期限後は再び出さない
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

    it.effect("stop で知らせの保持も消える（stop 後につないだブラウザには出ない）", () =>
      Effect.gen(function* () {
        const { fakeHelpers, sessions, viewers } = yield* boot([{}]);
        yield* sessions.start(start());
        fakeHelpers.send(0, { type: "screen-off", start: 1, reason: "許可なし" });
        yield* TestClock.adjust(1);
        yield* sessions.stop;

        const after = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(after.socket));
        expect(yield* after.screenNotices).toEqual([]);
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
    it.effect("予期せず終了すると自動で起動し直し、起動の回数は Ref で保たれる", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          {},
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        yield* TestClock.adjust(500);
        yield* TestClock.adjust(1); // 起動し直しのループが次の launch を行うための 1 tick

        expect(fakeHelpers.calls).toHaveLength(2);
        const status = yield* sessions.status;
        expect(status.restarts).toBe(1);
      }));

    it.effect("60 秒以内の終了が 3 回続くと諦めて止まった状態になる。4 回目は起動しない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { connect: false, stderrTail: ["起動に失敗"] },
          { connect: false, stderrTail: ["起動に失敗"] },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);

        expect(fakeHelpers.calls).toHaveLength(3); // 4 回目は起動しない
        const status = yield* sessions.status;
        expect(status.status).toBe("stopped");
      }));

    it.effect("60 秒を超えて動いた回は失敗に数えない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 61_000, exit: { code: 1, signal: null } } },
          { unexpectedExit: { afterMs: 61_000, exit: { code: 1, signal: null } } },
          { unexpectedExit: { afterMs: 61_000, exit: { code: 1, signal: null } } },
          {},
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        for (let i = 0; i < 3; i++) {
          yield* TestClock.adjust(61_000);
          yield* TestClock.adjust(10);
        }

        // 3 回とも 60 秒を超えて動いたので、1 本も「続けて失敗」に数えず、4 回目も起動する（諦めない）
        expect(fakeHelpers.calls).toHaveLength(4);
        const status = yield* sessions.status;
        expect(status.status).toBe("running");
      }));

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

    it.effect("止まった状態から resume すると、失敗の数を 0 から数え直して起動し直す", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 5, exit: { code: 1, signal: null } } }, // start の初回。すぐ終わる（失敗 1）
          { connect: false, stderrTail: ["失敗2"] },
          { connect: false, stderrTail: ["失敗3"] },
          { unexpectedExit: { afterMs: 200, exit: { code: 1, signal: null } } }, // resume による 1 回目。すぐ終わる
          {}, // 自動の起動し直し。そのまま動き続ける
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        yield* TestClock.adjust(10);
        expect((yield* sessions.status).status).toBe("stopped");

        // resume は 1 回目の起動し直しが接続した時点で戻る（時計は要らない）。そのヘルパーが 200ms 後に終わるので、
        // 起動し直しが終わって戻ってから時計を進める（resume が起動を始める前に時計を進めると、終わる時刻がずれる）
        yield* sessions.resume;
        yield* TestClock.adjust(200);
        yield* TestClock.adjust(10);

        expect(fakeHelpers.calls).toHaveLength(5); // 1 回の失敗だけで再度諦めていれば 4 回で止まる
        expect((yield* sessions.status).status).toBe("running");
      }));

    it.effect("resume した後に 3 回続けて失敗すると、諦めて stderr 末尾付きの失敗を返す", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { connect: false, stderrTail: ["失敗2"] },
          { connect: false, stderrTail: ["失敗3"] },
          { connect: false, stderrTail: ["失敗4"] },
          { connect: false, stderrTail: ["失敗5"] },
          { connect: false, stderrTail: ["最後の失敗"] },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        yield* TestClock.adjust(500);
        yield* TestClock.adjust(10);
        expect((yield* sessions.status).status).toBe("stopped");

        const resumeFiber = yield* Effect.forkChild(Effect.exit(sessions.resume));
        yield* TestClock.adjust(10);
        const result = yield* Fiber.join(resumeFiber);

        expect(Exit.isFailure(result)).toBe(true);
        expect((yield* sessions.status).status).toBe("stopped");
      }));
  });

  // ヘルパーの終了コード 75（シグナルなし）は、マイクの入力の構成の変化（入力の機器の切り替えなど）による終了。
  // 失敗の連続には数えず、別の歯止め（60 秒に 10 回を超えたら諦める）で数える。
  describe("構成の変化による終了（終了コード 75）は諦める回数に数えない", () => {
    const configChange = (afterMs = 500): AttemptScript => ({ unexpectedExit: { afterMs, exit: { code: 75, signal: null } } });
    const crash = (afterMs = 500): AttemptScript => ({ unexpectedExit: { afterMs, exit: { code: 1, signal: null } } });
    const repeat = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => value);
    // 終了が 1 回起きて、起動し直しのループが次の launch まで進むための時間（時計は 500ms 進めたあとに少し進める）
    const cycle = Effect.gen(function* () {
      yield* TestClock.adjust(500);
      yield* TestClock.adjust(10);
    });
    const gaveUp = (appended: ReadonlyArray<IntakeLogEvent>) => appended.filter((e) => e.type === "intake-gave-up");

    it.effect("60 秒以内に 5 回続けて届いても止まった状態にならず、次の起動が行われ、最後は running。intake-gave-up は書かれない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([...repeat(5, configChange()), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        for (let i = 0; i < 5; i++) yield* cycle;

        expect(fakeHelpers.calls).toHaveLength(6); // 3 回で諦める規則なら 3 回で止まる
        expect((yield* sessions.status).status).toBe("running");
        expect(gaveUp(fakeSinks.appended)).toHaveLength(0);
      }));

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

    it.effect("壊れて落ちる場合: 構成の変化を挟んでも、コード 1 の 3 回目で止まった状態になる。intake-gave-up の reason は failures", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([crash(), configChange(), crash(), configChange(), crash(), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        for (let i = 0; i < 5; i++) yield* cycle;

        expect(fakeHelpers.calls).toHaveLength(5); // 6 回目は起動しない
        expect((yield* sessions.status).status).toBe("stopped");
        expect(gaveUp(fakeSinks.appended)).toEqual([{ type: "intake-gave-up", reason: "failures" }]);
      }));

    it.effect("壊れて落ちる場合: 構成の変化が失敗の数を 0 に戻さない（1 → 75 → 1 → 75 → 1 でも、1 が 3 回で止まる）。シグナル終了も数える", () =>
      Effect.gen(function* () {
        const signalExit: AttemptScript = { unexpectedExit: { afterMs: 500, exit: { code: null, signal: "SIGKILL" } } };
        const fakeHelpers = yield* makeFakeHelpers([configChange(), crash(), configChange(), signalExit, configChange(), crash(), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        for (let i = 0; i < 6; i++) yield* cycle;

        expect(fakeHelpers.calls).toHaveLength(6);
        expect((yield* sessions.status).status).toBe("stopped");
        expect(gaveUp(fakeSinks.appended)).toEqual([{ type: "intake-gave-up", reason: "failures" }]);
      }));

    it.effect("歯止め: 60 秒以内に 10 回までは止まらない（10 回目の後に 11 回目の起動が行われ、running）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([...repeat(10, configChange()), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        for (let i = 0; i < 10; i++) yield* cycle;

        expect(fakeHelpers.calls).toHaveLength(11);
        expect((yield* sessions.status).status).toBe("running");
        expect(gaveUp(fakeSinks.appended)).toHaveLength(0);
      }));

    it.effect("歯止め: 60 秒以内に 11 回続くと止まった状態になり、12 回目は起動しない。reason は configuration-changes で、標準エラーに歯止めの文言が出る", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([...repeat(11, configChange()), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const stderr = yield* captureStderr(Effect.gen(function* () {
          yield* sessions.start(start());
          for (let i = 0; i < 11; i++) yield* cycle;
          yield* TestClock.adjust(1_000); // 12 回目の起動がないことを確かめるための余分な時間
        }));

        expect(fakeHelpers.calls).toHaveLength(11);
        expect((yield* sessions.status).status).toBe("stopped");
        expect(gaveUp(fakeSinks.appended)).toEqual([{ type: "intake-gave-up", reason: "configuration-changes" }]);
        expect(stderr.join("")).toContain("マイクの入力の構成の変化が 60 秒に 10 回を超えて続いたため、起動し直しを諦めました。取り込みは止まった状態です");
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

    it.effect("窓が進む場合: 10 回届いた後に 60 秒を超えて動いてから届き、さらに続いても止まらない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([...repeat(10, configChange()), configChange(62_000), ...repeat(5, configChange()), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        for (let i = 0; i < 10; i++) yield* cycle;
        yield* TestClock.adjust(62_000);
        yield* TestClock.adjust(10);
        for (let i = 0; i < 5; i++) yield* cycle;

        // 窓が進まず通算で数えていれば、11 回目（62 秒後の終了）で止まる
        expect(fakeHelpers.calls).toHaveLength(17);
        expect((yield* sessions.status).status).toBe("running");
        expect(gaveUp(fakeSinks.appended)).toHaveLength(0);
      }));

    it.effect("resume: 歯止めで止まった後の resume で、構成の変化の数も空から数え直す（10 回続いても止まらない）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([...repeat(21, configChange()), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());
        for (let i = 0; i < 11; i++) yield* cycle;
        expect((yield* sessions.status).status).toBe("stopped");
        expect(fakeHelpers.calls).toHaveLength(11);

        // 同じセッションのまま resume する。数えた記録が残っていれば、最初の終了で止まる
        yield* sessions.resume;
        for (let i = 0; i < 10; i++) yield* cycle;

        expect(fakeHelpers.calls).toHaveLength(22);
        expect((yield* sessions.status).status).toBe("running");
        expect(gaveUp(fakeSinks.appended)).toHaveLength(1); // 最初の歯止めの 1 件だけ
      }));

    it.effect("接続する前に終わる場合: 終了コード 75 は、接続前の経路でも失敗に数えない（3 回を超えて続いても止まらない）", () =>
      Effect.gen(function* () {
        const beforeConnect: AttemptScript = { connect: false, launchExit: { code: 75, signal: null }, stderrTail: ["構成の変化"] };
        const fakeHelpers = yield* makeFakeHelpers([crash(), ...repeat(4, beforeConnect), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        yield* TestClock.adjust(500);
        yield* TestClock.adjust(50);

        // 接続前の 75 を失敗に数えていれば、コード 1（1 回目）と合わせて 3 回目で止まる
        expect(fakeHelpers.calls).toHaveLength(6);
        expect((yield* sessions.status).status).toBe("running");
        expect(gaveUp(fakeSinks.appended)).toHaveLength(0);
      }));

    it.effect("接続する前に終わる場合: 終了コード 75 が 11 回続くと、接続前の経路でも歯止めで止まる", () =>
      Effect.gen(function* () {
        const beforeConnect: AttemptScript = { connect: false, launchExit: { code: 75, signal: null }, stderrTail: ["構成の変化"] };
        const fakeHelpers = yield* makeFakeHelpers([crash(), ...repeat(11, beforeConnect), {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        yield* TestClock.adjust(500);
        yield* TestClock.adjust(100);

        expect(fakeHelpers.calls).toHaveLength(12); // 最初の 1 回と接続前の 11 回。13 回目は起動しない
        expect((yield* sessions.status).status).toBe("stopped");
        expect(gaveUp(fakeSinks.appended)).toEqual([{ type: "intake-gave-up", reason: "configuration-changes" }]);
      }));

    it.effect("接続する前に終わる場合: コード 75 でもシグナルが付いた終了は失敗に数える（3 回で止まる）", () =>
      Effect.gen(function* () {
        const withSignal: AttemptScript = { connect: false, launchExit: { code: 75, signal: "SIGKILL" }, stderrTail: ["kill"] };
        const fakeHelpers = yield* makeFakeHelpers([crash(), withSignal, withSignal, {}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        yield* sessions.start(start());

        yield* TestClock.adjust(500);
        yield* TestClock.adjust(50);

        expect(fakeHelpers.calls).toHaveLength(3);
        expect((yield* sessions.status).status).toBe("stopped");
        expect(gaveUp(fakeSinks.appended)).toEqual([{ type: "intake-gave-up", reason: "failures" }]);
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
        yield* TestClock.adjust(1);
        const interrupted = yield* sessions.status;
        expect(interrupted.status).toBe("interrupted");
        expect(interrupted.lastInterruptedAt).toMatch(/^1970-01-01T00:00:00\.50[01]Z$/); // Clock（TestClock）の時刻を ISO 形式で書く

        yield* TestClock.adjust(10);
        const stopped = yield* sessions.status;
        expect(stopped.status).toBe("stopped");
        expect(stopped.dir).toBe("/tmp/live-mindmap-fake/1"); // 止まった後もセッションのフォルダは引き続き出る
        expect(stopped.restarts).toBe(0); // 起動し直しに成功した回がない
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

    it.effect("stop が書き出しで失敗しても、updater は 1 回閉じ、予約は止まり、状態は none に戻って、次のセッションを開始できる（CT-SINK-SCOPE / 要件128,129）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks({ exportsFails: true });
        const { sessions, viewers } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const watcher = yield* viewerClient();
        yield* Effect.forkChild(viewers.connect(watcher.socket));
        yield* sessions.start(start());

        const exit = yield* Effect.exit(sessions.stop);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(fakeSinks.opened).toMatchObject({ count: 1, closed: 1 });
        expect(fakeSinks.relayStats.stopped).toBe(1);
        expect((yield* sessions.status).status).toBe("none");
        expect((yield* watcher.intakeStatuses).at(-1)).toBe("none"); // 失敗しても、接続中のクライアントの一言は消える
        yield* sessions.start(start());
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

    it.effect("セッションのフォルダを作れず start が失敗しても、ヘルパーも SessionSinks も起動せず、直せば続けて start・stop できる（base:591）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        fakeSinks.control.createDirFails = true;

        const failed = yield* Effect.exit(sessions.start(start()));

        expect(Exit.isFailure(failed)).toBe(true);
        expect(fakeHelpers.calls).toHaveLength(0);
        expect(fakeSinks.opened.count).toBe(0);
        expect((yield* sessions.status).status).toBe("none");

        fakeSinks.control.createDirFails = false;
        yield* sessions.start(start());
        expect((yield* sessions.status).status).toBe("running");
        yield* sessions.stop;
        expect((yield* sessions.status).status).toBe("none");
        expect(fakeHelpers.calls).toHaveLength(1);
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

    it.effect("途切れ・起動し直し・諦めは log に残り（intake-stopped・intake-restarted の trigger・intake-gave-up）、諦めたときは stderr に出る（base:1076, 1112, 1154）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 5, exit: { code: 1, signal: null } } },
          { connect: false, stderrTail: ["失敗2"] },
          { connect: false, stderrTail: ["失敗3"] },
          { unexpectedExit: { afterMs: 200, exit: { code: 1, signal: null } } }, // resume による 1 回目
          {}, // 自動の起動し直し
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const stderr = yield* captureStderr(Effect.gen(function* () {
          yield* sessions.start(start());
          yield* TestClock.adjust(10);
          expect((yield* sessions.status).status).toBe("stopped");
        }));
        expect(stderr.join("")).toMatch(/諦め|止まっ/);
        expect(fakeSinks.appended.filter((e) => e.type === "intake-gave-up")).toEqual([{ type: "intake-gave-up", reason: "failures" }]);
        expect(stderr.join("")).toContain("起動し直しを諦めました。取り込みは止まった状態です");
        // 出力のバイト列は今のまま: 1 行ごとに改行がちょうど 1 つ（note が渡す末尾の改行と Console.error が足す改行が重ならない）
        expect(stderr).toContain("取り込みが止まった（1）\n");
        expect(stderr).toContain("起動し直しを諦めました。取り込みは止まった状態です\n");
        expect(stderr.every((line) => line.endsWith("\n") && !line.endsWith("\n\n"))).toBe(true);
        expect(stderr.join("")).not.toContain("構成の変化");
        expect(fakeSinks.appended.some((e) => e.type === "intake-stopped" && e.stderrTail.includes("失敗3"))).toBe(true);

        yield* sessions.resume;
        yield* TestClock.adjust(200);
        yield* TestClock.adjust(10);

        const restarted = fakeSinks.appended.filter((e) => e.type === "intake-restarted").map((e) => (e as { trigger: string }).trigger);
        expect(restarted.filter((t) => t === "resume")).toHaveLength(1);
        expect(restarted.filter((t) => t === "auto")).toHaveLength(1);
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
