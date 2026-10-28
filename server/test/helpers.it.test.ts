import { INITIAL_SELF_PAUSE_STATE } from "../src/core/selfPause.ts";
import { createServer, type Server } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { ChildProcessSpawner, type ChildProcess } from "effect/process";
import { TestClock } from "effect/testing";
import { WebSocketServer } from "ws";
import { HELPER_CONTROL_TOKEN_ENV, HELPER_STOP_TIMEOUT_MS, Helpers } from "../src/helpers.ts";

// 接続の再試行は 10ms から始めて 2 倍ずつ伸び、200ms で頭打ちになる指数の Schedule（CT-RESTART-DECISION）。
// 子プロセスだけを偽物にし、ヘルパーが待ち受けるはずのポートに「接続を数えて切る」サーバーを置いて、再試行の間隔を TestClock で観測する
const realDelay = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const countingSpawner = (counter: { connections: number; spawned?: ChildProcess.StandardCommand[]; kills?: unknown[] }) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command: ChildProcess.Command) =>
      Effect.gen(function* () {
        const args = (command as ChildProcess.StandardCommand).args;
        counter.spawned?.push(command as ChildProcess.StandardCommand);
        const port = Number(args[args.indexOf("--port") + 1]);
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<Server>((resolve) => {
                const s = createServer((socket) => {
                  counter.connections++;
                  socket.destroy();
                });
                s.listen(port, "127.0.0.1", () => resolve(s));
              }),
          ),
          (s) => Effect.sync(() => void s.close()),
        );
        void server;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: (options?: unknown) => Effect.sync(() => void counter.kills?.push(options)),
          stdin: undefined as never,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => undefined as never,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

describe("Helpers の接続の再試行（10ms から 200ms で頭打ちになる指数）", () => {
  it.effect("接続できない間は、10・20・40・80・160ms と伸ばし、200ms で頭打ちにして再試行する", () =>
    Effect.gen(function* () {
      const counter = { connections: 0 };
      const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "fake", args: [] }).pipe(Layer.provide(countingSpawner(counter)))));
      const stopRequested = yield* Deferred.make<void>();
      const waitFor = (n: number) =>
        Effect.gen(function* () {
          for (let i = 0; i < 100 && counter.connections < n; i++) yield* realDelay(20);
          expect(counter.connections).toBe(n);
          yield* realDelay(50); // 失敗が返り、次の待ちが TestClock に登録されるまで
        });

      const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch({ kind: "run", app: "test.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE }, stopRequested)));
      yield* waitFor(1);

      // 各間隔の 1ms 前では再試行せず、ちょうどで 1 回だけ再試行する。
      // 200ms を 2 回続けるのは、320ms へ伸びる（頭打ちがない）誤りと、200ms の後に止まる誤りを落とすため
      let connections = 1;
      for (const interval of [10, 20, 40, 80, 160, 200, 200, 200]) {
        yield* TestClock.adjust(interval - 1);
        yield* realDelay(50);
        expect(counter.connections).toBe(connections);
        yield* TestClock.adjust(1);
        connections++;
        yield* waitFor(connections);
      }

      yield* Fiber.interrupt(fiber);
    }));
});

describe("Helpers の停止の上限（HELPER_STOP_TIMEOUT_MS）", () => {
  const launchAndStop = (limit: number) =>
    Effect.gen(function* () {
      const counter = { connections: 0, spawned: [] as ChildProcess.StandardCommand[], kills: [] as unknown[] };
      const layer = Helpers.layer({ command: "fake", args: [] }).pipe(Layer.provide(countingSpawner(counter)));
            const helpers = yield* Helpers.pipe(Effect.provide(layer), Effect.provideService(HELPER_STOP_TIMEOUT_MS, limit));
      const stopRequested = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch({ kind: "run", app: "test.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE }, stopRequested)));
      for (let i = 0; i < 100 && counter.connections < 1; i++) yield* realDelay(20);
      yield* Deferred.succeed(stopRequested, undefined);
      for (let i = 0; i < 100 && counter.kills.length < 1; i++) yield* realDelay(20);
      yield* Fiber.interrupt(fiber);
      return { spawnedWith: (counter.spawned[0]!.options as { forceKillAfter?: number }).forceKillAfter, kills: counter.kills };
    });

  it.effect("上限を与えると、起動と停止の kill の forceKillAfter がその値になる", () =>
    Effect.gen(function* () {
      const result = yield* launchAndStop(1_234);

      expect(result.spawnedWith).toBe(1_234);
      expect(result.kills).toEqual([{ forceKillAfter: 1_234 }]);
    }));

  // 上書きしない構築で spawn と kill が 5_000 になることは、下の「stop は、まず SIGTERM…」が見ている
  it.effect("上書きしない（製品と同じ）と、Reference の既定値は 5_000ms", () =>
    Effect.gen(function* () {
      expect(yield* HELPER_STOP_TIMEOUT_MS).toBe(5_000);
    }));
});

// base の server.heavy.test.ts の移動先（子プロセスだけを偽物にして、Helpers 実物の起動の引数・停止・中断を観測する）
describe("Helpers の起動の引数・停止・中断（base server.heavy.test.ts の移動先）", () => {
  const boot = (counter: { connections: number; spawned: ChildProcess.StandardCommand[]; kills: unknown[] }) =>
    Helpers.pipe(Effect.provide(Helpers.layer({ command: "fake", args: ["helper-arg"] }).pipe(Layer.provide(countingSpawner(counter)))));

  it.effect("--port は、0 でも 8765 でもない空きポートで、渡した引数の後ろに付き、ヘルパーが待ち受けるポートと同じ（base:185）", () =>
    Effect.gen(function* () {
      const counter = { connections: 0, spawned: [] as ChildProcess.StandardCommand[], kills: [] as unknown[] };
      const helpers = yield* boot(counter);
      const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch({ kind: "run", app: "test.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE, audio: { dir: "/x", attempt: 1 } }, yield* Deferred.make<void>())));
      for (let i = 0; i < 100 && counter.connections < 1; i++) yield* realDelay(20);

      const args = counter.spawned[0]!.args;
      const port = Number(args[args.indexOf("--port") + 1]);
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(8765);
      expect(counter.connections).toBeGreaterThanOrEqual(1); // 偽の子プロセスはこのポートで待ち受ける。そこへ接続できた
      yield* Fiber.interrupt(fiber);
    }));

  it.effect("stop は、まず SIGTERM（既定の kill）で止め、forceKillAfter（5 秒）の後に SIGKILL する指定を付ける（base:636）", () =>
    Effect.gen(function* () {
      const counter = { connections: 0, spawned: [] as ChildProcess.StandardCommand[], kills: [] as unknown[] };
      const helpers = yield* boot(counter);
      const stopRequested = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch({ kind: "run", app: "test.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE }, stopRequested)));
      for (let i = 0; i < 100 && counter.connections < 1; i++) yield* realDelay(20);
      expect((counter.spawned[0]!.options as { forceKillAfter?: number }).forceKillAfter).toBe(5_000);

      yield* Deferred.succeed(stopRequested, undefined); // 止めての印
      for (let i = 0; i < 100 && counter.kills.length < 1; i++) yield* realDelay(20);

      expect(counter.kills).toEqual([{ forceKillAfter: 5_000 }]); // signal を指定しない = SIGTERM から始める
      yield* Fiber.interrupt(fiber);
    }));

  it.effect("空きポートを選んでいる間に中断されたら、ヘルパーを起動しない（base:699）", () =>
    Effect.gen(function* () {
      const counter = { connections: 0, spawned: [] as ChildProcess.StandardCommand[], kills: [] as unknown[] };
      const helpers = yield* boot(counter);
      const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch({ kind: "run", app: "test.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE }, yield* Deferred.make<void>())));
      yield* Fiber.interrupt(fiber);
      yield* realDelay(100); // 空きポートの選択が終わる時間を待っても、起動は始まらない

      expect(counter.spawned).toHaveLength(0);
    }));
});

// Issue #1069: HelperAttempt.send は、実物の Helpers が JSON にして helper の WebSocket へ送る（server から helper への最初の指示）。
// 子プロセスだけを偽物にし、helper が待ち受けるはずのポートに本物の WebSocket サーバーを置いて、届いたテキストを観測する
const wsSpawner = (received: string[], envs: Array<Record<string, string | undefined> | undefined> = []) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command: ChildProcess.Command) =>
      Effect.gen(function* () {
        const args = (command as ChildProcess.StandardCommand).args;
        envs.push((command as ChildProcess.StandardCommand).options.env);
        const port = Number(args[args.indexOf("--port") + 1]);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const wss = new WebSocketServer({ host: "127.0.0.1", port });
            wss.on("connection", (socket) => socket.on("message", (data) => received.push(String(data))));
            return wss;
          }),
          (wss) => Effect.sync(() => void wss.close()),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: undefined as never,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => undefined as never,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

describe("HelperAttempt.send（自分の休止の指示。Issue #1069）", () => {
  it.live("指示（self-pause と reading-pause）を、その起動回のトークンつきの {type,paused,token} の JSON にして helper の WebSocket へ、呼んだ順に送る（SCN-U3-P2）", () =>
    Effect.gen(function* () {
      const received: string[] = [];
      const envs: Array<Record<string, string | undefined> | undefined> = [];
      const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "fake", args: [] }).pipe(Layer.provide(wsSpawner(received, envs)))));
      const attempt = yield* helpers.launch({ kind: "run", app: "test.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE }, yield* Deferred.make<void>());
      yield* attempt.send({ type: "self-pause", paused: true });
      yield* attempt.send({ type: "self-pause", paused: false });
      yield* attempt.send({ type: "reading-pause", paused: true });
      yield* attempt.send({ type: "reading-pause", paused: false });
      for (let i = 0; i < 100 && received.length < 4; i++) yield* realDelay(20);
      const token = envs[0]?.[HELPER_CONTROL_TOKEN_ENV];
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(received.map((text) => JSON.parse(text))).toEqual([
        { type: "self-pause", paused: true, token },
        { type: "self-pause", paused: false, token },
        { type: "reading-pause", paused: true, token },
        { type: "reading-pause", paused: false, token },
      ]);
    }).pipe(Effect.scoped));

  it.live("トークンは起動ごとに変わる", () =>
    Effect.gen(function* () {
      const envs: Array<Record<string, string | undefined> | undefined> = [];
      const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "fake", args: [] }).pipe(Layer.provide(wsSpawner([], envs)))));
      yield* helpers.launch({ kind: "run", app: "test.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE }, yield* Deferred.make<void>());
      yield* helpers.launch({ kind: "run", app: "test.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE }, yield* Deferred.make<void>());
      expect(envs[0]?.[HELPER_CONTROL_TOKEN_ENV]).not.toBe(envs[1]?.[HELPER_CONTROL_TOKEN_ENV]);
    }).pipe(Effect.scoped));
});
