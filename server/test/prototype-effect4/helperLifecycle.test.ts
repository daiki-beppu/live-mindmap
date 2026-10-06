// PROTOTYPE（issue #197）: helperLifecycle.ts を、偽物の Helpers と TestClock で確かめる。
// 今の server.test.ts は偽のヘルパーを子プロセスで起動して本物の時計で待つ。こちらは子プロセスも時計も偽物にして、
// 後始末が重なるとき（起動し直しの最中の stop、開始の途中でサーバーの終了など）を順番どおりに再現する
import { assert, describe, it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope } from "effect";
import { TestClock } from "effect/testing";
import { Helpers, SessionSinks, Sessions, SocketNotOpen, type ExitInfo, type IntakeSink, type StartRequest } from "../../src/prototype-effect4/helperLifecycle.ts";

type Behavior = { ready?: boolean; ignoreTerm?: boolean; exitOnSpawn?: number; stderr?: string };

type FakeHelper = {
  args: ReadonlyArray<string>;
  signals: string[];
  send: (message: string) => Effect.Effect<void>;
  exit: (code: number | null, signal?: string) => Effect.Effect<void>;
  becomeReady: (early: string[]) => Effect.Effect<void>;
};

const request: StartRequest = { app: "us.zoom.xos", title: undefined, audio: true };

// 偽のヘルパー。spawn するたびに、次の Behavior（無ければ「すぐつながる」）で動き、spawned に積む
const makeFakeHelpers = Effect.gen(function* () {
  const spawned = yield* Queue.unbounded<FakeHelper>();
  const behaviors: Behavior[] = [];
  const byPort = new Map<number, { ready: boolean; early: string[]; exited: Deferred.Deferred<ExitInfo>; messages?: Queue.Queue<string, Cause.Done> }>();
  let nextPort = 50_000;

  const service = Helpers.of({
    freePort: Effect.sync(() => nextPort++),
    spawn: (args) =>
      Effect.sync(() => {
        const behavior = behaviors.shift() ?? {};
        const port = Number(args[args.indexOf("--port") + 1]);
        const state = { ready: behavior.ready ?? true, early: [] as string[], exited: Deferred.makeUnsafe<ExitInfo>() };
        byPort.set(port, state);
        const signals: string[] = [];
        const exit = (code: number | null, signal: string | null = null) =>
          Effect.sync(() => {
            const s = byPort.get(port)!;
            if (s.messages) Queue.endUnsafe(s.messages); // ヘルパーが終われば ws も閉じる
            Deferred.doneUnsafe(state.exited, Effect.succeed({ code, signal }));
          });
        const fake: FakeHelper = {
          args,
          signals,
          send: (message) => Effect.sync(() => void Queue.offerUnsafe(byPort.get(port)!.messages!, message)),
          exit: (code, signal) => exit(code, signal ?? null),
          becomeReady: (early) => Effect.sync(() => Object.assign(byPort.get(port)!, { ready: true, early })),
        };
        if (behavior.exitOnSpawn !== undefined) Effect.runSync(exit(behavior.exitOnSpawn));
        Queue.offerUnsafe(spawned, fake);
        return {
          exited: state.exited,
          stderr: Effect.succeed(behavior.stderr ?? ""),
          kill: (signal) =>
            Effect.suspend(() => {
              signals.push(signal);
              return signal === "SIGKILL" || !behavior.ignoreTerm ? exit(null, signal) : Effect.void;
            }),
        };
      }),
    connectOnce: (port) =>
      Effect.gen(function* () {
        const s = byPort.get(port)!;
        if (!s.ready || (yield* Deferred.isDone(s.exited))) return yield* new SocketNotOpen();
        const messages = yield* Queue.unbounded<string, Cause.Done>();
        for (const m of s.early) Queue.offerUnsafe(messages, m);
        s.messages = messages;
        return messages;
      }),
  });
  return { service, next: Queue.take(spawned), pending: Queue.size(spawned), willSpawn: (b: Behavior) => behaviors.push(b) };
});

// セッションの側。起きたことを events に順に残し、取り込みの状態のフレームは frames からも待てる
const makeRecordingSinks = Effect.gen(function* () {
  const events: string[] = [];
  const frames = yield* Queue.unbounded<string>();
  const record = (e: string) => Effect.sync(() => void events.push(e));
  const service = SessionSinks.of({
    open: () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => record("updater-closed"));
        const sink: IntakeSink = {
          receive: (m) => record(`receive:${m}`),
          interrupted: record("interrupted"),
          log: (e) => record(e.type === "intake-restarted" ? `log:${e.type}:${e.trigger}` : `log:${e.type}`),
          intakeFrame: (status) => Effect.andThen(record(`frame:${status}`), Queue.offer(frames, status)),
          flush: record("flush"),
          exportFiles: Effect.as(record("export"), ["map.md"]),
        };
        return { dir: "/sessions/s1", sink };
      }),
  });
  return { service, events, nextFrame: Queue.take(frames) };
});

// Sessions を、渡された Scope（＝サーバーの寿命）で組み立てる
const setup = (scope?: Scope.Scope) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeHelpers;
    const sinks = yield* makeRecordingSinks;
    const layer = Sessions.layer.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Helpers, fake.service), Layer.succeed(SessionSinks, sinks.service))));
    const context = yield* Layer.buildWithScope(layer, scope ?? (yield* Effect.scope));
    return { fake, sinks, sessions: Context.get(context, Sessions) };
  });

describe("ヘルパーのライフサイクル（Effect 4 の試作）", () => {
  it.effect("予期せず終わったら、同じセッションへ起動し直す", () =>
    Effect.gen(function* () {
      const { fake, sinks, sessions } = yield* setup();
      assert.deepStrictEqual(yield* sessions.start(request), { dir: "/sessions/s1" });
      const h1 = yield* fake.next;
      yield* h1.send("a");
      yield* h1.exit(1);
      assert.strictEqual(yield* sinks.nextFrame, "running");
      assert.strictEqual(yield* sinks.nextFrame, "interrupted");
      const h2 = yield* fake.next;
      assert.strictEqual(h2.args[h2.args.indexOf("--audio-index") + 1], "2");
      assert.strictEqual(yield* sinks.nextFrame, "running");
      yield* h2.send("b");
      const status = yield* sessions.status;
      assert.strictEqual(status.status, "running");
      assert.strictEqual(status.restarts, 1);
      yield* sessions.stop;
      assert.deepStrictEqual(sinks.events, [
        "frame:running",
        "receive:a",
        "interrupted",
        "log:intake-stopped",
        "frame:interrupted",
        "log:intake-restarted:auto",
        "frame:running",
        "receive:b",
        "flush",
        "export",
        "updater-closed",
        "frame:none",
      ]);
    }));

  it.effect("続けて 3 回失敗したら諦め、resume で続ける。60 秒より長く動いた回は数え直す", () =>
    Effect.gen(function* () {
      const { fake, sinks, sessions } = yield* setup();
      yield* sessions.start(request);
      const h1 = yield* fake.next;
      yield* TestClock.adjust("61 seconds"); // 長く動いた回の終わりは失敗に数えない
      fake.willSpawn({ exitOnSpawn: 1 });
      fake.willSpawn({ exitOnSpawn: 1 });
      fake.willSpawn({ exitOnSpawn: 1, stderr: "マイクの許可がありません\n" });
      yield* h1.exit(1);
      const frames: string[] = [];
      while (frames.at(-1) !== "stopped") frames.push(yield* sinks.nextFrame);
      assert.deepStrictEqual(frames, ["running", "interrupted", "interrupted", "interrupted", "stopped"]);
      assert.strictEqual((yield* sessions.status).status, "stopped");

      yield* sessions.resume; // 次の spawn はすぐつながる
      assert.strictEqual((yield* sessions.status).status, "running");
      assert.include(sinks.events, "log:intake-restarted:resume");
    }));

  it.effect("stop: SIGTERM で終わらなければ 5 秒後に SIGKILL。それまでに届いた発言は書き出しの前に受け取る", () =>
    Effect.gen(function* () {
      const { fake, sinks, sessions } = yield* setup();
      fake.willSpawn({ ignoreTerm: true });
      yield* sessions.start(request);
      const h1 = yield* fake.next;
      yield* h1.send("a");
      const stopping = yield* Effect.forkChild(sessions.stop);
      yield* TestClock.adjust("4999 millis");
      assert.deepStrictEqual(h1.signals, ["SIGTERM"]);
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(yield* Fiber.join(stopping), { paths: ["map.md"] });
      assert.deepStrictEqual(h1.signals, ["SIGTERM", "SIGKILL"]);
      assert.deepStrictEqual(sinks.events.slice(-5), ["receive:a", "flush", "export", "updater-closed", "frame:none"]);
    }));

  it.effect("起動し直しの接続待ちに stop が来たら、そのヘルパーを止めて、次を起動しない", () =>
    Effect.gen(function* () {
      const { fake, sinks, sessions } = yield* setup();
      yield* sessions.start(request);
      const h1 = yield* fake.next;
      fake.willSpawn({ ready: false });
      yield* h1.exit(1);
      const h2 = yield* fake.next;
      yield* sessions.stop;
      assert.deepStrictEqual(h2.signals, ["SIGTERM"]);
      assert.strictEqual(yield* fake.pending, 0);
      assert.strictEqual(sinks.events.filter((e) => e === "updater-closed").length, 1);
      assert.strictEqual((yield* sessions.status).status, "none");
    }));

  it.effect("接続できた直後に stop が来ても、接続の時点で届いていた発言を落とさない", () =>
    Effect.gen(function* () {
      const { fake, sinks, sessions } = yield* setup();
      yield* sessions.start(request);
      const h1 = yield* fake.next;
      fake.willSpawn({ ready: false });
      yield* h1.exit(1);
      const h2 = yield* fake.next;
      yield* h2.becomeReady(["early"]);
      yield* TestClock.adjust("200 millis"); // 接続の再試行が走ってつながる
      yield* sessions.stop;
      assert.isTrue(sinks.events.indexOf("receive:early") < sinks.events.indexOf("flush"));
    }));

  it.effect("開始の途中でサーバーが終わったら、ヘルパーを止めて updater を閉じる", () =>
    Effect.gen(function* () {
      const serverScope = yield* Scope.make();
      const { fake, sinks, sessions } = yield* setup(serverScope);
      fake.willSpawn({ ready: false });
      const starting = yield* Effect.forkChild(sessions.start(request));
      const h1 = yield* fake.next;
      yield* Scope.close(serverScope, Exit.void);
      const exit = yield* Fiber.await(starting);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(h1.signals, ["SIGTERM"]);
      assert.include(sinks.events, "updater-closed");
      assert.strictEqual(yield* fake.pending, 0);
    }));

  it.effect("開始に失敗したら HelperExited で返し、続けて開始できる", () =>
    Effect.gen(function* () {
      const { fake, sinks, sessions } = yield* setup();
      fake.willSpawn({ exitOnSpawn: 1, stderr: "Zoom が見つかりません\n" });
      const failed = yield* Effect.flip(sessions.start(request));
      assert.strictEqual(failed._tag, "HelperExited");
      assert.strictEqual(failed._tag === "HelperExited" && failed.stderr, "Zoom が見つかりません\n");
      assert.include(sinks.events, "updater-closed");
      assert.deepStrictEqual(yield* sessions.start(request), { dir: "/sessions/s1" });
    }));

  it.effect("状態に合わない依頼はタグ付きの失敗になる", () =>
    Effect.gen(function* () {
      const { sessions } = yield* setup();
      assert.strictEqual((yield* Effect.flip(sessions.stop))._tag, "NoSession");
      yield* sessions.start(request);
      assert.strictEqual((yield* Effect.flip(sessions.start(request)))._tag, "SessionBusy");
      assert.strictEqual((yield* Effect.flip(sessions.resume))._tag, "IntakeNotStopped");
    }));
});
