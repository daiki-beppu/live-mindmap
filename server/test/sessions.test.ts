import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Scope, Stream } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import type { HelperPartial, IntakeLogEvent, SettledRemark, Track } from "../src/core/index.ts";
import { Helpers, HelperLaunchFailure, type HelperAttempt, type HelperExitInfo } from "../src/helpers.ts";
import { HelperExited, NoSession, SessionBusy } from "../src/sessionFailure.ts";
import { SessionSinks, type SessionSink } from "../src/sessionSinks.ts";
import { Sessions, SessionsDir, type SessionStart } from "../src/sessions.ts";
import { Viewers } from "../src/viewers.ts";

// Issue #240 段 3（ADR 0008）: Sessions の状態・start・stop・resume・status と起動し直しのループを、
// 偽の Helpers・SessionSinks の Layer と TestClock で確かめる（order.md:39）。本物の子プロセスは使わない。
// 本物の子プロセスのテストは server/test/server.test.ts の契約 6 本、SessionSinks 自身の実物 Layer の契約は
// server/test/sessionSinks.test.ts が確かめる（このファイルでは SessionSinks も偽物）。
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
          return yield* new HelperLaunchFailure({ stderrTail: script.stderrTail ?? [] });
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
  readonly relayStats: { drained: number; cleared: number; stopped: number };
  readonly appended: IntakeLogEvent[];
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
    const relayStats = { drained: 0, cleared: 0, stopped: 0 };
    const appended: IntakeLogEvent[] = [];
    const order: string[] = [];
    const control = { createDirFails: false };
    const open = (args: { dir: string }): Effect.Effect<SessionSink, never, Scope.Scope> =>
      Effect.gen(function* () {
        opened.count++;
        let count = 0;
        yield* Effect.addFinalizer(() => Effect.sync(() => { opened.closed++; order.push("close"); }));
        const sink: SessionSink = {
          dir: args.dir,
          partial: (p: HelperPartial) => Effect.sync(() => { partials.push({ track: p.track, text: p.text }); }),
          final: (r: SettledRemark) => Effect.sync(() => { count++; finals.push({ id: `r${count}`, track: r.track, text: r.text }); }),
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
    return { sinks: SessionSinks.of({ open, createDir }), opened, finals, partials, relayStats, appended, order, control };
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
  return { socket, intakeStatuses };
});

const start = (input: Partial<SessionStart> = {}): SessionStart => ({ app: "us.zoom.xos", title: undefined, audio: true, ...input });

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
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
          yield* sessions.start(start());
          fakeHelpers.send(0, { type: "heartbeat" });
          fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "つづく" });
          yield* TestClock.adjust(1);

          expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "つづく" });
          expect(stderr).toEqual([]);
        } finally {
          process.stderr.write = original;
        }
      }));

    it.effect("知っている type で項目が壊れていれば、今の文面で stderr に 1 行出して読み続ける", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{}]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
          yield* sessions.start(start());
          fakeHelpers.send(0, { type: "remark", track: "司会", start: 0, end: 1, text: "あ" }); // 不正な track
          fakeHelpers.send(0, { type: "remark", track: "相手", start: 0, end: 1, text: "つづく" });
          yield* TestClock.adjust(1);

          expect(stderr.some((s) => s.includes("ヘルパーのイベントを読み飛ばしました"))).toBe(true);
          expect(fakeSinks.finals).toContainEqual({ id: "r1", track: "相手", text: "つづく" }); // セッションは止まらず続く
        } finally {
          process.stderr.write = original;
        }
      }));
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
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
          yield* sessions.start(start({ audio: true }));

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(true);
          const warning = stderr.find((s) => s.includes("録音の書き終わりを確認できない"));
          expect(warning).toBeDefined();
          expect(warning).toContain("相手.m4a");
          expect(warning).toContain("自分.m4a");
        } finally {
          process.stderr.write = original;
        }
      }));

    it.effect("--no-audio では、SIGKILL で止めますは出るが、録音の警告は出ない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ stopExit: { code: null, signal: "SIGKILL" } }]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
          yield* sessions.start(start({ audio: false }));

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(true);
          expect(stderr.some((s) => s.includes("録音の書き終わり"))).toBe(false);
        } finally {
          process.stderr.write = original;
        }
      }));

    it.effect("SIGTERM で終わったときは、どちらの行も出ない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([{ stopExit: { code: null, signal: "SIGTERM" } }]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
          yield* sessions.start(start({ audio: true }));

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(false);
          expect(stderr.some((s) => s.includes("録音の書き終わり"))).toBe(false);
        } finally {
          process.stderr.write = original;
        }
      }));

    it.effect("警告の起動回（attempt）は、起動し直した後の録音ファイル名を示す", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { stopExit: { code: null, signal: "SIGKILL" } },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
          yield* sessions.start(start({ audio: true }));
          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);

          yield* sessions.stop;

          const warning = stderr.find((s) => s.includes("録音の書き終わりを確認できない"));
          expect(warning).toContain("相手-2.m4a");
          expect(warning).toContain("自分-2.m4a");
          expect(warning).not.toContain("相手.m4a");
        } finally {
          process.stderr.write = original;
        }
      }));

    it.effect("起動し直しの接続待ちの最中に stop し、SIGKILL で終わったとき、録音が有効なら両方の警告が出る（相手-2.m4a）", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { hold: true, stopExit: { code: null, signal: "SIGKILL" } },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
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
        } finally {
          process.stderr.write = original;
        }
      }));

    it.effect("起動し直しの接続待ちの最中に stop し、SIGKILL で終わったとき、--no-audio なら SIGKILL の行だけが出る", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { hold: true, stopExit: { code: null, signal: "SIGKILL" } },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
          yield* sessions.start(start({ audio: false }));
          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);
          expect(fakeHelpers.calls).toHaveLength(2); // 2 回目が接続待ちのまま
          expect(fakeHelpers.stops).toEqual([]);

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(true);
          expect(stderr.some((s) => s.includes("録音の書き終わり"))).toBe(false);
        } finally {
          process.stderr.write = original;
        }
      }));

    it.effect("起動し直しの接続待ちの最中に stop し、SIGTERM で終わったときは、どちらの行も出ない", () =>
      Effect.gen(function* () {
        const fakeHelpers = yield* makeFakeHelpers([
          { unexpectedExit: { afterMs: 500, exit: { code: 1, signal: null } } },
          { hold: true, stopExit: { code: null, signal: "SIGTERM" } },
        ]);
        const fakeSinks = yield* makeFakeSessionSinks();
        const { sessions } = yield* bootSessions(Layer.succeed(Helpers)(fakeHelpers.helpers), Layer.succeed(SessionSinks)(fakeSinks.sinks));
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
          yield* sessions.start(start({ audio: true }));
          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);
          expect(fakeHelpers.calls).toHaveLength(2); // 2 回目が接続待ちのまま
          expect(fakeHelpers.stops).toEqual([]);

          yield* sessions.stop;

          expect(stderr.some((s) => s.includes("SIGKILL で止めます"))).toBe(false);
          expect(stderr.some((s) => s.includes("録音の書き終わり"))).toBe(false);
        } finally {
          process.stderr.write = original;
        }
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
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
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
        } finally {
          process.stderr.write = original;
        }
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
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = (() => true) as typeof process.stderr.write;
        try {
          yield* sessions.start(start());
          fakeHelpers.send(0, { type: "origin", hostTime: 123 }); // 壊れた形（number）
          yield* TestClock.adjust(1);

          yield* TestClock.adjust(500);
          yield* TestClock.adjust(10);

          expect(fakeHelpers.calls[1]).not.toContain("--origin");
        } finally {
          process.stderr.write = original;
        }
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
        expect(interrupted.lastInterruptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

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

  // base の server.test.ts の移動先のうち、偽の Helpers・SessionSinks と TestClock で観測できる残りの条件
  describe("セッションの中身の寿命・起動し直しをまたぐ連続性・ログ（base server.test.ts の移動先）", () => {
    const captureStderr = <A, E, R>(run: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const stderr: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: unknown) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
          yield* run;
        } finally {
          process.stderr.write = original;
        }
        return stderr;
      });

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
        expect(fakeSinks.appended.filter((e) => e.type === "intake-gave-up")).toHaveLength(1);
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
