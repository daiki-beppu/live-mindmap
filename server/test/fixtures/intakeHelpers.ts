import { Cause, Deferred, Effect, Queue, Ref, Scope, Stream } from "effect";
import { Helpers, HelperLaunchFailure, type HelperAttempt, type HelperExitInfo, type HelperInstruction } from "../../src/helpers.ts";
import { readyHelperChecks } from "./helperCheck.ts";

const APPS = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];

export type AttemptScript = {
  events?: string[];
  connect?: boolean; // 既定 true。false なら接続失敗（HelperLaunchFailure）
  launchExit?: HelperExitInfo; // connect: false のとき、接続する前にヘルパーが終わった終わり方（HelperLaunchFailure.exit）。省略すると exit なし
  stderrTail?: string[];
  unexpectedExit?: { afterMs: number; exit: HelperExitInfo }; // 自発的な予期せぬ終了
  stopExit?: HelperExitInfo; // stop が呼ばれたときの終わり方（既定 SIGTERM）
  stopDelayMs?: number; // stop が呼ばれてから終わるまでの時間（既定 0）
  connectGate?: Deferred.Deferred<void>; // 解放されるまで接続しない（launch が待つ。解放すると接続できる）
  hold?: boolean; // 接続待ちのまま保つ。stopRequested が立つと止めて、stopExit（既定 SIGTERM）の HelperLaunchFailure で終わる
};

type FakeHelpersHandle = {
  readonly helpers: Helpers["Service"];
  readonly calls: ReadonlyArray<ReadonlyArray<string>>; // launch に渡された argv（起動した回数も分かる）
  readonly send: (attemptIndex: number, event: unknown) => void; // 指定した起動回の events へ 1 件流す
  readonly stops: number[]; // stop が実際に走った起動回（0 始まり）。ヘルパーが止められたことを観測する
  readonly sentInstructions: { attempt: number; instruction: HelperInstruction }[];
  readonly lifecycle: string[];
  readonly sentPauses: { attempt: number; paused: boolean }[]; // HelperAttempt.send で helper へ送られた休止の指示（起動回ごと。Issue #1069）
};

// 偽の Helpers。台本（attempts）の数を超えたら最後の台本を使い回す
export function makeFakeHelpers(attempts: AttemptScript[]): Effect.Effect<FakeHelpersHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const calls: string[][] = [];
    const sentInstructions: { attempt: number; instruction: HelperInstruction }[] = [];
    const lifecycle: string[] = [];
    const queues: Queue.Queue<string, Cause.Done>[] = [];
    const stops: number[] = [];
    const sentPauses: { attempt: number; paused: boolean }[] = [];
    const launch = (args: ReadonlyArray<string>, stopRequested: Deferred.Deferred<void>): Effect.Effect<HelperAttempt, HelperLaunchFailure, Scope.Scope> =>
      Effect.gen(function* () {
        const index = calls.length;
        calls.push([...args]);
        yield* Effect.addFinalizer(() => Effect.sync(() => { lifecycle.push(`closed:${index}`); }));
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
        if (script.connectGate) yield* Deferred.await(script.connectGate);
        const queue = yield* Queue.make<string, Cause.Done>();
        queues[index] = queue;
        for (const line of script.events ?? []) Queue.offerUnsafe(queue, line);
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
          events: Stream.fromQueue(queue),
          stop,
          exit: Effect.tap(Deferred.await(exitDeferred), () => Effect.sync(() => { lifecycle.push(`exit:${index}`); })),
          stderrTail: Effect.sync(() => { lifecycle.push(`stderr:${index}`); return script.stderrTail ?? []; }),
          send: (instruction: HelperInstruction) => Effect.sync(() => {
            sentInstructions.push({ attempt: index, instruction });
            if (instruction.type === "self-pause") sentPauses.push({ attempt: index, paused: instruction.paused });
          }),
        };
      });
    const send = (attemptIndex: number, event: unknown) => {
      const queue = queues[attemptIndex];
      if (!queue) throw new Error(`起動回 ${attemptIndex} はまだ接続していない`);
      Queue.offerUnsafe(queue, JSON.stringify(event));
    };
    return { helpers: Helpers.of({ ...readyHelperChecks, apps: Effect.succeed(APPS), launch }), calls, send, stops, sentPauses, sentInstructions, lifecycle };
  });
}

