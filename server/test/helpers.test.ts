import { createServer, type Server } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { ChildProcessSpawner, type ChildProcess } from "effect/process";
import { TestClock } from "effect/testing";
import { Helpers } from "../src/helpers.ts";
import { promiseOrDie } from "./fixtures/promiseOrDie.ts";

// 接続の再試行は Schedule.spaced("200 millis")（CT-RESTART-DECISION）。
// 子プロセスだけを偽物にし、ヘルパーが待ち受けるはずのポートに「接続を数えて切る」サーバーを置いて、再試行の間隔を TestClock で観測する
const realDelay = (ms: number) => promiseOrDie(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const countingSpawner = (counter: { connections: number; spawned?: ChildProcess.StandardCommand[]; kills?: unknown[] }) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command: ChildProcess.Command) =>
      Effect.gen(function* () {
        const args = (command as ChildProcess.StandardCommand).args;
        counter.spawned?.push(command as ChildProcess.StandardCommand);
        const port = Number(args[args.indexOf("--port") + 1]);
        const server = yield* Effect.acquireRelease(
          promiseOrDie(
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

describe("Helpers の接続の再試行（Schedule.spaced 200ms）", () => {
  it.effect("接続できない間は、200ms 刻みで再試行する", () =>
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

      const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch(["run"], stopRequested)));
      yield* waitFor(1);

      yield* TestClock.adjust(199);
      yield* realDelay(100);
      expect(counter.connections).toBe(1); // 200ms 未満では再試行しない

      yield* TestClock.adjust(1);
      yield* waitFor(2);
      yield* TestClock.adjust(200);
      yield* waitFor(3);

      yield* Fiber.interrupt(fiber);
    }));
});

// base の server.test.ts の移動先（子プロセスだけを偽物にして、Helpers 実物の起動の引数・停止・中断を観測する）
describe("Helpers の起動の引数・停止・中断（base server.test.ts の移動先）", () => {
  const boot = (counter: { connections: number; spawned: ChildProcess.StandardCommand[]; kills: unknown[] }) =>
    Helpers.pipe(Effect.provide(Helpers.layer({ command: "fake", args: ["helper-arg"] }).pipe(Layer.provide(countingSpawner(counter)))));

  it.effect("--port は、0 でも 8765 でもない空きポートで、渡した引数の後ろに付き、ヘルパーが待ち受けるポートと同じ（base:185）", () =>
    Effect.gen(function* () {
      const counter = { connections: 0, spawned: [] as ChildProcess.StandardCommand[], kills: [] as unknown[] };
      const helpers = yield* boot(counter);
      const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch(["run", "--audio-dir", "/x"], yield* Deferred.make<void>())));
      for (let i = 0; i < 100 && counter.connections < 1; i++) yield* realDelay(20);

      const args = counter.spawned[0]!.args;
      expect(args.slice(0, 4)).toEqual(["helper-arg", "run", "--audio-dir", "/x"]);
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
      const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch(["run"], stopRequested)));
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
      const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch(["run"], yield* Deferred.make<void>())));
      yield* Fiber.interrupt(fiber);
      yield* realDelay(100); // 空きポートの選択が終わる時間を待っても、起動は始まらない

      expect(counter.spawned).toHaveLength(0);
    }));
});
