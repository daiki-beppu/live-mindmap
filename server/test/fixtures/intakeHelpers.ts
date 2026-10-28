import { Cause, Deferred, Effect, Queue, Ref, Scope, Stream } from "effect";
import { Helpers, HelperLaunchFailure, type HelperAttempt, type HelperLaunchOptions, type HelperExitInfo, type HelperInstruction } from "../../src/helpers.ts";
import { helperChecks } from "./helperCheck.ts";

const APPS = [{ bundleID: "us.zoom.xos", name: "zoom.us" }];

const GAP_BEFORE_RELAUNCH_FAILURE_MS = 1;

export type AttemptScript = {
  events?: string[];
  connect?: boolean;
  launchExit?: HelperExitInfo;
  stderrTail?: string[];
  unexpectedExit?: { afterMs: number; exit: HelperExitInfo };
  stopExit?: HelperExitInfo;
  stopDelayMs?: number;
  connectGate?: Deferred.Deferred<void>;
  hold?: boolean;
};

type FakeHelpersHandle = {
  readonly helpers: Helpers["Service"];
  readonly calls: ReadonlyArray<HelperLaunchOptions>;
  readonly send: (attemptIndex: number, event: unknown) => void;
  readonly stops: number[];
  readonly sentInstructions: { attempt: number; instruction: HelperInstruction }[];
  readonly lifecycle: string[];
  readonly sentPauses: { attempt: number; paused: boolean }[];
};

export function makeFakeHelpers(attempts: AttemptScript[]): Effect.Effect<FakeHelpersHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const calls: HelperLaunchOptions[] = [];
    const sentInstructions: { attempt: number; instruction: HelperInstruction }[] = [];
    const lifecycle: string[] = [];
    const queues: Queue.Queue<string, Cause.Done>[] = [];
    const stops: number[] = [];
    const sentPauses: { attempt: number; paused: boolean }[] = [];
    const launch = (args: HelperLaunchOptions, stopRequested: Deferred.Deferred<void>): Effect.Effect<HelperAttempt, HelperLaunchFailure, Scope.Scope> =>
      Effect.gen(function* () {
        const index = calls.length;
        calls.push(args);
        yield* Effect.addFinalizer(() => Effect.sync(() => { lifecycle.push(`closed:${index}`); }));
        const script = attempts[Math.min(index, attempts.length - 1)] ?? {};
        if (script.connect === false) {
          if (index > 0) yield* Effect.sleep(GAP_BEFORE_RELAUNCH_FAILURE_MS);
          return yield* new HelperLaunchFailure({ stderrTail: script.stderrTail ?? [], exit: script.launchExit });
        }
        if (script.hold) {
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
    return { helpers: Helpers.of({ ...helperChecks(), apps: Effect.succeed(APPS), launch }), calls, send, stops, sentPauses, sentInstructions, lifecycle };
  });
}

