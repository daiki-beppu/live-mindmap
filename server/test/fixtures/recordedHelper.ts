import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Deferred, Effect, Layer, Queue, Stream, type Cause } from "effect";
import { Helpers, HelperLaunchFailure, type HelperExitInfo } from "../../src/helpers.ts";
import { readyHelperChecks } from "./helperCheck.ts";

export type Remark = { start: number; end: number; text: string };
export type Script = {
  duration?: number;
  // ヘルパーが流す file-audio-tracks の本数（file-duration の後）。省略すると流さない
  audioTracks?: number;
  remarks: Remark[];
  // 渡すと remarks の代わりに、このイベントをこの順で流す（共有画面の変化を発言の間に挟むとき）
  events?: unknown[];
  // true なら、台本のイベントを流し終えてもヘルパーは終わらない（stop の印で終わる）
  hold?: boolean;
  exit?: HelperExitInfo; // 自然に終わるときの終わり方（既定 code 0）
  // ヘルパーの creation-date の答え。ISO8601 の文字列、null（作成日時を持たないファイル）、"fail"（問い合わせの失敗）。既定は null
  creationDate?: string | null | "fail";
  // true なら、この回の起動は接続できないまま待つ（stop の印で HelperLaunchFailure になる）。起動し直しの接続待ちの間の stop を試す
  blockLaunch?: boolean;
  // true なら、この回の起動は接続できず、すぐ失敗する（HelperLaunchFailure）
  failLaunch?: boolean;
};

// 偽のヘルパーが --audio-dir へ書く音声（相手.m4a）の中身
export const HELPER_AUDIO = "ヘルパーが書いた音声";
// --self-file があるときだけ、偽のヘルパーが --audio-dir へ書く 自分.m4a の中身
export const HELPER_SELF_AUDIO = "ヘルパーが書いた自分の音声";

// ヘルパーは、録画の文字起こしでは partial → remark の順に出す
export const remarkEvents = (r: Remark, track: "相手" | "自分" = "相手"): unknown[] => [
  { type: "partial", track, ...r },
  { type: "remark", track, ...r },
];
const events = (script: Script): unknown[] => [
  ...(script.duration === undefined ? [] : [{ type: "file-duration", duration: script.duration }]),
  ...(script.audioTracks === undefined ? [] : [{ type: "file-audio-tracks", count: script.audioTracks }]),
  ...(script.events ?? script.remarks.flatMap((r) => remarkEvents(r))),
];

// attempts[n] は n 回目（0 始まり）の起動の台本。無い回は script を使う（起動し直しで別の振る舞いを試すときだけ渡す）
export function fakeHelpers(script: Script, attempts: ReadonlyArray<Script> = []) {
  const calls: string[][] = [];
  const stopSeen = Effect.runSync(Deferred.make<void>());
  // 起動した後に、テストからヘルパーのイベントを足す
  const live: { queue: Queue.Queue<string, Cause.Done> | undefined; end: Effect.Effect<void> | undefined } = { queue: undefined, end: undefined };
  const feed = (event: unknown) => { Queue.offerUnsafe(live.queue!, JSON.stringify(event)); };
  // hold のヘルパーを、自然な終わり（code 0）で終わらせる
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
    if (current.failLaunch === true) return yield* new HelperLaunchFailure({ stderrTail: ["起動できない"], exit: { code: 1, signal: null } });
    if (current.blockLaunch === true) {
      yield* Deferred.await(stopRequested);
      return yield* new HelperLaunchFailure({ stderrTail: [], exit: { code: null, signal: "SIGTERM" } });
    }
    // 本物のヘルパーは、待ち受けを始める前に --audio-dir のフォルダへ 相手.m4a を書く
    const audioDir = args[args.indexOf("--audio-dir") + 1];
    if (args.includes("--audio-dir") && audioDir !== undefined) writeFileSync(join(audioDir, "相手.m4a"), HELPER_AUDIO);
    // --self-file のときは、自分用の音声も書く（待ち受けの前に 相手.m4a と 自分.m4a の両方を書き終える）
    if (args.includes("--audio-dir") && args.includes("--self-file") && audioDir !== undefined) writeFileSync(join(audioDir, "自分.m4a"), HELPER_SELF_AUDIO);
    const queue = yield* Queue.make<string, Cause.Done>();
    live.queue = queue;
    const exited = yield* Deferred.make<HelperExitInfo>();
    const finish = (info: HelperExitInfo) => Effect.asVoid(Effect.andThen(Queue.end(queue), Deferred.succeed(exited, info)));
    live.end = finish({ code: 0, signal: null });
    const stop = finish({ code: null, signal: "SIGTERM" });
    yield* Effect.addFinalizer(() => stop);
    yield* Effect.forkScoped(Effect.andThen(Deferred.await(stopRequested), Deferred.succeed(stopSeen, undefined)));
    for (const event of events(current)) Queue.offerUnsafe(queue, JSON.stringify(event));
    if (current.hold !== true) yield* finish(current.exit ?? { code: 0, signal: null });
    return { events: Stream.fromQueue(queue) as Stream.Stream<string>, stop, exit: Deferred.await(exited), stderrTail: Effect.succeed(["helper stderr"]), send: () => Effect.void };
  });
  const layer = Layer.succeed(Helpers, Helpers.of({ ...readyHelperChecks, apps: Effect.succeed([]), creationDate, launch }));
  return { calls, creationDateCalls, stopSeen, layer, feed, end };
}

