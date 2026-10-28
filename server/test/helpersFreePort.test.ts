// Helpers.launch が空きポートを探している間（node:net の listen が終わる前）に中断されたら、探すための待受けを閉じる。
// node:net だけを偽物にし、listen の完了を手元で操作して、中断・遅れて届く割り当てを観測する
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vitest";
import { INITIAL_SELF_PAUSE_STATE } from "../src/core/selfPause.ts";
import { Helpers, type HelperLaunchOptions } from "../src/helpers.ts";

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
  const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch({ kind: "run", app: "test.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE }, stopRequested)));
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


const spawnedCommand = Effect.fnUntraced(function* (options: HelperLaunchOptions) {
  const spawned = yield* Deferred.make<ChildProcess.StandardCommand>();
  const spawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make((command) => Effect.gen(function* () {
    if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("helper は単一のコマンドで起動する");
    yield* Deferred.succeed(spawned, command);
    return yield* Effect.never;
  })));
  const helpers = yield* Helpers.pipe(Effect.provide(Helpers.layer({ command: "server-helper", args: ["fixed-arg"] }).pipe(Layer.provide(spawner))));
  const stopRequested = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkChild(Effect.scoped(helpers.launch(options, stopRequested)));
  yield* Effect.yieldNow;
  net.probes.at(-1)!.assign();
  return yield* Effect.raceFirst(Deferred.await(spawned), Effect.andThen(Fiber.join(fiber), Effect.die("spawn の観測前に launch が完了した"))).pipe(Effect.ensuring(Fiber.interrupt(fiber)));
});

describe("Helpers.launch の起動オプションを helper の argv に書き出す", () => {
  it.effect.each([
    { name: "既定のライブ", options: { kind: "run", app: "zoom.app", screen: true, selfPause: INITIAL_SELF_PAUSE_STATE }, args: ["run", "--app", "zoom.app"] },
    { name: "録音と原点と休止状態を持つライブ", options: { kind: "run", app: "zoom.app", audio: { dir: "/audio dir", attempt: 2 }, screen: false, origin: "9007199254740993", selfPause: { manual: "pause", basis: "using", lastKnown: "idle", idleFor: 1.5 } }, args: ["run", "--app", "zoom.app", "--audio-dir", "/audio dir", "--audio-index", "2", "--no-screen", "--origin", "9007199254740993", "--self-manual", "pause", "--self-basis", "using", "--self-last-known", "idle", "--self-idle-for", "1.5"] },
    { name: "録音なしで画面を取らないライブ", options: { kind: "run", app: "zoom.app", screen: false, selfPause: INITIAL_SELF_PAUSE_STATE }, args: ["run", "--app", "zoom.app", "--no-screen"] },
    { name: "手動takeと基準idleを持つライブ", options: { kind: "run", app: "zoom.app", screen: true, selfPause: { manual: "take", basis: "idle", lastKnown: "using", idleFor: 0 } }, args: ["run", "--app", "zoom.app", "--self-manual", "take", "--self-basis", "idle", "--self-last-known", "using"] },
    { name: "録画の初回", options: { kind: "transcribe-file", file: "/meeting.m4a", from: {}, audioDir: "/session" }, args: ["transcribe-file", "--file", "/meeting.m4a", "--audio-dir", "/session"] },
    { name: "二つのトラックの録画の再開位置0", options: { kind: "transcribe-file", file: "/meeting.m4a", selfFile: "/self.m4a", from: { 相手: 0, 自分: 0 } }, args: ["transcribe-file", "--file", "/meeting.m4a", "--self-file", "/self.m4a", "--from", "0", "--self-from", "0"] },
    { name: "二つのトラックと音声保存のある録画", options: { kind: "transcribe-file", file: "/meeting.m4a", selfFile: "/self.m4a", from: { 相手: 10.5, 自分: 6 }, audioDir: "/audio dir" }, args: ["transcribe-file", "--file", "/meeting.m4a", "--self-file", "/self.m4a", "--from", "10.5", "--self-from", "6", "--audio-dir", "/audio dir"] },
    { name: "自分のファイルのない録画では自分の再開位置を渡さない", options: { kind: "transcribe-file", file: "/meeting.m4a", from: { 相手: 10, 自分: 6 } }, args: ["transcribe-file", "--file", "/meeting.m4a", "--from", "10"] },
    { name: "相手の再開位置のない録画", options: { kind: "transcribe-file", file: "/meeting.m4a", selfFile: "/self.m4a", from: { 自分: 6 } }, args: ["transcribe-file", "--file", "/meeting.m4a", "--self-file", "/self.m4a", "--self-from", "6"] },
  ] satisfies ReadonlyArray<{ name: string; options: HelperLaunchOptions; args: string[] }>)
  ("$name", ({ options, args }) => Effect.gen(function* () {
    const command = yield* spawnedCommand(options);
    expect({ command: command.command, args: command.args }).toEqual({ command: "server-helper", args: ["fixed-arg", ...args, "--port", "54321"] });
  }));
});
