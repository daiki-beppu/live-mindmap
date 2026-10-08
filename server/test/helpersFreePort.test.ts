// Helpers.launch が空きポートを探している間（node:net の listen が終わる前）に中断されたら、探すための待受けを閉じる。
// node:net だけを偽物にし、listen の完了を手元で操作して、中断・遅れて届く割り当てを観測する
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vitest";
import { Helpers } from "../src/helpers.ts";

const net = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  class FakeProbe extends EventEmitter {
    listening = false;
    closeCalls = 0;
    onListening: (() => void) | undefined;
    listen(_port: number, _host: string, onListening: () => void) {
      this.onListening = onListening;
      return this;
    }
    address() {
      return { port: 54321, address: "127.0.0.1", family: "IPv4" };
    }
    close(callback?: () => void) {
      this.closeCalls++;
      this.listening = false;
      callback?.();
      return this;
    }
    // OS がポートを割り当てた（listen のコールバックを呼ぶ）
    assign() {
      this.listening = true;
      this.onListening?.();
    }
  }
  return { probes: [] as FakeProbe[], FakeProbe };
});
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  createServer: () => {
    const probe = new net.FakeProbe();
    net.probes.push(probe);
    return probe;
  },
}));

const neverSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
  ChildProcessSpawner.make(() => Effect.die("空きポートが決まる前に子プロセスは起動しない")),
);

const launchWhilePortPending = Effect.gen(function* () {
  const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "fake", args: [] }).pipe(Layer.provide(neverSpawner))));
  const stopRequested = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch(["run"], stopRequested)));
  yield* Effect.yieldNow;
  const probe = net.probes.at(-1)!;
  return { fiber, probe };
});

describe("freePort の後始末（Helpers.launch 経由）", () => {
  it.effect("空きポートを探している間に中断されたら、探すための待受けを閉じる", () => Effect.gen(function* () {
    const { fiber, probe } = yield* launchWhilePortPending;
    expect(probe.closeCalls).toBe(0);
    yield* Fiber.interrupt(fiber);
    expect(probe.closeCalls).toBeGreaterThanOrEqual(1);
  }));

  it.effect("中断のあとにポートの割り当てが届いても、待受けは開いたままにならない", () => Effect.gen(function* () {
    const { fiber, probe } = yield* launchWhilePortPending;
    yield* Fiber.interrupt(fiber);
    probe.assign();
    expect(probe.listening).toBe(false);
  }));
});
