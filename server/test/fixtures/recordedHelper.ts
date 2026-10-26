import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect, Layer, Queue, Stream, type Cause } from "effect";
import { Helpers, HelperLaunchFailure, type HelperExitInfo } from "../../src/helpers.ts";
import { helperChecks } from "./helperCheck.ts";

export type Remark = { start: number; end: number; text: string };
export type Script = {
  duration?: number;
  audioTracks?: number;
  remarks: Remark[];
  events?: unknown[];
  hold?: boolean;
  exit?: HelperExitInfo;
  creationDate?: string | null | "fail";
  blockLaunch?: boolean;
  failLaunch?: boolean;
  launchExit?: HelperExitInfo;
};

export const HELPER_AUDIO = "ヘルパーが書いた音声";
export const HELPER_SELF_AUDIO = "ヘルパーが書いた自分の音声";

export const remarkEvents = (r: Remark, track: "相手" | "自分" = "相手"): unknown[] => [
  { type: "partial", track, ...r },
  { type: "remark", track, ...r },
];
const events = (script: Script): unknown[] => [
  ...(script.duration === undefined ? [] : [{ type: "file-duration", duration: script.duration }]),
  ...(script.audioTracks === undefined ? [] : [{ type: "file-audio-tracks", count: script.audioTracks }]),
  ...(script.events ?? script.remarks.flatMap((r) => remarkEvents(r))),
];

export function fakeHelpers(script: Script, attempts: ReadonlyArray<Script> = []) {
  const calls: string[][] = [];
  const stopSeen = Effect.runSync(Deferred.make<void>());
  const live: { queue: Queue.Queue<string, Cause.Done> | undefined; end: Effect.Effect<void> | undefined } = { queue: undefined, end: undefined };
  const feed = (event: unknown) => { Queue.offerUnsafe(live.queue!, JSON.stringify(event)); };
  const end = Effect.suspend(() => live.end!);
  const creationDateCalls: string[] = [];
  const creationDate = (file: string) => {
    creationDateCalls.push(file);
    return script.creationDate === "fail"
      ? Effect.fail({ _tag: "HelperCreationDateFailure", message: "作成日時を読めない" } as never)
      : Effect.succeed(script.creationDate ?? null);
  };
  const launch = (args: ReadonlyArray<string>, stopRequested: Deferred.Deferred<void>) => Effect.gen(function* () {
    calls.push([...args]);
    const attemptIndex = calls.length - 1;
    const current = attempts[attemptIndex] ?? script;
    if (current.failLaunch === true) return yield* new HelperLaunchFailure({ stderrTail: ["起動できない"], exit: current.launchExit ?? { code: 1, signal: null } });
    if (current.blockLaunch === true) {
      yield* Deferred.await(stopRequested);
      return yield* new HelperLaunchFailure({ stderrTail: [], exit: { code: null, signal: "SIGTERM" } });
    }
    const audioDir = args[args.indexOf("--audio-dir") + 1];
    if (args.includes("--audio-dir") && audioDir !== undefined) writeFileSync(join(audioDir, "相手.m4a"), HELPER_AUDIO);
    if (args.includes("--audio-dir") && args.includes("--self-file") && audioDir !== undefined) writeFileSync(join(audioDir, "自分.m4a"), HELPER_SELF_AUDIO);
    const queue = yield* Queue.make<string, Cause.Done>();
    live.queue = queue;
    const exited = yield* Deferred.make<HelperExitInfo>();
    const finish = (info: HelperExitInfo) => Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, info)));
    live.end = finish({ code: 0, signal: null });
    const stop = Effect.andThen(Deferred.succeed(stopSeen, undefined), finish({ code: null, signal: "SIGTERM" }));
    yield* Effect.addFinalizer(() => stop);
    yield* Effect.forkScoped(Effect.andThen(Deferred.await(stopRequested), Deferred.succeed(stopSeen, undefined)));
    for (const event of events(current)) Queue.offerUnsafe(queue, JSON.stringify(event));
    if (current.hold !== true) yield* finish(current.exit ?? { code: 0, signal: null });
    return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed(["helper stderr"]), send: () => Effect.void };
  });
  const layer = Layer.succeed(Helpers, Helpers.of({ ...helperChecks(), apps: Effect.succeed([]), creationDate, launch }));
  return { calls, creationDateCalls, stopSeen, layer, feed, end };
}

