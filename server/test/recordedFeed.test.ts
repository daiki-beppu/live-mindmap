import { describe, expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { DiffUpdateState, Track } from "../src/core/index.ts";
import { recordedFeed } from "../src/recordedFeed.ts";
import type { Inlet } from "../src/remarkFlow.ts";
import type { CorrectedRemark } from "../src/sessionVocabulary.ts";
import { trackingClock, virtualNow } from "./fixtures/virtualTime.ts";

const until = Effect.fnUntraced(function* (condition: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`待機が完了しない: ${description}`);
    yield* Effect.yieldNow;
  }
});

const remark = (end: number, track: Track = "相手"): CorrectedRemark => ({
  rest: { track, start: Math.max(0, end - 1), end, text: `${track}@${end}` },
  original: undefined, wordTimes: undefined, replacements: [],
});
const screen = (start: number): Parameters<Inlet["screen"]>[0] => ({ start, image: new Uint8Array([start]), lines: [`画面@${start}`] });
const screenOff = (start: number): Parameters<Inlet["screenOff"]>[0] => ({ start, reason: "許可なし" });
const pausedState = { status: "paused", reason: "ChatGPT の利用上限" } as const;

type Arrival =
  | { kind: "remark"; value: CorrectedRemark }
  | { kind: "screen"; value: Parameters<Inlet["screen"]>[0] }
  | { kind: "screen-off"; value: Parameters<Inlet["screenOff"]>[0] };

const makeFeed = Effect.fnUntraced(function* (options: {
  realtime?: boolean; noMap?: boolean; selfTrack?: boolean; idle?: Effect.Effect<void>;
  afterRemark?: (r: CorrectedRemark, state: Ref.Ref<DiffUpdateState>) => Effect.Effect<void>;
  onPaused?: Effect.Effect<void>;
} = {}) {
  const state = yield* Ref.make<DiffUpdateState>({ status: "running" });
  const retryAt = yield* Ref.make<number | undefined>(undefined);
  const count = yield* Ref.make(0);
  const round = yield* Ref.make(0);
  const reads: DiffUpdateState[] = [];
  const counts: number[] = [];
  const arrivals: Arrival[] = [];
  const times: number[] = [];
  const progress: { position: number; rounds: number }[] = [];
  const notices: ({ reason: typeof pausedState.reason | "Claude の利用上限"; retryAt: number } | undefined)[] = [];
  const order: string[] = [];
  const record = Effect.fnUntraced(function* (arrival: Arrival) {
    times.push(yield* Clock.currentTimeMillis);
    arrivals.push(arrival);
    order.push(arrival.kind);
  });
  const inlet: Inlet = {
    remark: (value) => Effect.andThen(record({ kind: "remark", value }), options.afterRemark?.(value, state) ?? Effect.void),
    screen: (value) => record({ kind: "screen", value }),
    screenOff: (value) => record({ kind: "screen-off", value }),
  };
  const feed = yield* recordedFeed({
    realtime: options.realtime ?? false, noMap: options.noMap, selfTrack: options.selfTrack ?? false,
    session: {
      diffUpdate: Effect.tap(Ref.get(state), (s) => Effect.sync(() => { reads.push(s); })),
      nextRetryAt: Ref.get(retryAt),
      unreflectedCount: Effect.tap(Ref.get(count), (n) => Effect.sync(() => { counts.push(n); })),
      idle: Effect.andThen(Effect.sync(() => { order.push("idle"); }), options.idle ?? Effect.void),
      round: Ref.get(round),
    },
    progress: (p: { position: number; rounds: number }) => Effect.sync(() => { order.push("progress"); progress.push(p); }),
    paused: (p: typeof notices[number]) => Effect.andThen(Effect.sync(() => { notices.push(p); }), options.onPaused ?? Effect.void),
  })(inlet);
  const observe = Effect.flatMap(Ref.get(state), (s) => feed.observe({ type: "diff-update", state: s }));
  return { feed, state, retryAt, count, round, reads, counts, arrivals, times, progress, notices, order, observe };
});

type Fixture = Effect.Success<ReturnType<typeof makeFeed>>;
const labels = (r: Fixture) => r.arrivals.map((a) => a.kind === "remark" ? a.value.rest.text : `${a.kind}@${a.value.start}`);
const finish = (r: Fixture) => Effect.andThen(r.feed.drain, r.feed.finish);
const withClock = <A, E, R>(body: (pending: number[]) => Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const pending: number[] = [];
  const clock = yield* trackingClock(pending);
  return yield* body(pending).pipe(Effect.provideService(Clock.Clock, clock));
});
const advance = Effect.fnUntraced(function* (pending: number[], at: number, observed: () => boolean) {
  yield* until(() => pending.includes(at), `${at}ms の時刻待ち`);
  yield* TestClock.adjust(at - 1 - (yield* virtualNow));
  expect(observed()).toBe(false);
  yield* TestClock.adjust(1);
  yield* until(observed, `${at}ms の投入`);
  expect(yield* virtualNow).toBe(at);
});

describe("recordedFeed", () => {
  it.effect("2トラックはend順に入り、相手の保留を自分が追い越さない", () => Effect.gen(function* () {
    const r = yield* makeFeed({ selfTrack: true });
    for (const c of [remark(2), remark(6), remark(4, "自分"), remark(6.2, "自分")]) yield* r.feed.remark(c);
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@2", "自分@4", "相手@6", "自分@6.2"]);
  }).pipe(Effect.scoped));

  it.effect("片方のトラックだけでもfinishで全部入る", () => Effect.gen(function* () {
    const r = yield* makeFeed({ selfTrack: true });
    yield* r.feed.remark(remark(2));
    yield* r.feed.remark(remark(5));
    yield* r.feed.finish;
    expect(labels(r)).toEqual(["相手@2", "相手@5"]);
  }).pipe(Effect.scoped));

  it.effect("発言のendより前の画面だけを、その発言の前に入れる", () => Effect.gen(function* () {
    const r = yield* makeFeed();
    for (const start of [1, 2, 3]) yield* r.feed.screen(screen(start));
    yield* r.feed.screenOff(screenOff(3.5));
    yield* r.feed.remark(remark(2));
    yield* r.feed.remark(remark(4));
    yield* finish(r);
    expect(labels(r)).toEqual(["screen@1", "相手@2", "screen@2", "screen@3", "screen-off@3.5", "相手@4"]);
    expect(r.arrivals.filter((a) => a.kind === "screen").map((a) => a.value)).toEqual([screen(1), screen(2), screen(3)]);
  }).pipe(Effect.scoped));

  it.effect("文字のみは更新完了を待たず、保存した順にprogressを知らせる", () => Effect.gen(function* () {
    const r = yield* makeFeed({ noMap: true, idle: Effect.die("文字のみで更新完了を待った") });
    for (const end of [2, 4, 6]) yield* r.feed.remark(remark(end));
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@2", "相手@4", "相手@6"]);
    expect(r.order).toEqual(["remark", "progress", "remark", "progress", "remark", "progress"]);
    expect(r.progress).toEqual([{ position: 2, rounds: 0 }, { position: 4, rounds: 0 }, { position: 6, rounds: 0 }]);
  }).pipe(Effect.scoped));

  it.effect("待ち時間なしは1件ずつidleを待ってからprogressを知らせる", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const r = yield* makeFeed({ idle: Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(gate)) });
    yield* Ref.set(r.round, 3);
    for (const end of [600, 660, 750]) yield* r.feed.remark(remark(end));
    yield* Deferred.await(entered);
    expect(labels(r)).toEqual(["相手@600"]);
    expect(r.progress).toEqual([]);
    yield* Deferred.succeed(gate, undefined);
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@600", "相手@660", "相手@750"]);
    expect(r.order).toEqual(["remark", "idle", "progress", "remark", "idle", "progress", "remark", "idle", "progress"]);
    expect(r.progress).toEqual([600, 660, 750].map((position) => ({ position, rounds: 3 })));
  }).pipe(Effect.scoped));

  it.effect("等速は発言のendと画面のstartに投入し、idleを待たない", () => withClock((pending) => Effect.gen(function* () {
    const r = yield* makeFeed({ realtime: true, idle: Effect.never });
    yield* r.feed.remark(remark(2));
    yield* r.feed.screen(screen(6));
    yield* r.feed.screenOff(screenOff(8));
    yield* r.feed.remark(remark(12));
    for (const [index, at] of [2000, 6000, 8000, 12000].entries()) {
      yield* advance(pending, at, () => r.arrivals.length > index);
    }
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@2", "screen@6", "screen-off@8", "相手@12"]);
    expect(r.times).toEqual([2000, 6000, 8000, 12000]);
    expect(r.progress).toEqual([{ position: 2, rounds: 0 }, { position: 12, rounds: 0 }]);
    expect(r.order).not.toContain("idle");
  })).pipe(Effect.scoped));

  it.effect("過ぎた時刻は待たず、時計を戻さず次の差だけ待つ", () => withClock((pending) => Effect.gen(function* () {
    const r = yield* makeFeed({ realtime: true });
    for (const end of [5, 3, 7]) yield* r.feed.remark(remark(end, "自分"));
    yield* advance(pending, 5000, () => r.arrivals.length > 0);
    yield* until(() => r.arrivals.length === 2, "過ぎた3秒の発言");
    yield* advance(pending, 7000, () => r.arrivals.length === 3);
    yield* finish(r);
    expect(r.times).toEqual([5000, 5000, 7000]);
    expect(labels(r)).toEqual(["自分@5", "自分@3", "自分@7"]);
  })).pipe(Effect.scoped));

  it.effect("最後の発言より後の画面もfinishでその時刻に入る", () => withClock((pending) => Effect.gen(function* () {
    const r = yield* makeFeed({ realtime: true });
    yield* r.feed.remark(remark(2));
    yield* r.feed.screen(screen(20));
    const finishing = yield* Effect.forkChild(r.feed.finish);
    yield* advance(pending, 2000, () => r.arrivals.length === 1);
    yield* advance(pending, 20000, () => r.arrivals.length === 2);
    yield* Fiber.join(finishing);
    expect(labels(r)).toEqual(["相手@2", "screen@20"]);
    expect(r.times).toEqual([2000, 20000]);
  })).pipe(Effect.scoped));

  it.effect("等速と待ち時間なしでInletへの到着列が同じになる", () => withClock((pending) => Effect.gen(function* () {
    const input = [remark(2), { ...remark(12), original: { raw: "補正前", words: [] } }, remark(22, "自分"), remark(32)];
    const feedInput = Effect.fnUntraced(function* (r: Fixture) {
      yield* r.feed.screen(screen(6));
      yield* r.feed.screenOff(screenOff(8));
      yield* r.feed.screen(screen(15));
      for (const c of input) yield* r.feed.remark(c);
    });
    const immediate = yield* makeFeed();
    yield* feedInput(immediate);
    yield* finish(immediate);
    const realtime = yield* makeFeed({ realtime: true });
    yield* feedInput(realtime);
    for (const [index, at] of [2000, 6000, 8000, 12000, 15000, 22000, 32000].entries()) {
      yield* advance(pending, at, () => realtime.arrivals.length > index);
    }
    yield* finish(realtime);
    expect(labels(immediate)).toEqual(["相手@2", "screen@6", "screen-off@8", "相手@12", "screen@15", "自分@22", "相手@32"]);
    expect(realtime.arrivals).toEqual(immediate.arrivals);
  })).pipe(Effect.scoped));

  it.effect("上限の2件で待ち、未反映数が減ると続きから1回ずつ入る", () => Effect.gen(function* () {
    const r = yield* makeFeed({ realtime: true });
    yield* r.feed.remark(remark(0));
    yield* until(() => r.arrivals.length === 1, "最初の投入");
    yield* Ref.set(r.count, 2);
    yield* r.feed.remark(remark(0));
    yield* until(() => r.counts.includes(2), "上限での空き待ち");
    expect(r.arrivals).toHaveLength(1);
    yield* Ref.set(r.count, 1);
    yield* r.observe;
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@0", "相手@0"]);
  }).pipe(Effect.scoped));

  it.effect("上限で待っていてもstoppedになると残りが入る", () => Effect.gen(function* () {
    const r = yield* makeFeed({ realtime: true });
    yield* Ref.set(r.count, 2);
    yield* r.feed.remark(remark(0));
    yield* until(() => r.counts.includes(2), "上限での空き待ち");
    expect(r.arrivals).toEqual([]);
    yield* Ref.set(r.state, { status: "stopped" });
    yield* r.observe;
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@0"]);
  }).pipe(Effect.scoped));

  it.effect("上限で待つ1件をdiscardし、その後に待ちを解いても入らずfinishが戻る", () => Effect.gen(function* () {
    const r = yield* makeFeed({ realtime: true });
    yield* r.feed.remark(remark(0));
    yield* until(() => r.arrivals.length === 1, "discard前の正常な投入");
    yield* Ref.set(r.count, 2);
    yield* r.feed.remark(remark(0));
    yield* until(() => r.counts.includes(2), "discardする1件の空き待ち");
    expect(r.arrivals).toHaveLength(1);
    yield* r.feed.discard;
    yield* Ref.set(r.count, 0);
    yield* r.observe;
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@0"]);
    expect(yield* virtualNow).toBe(0);
  }).pipe(Effect.scoped));

  it.effect("時刻待ちのdiscardは時計を進めず戻り、時刻が来ても入らない", () => withClock((pending) => Effect.gen(function* () {
    const r = yield* makeFeed({ realtime: true });
    yield* r.feed.remark(remark(2));
    yield* r.feed.remark(remark(12));
    yield* advance(pending, 2000, () => r.arrivals.length === 1);
    yield* until(() => pending.includes(12000), "discardする1件の時刻待ち");
    yield* r.feed.discard;
    yield* finish(r);
    expect(yield* virtualNow).toBe(2000);
    yield* TestClock.adjust(12000);
    expect(labels(r)).toEqual(["相手@2"]);
  })).pipe(Effect.scoped));

  it.effect("discardは投入中の1件を待たず、finishがその完了を待つ", () => Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const r = yield* makeFeed({ afterRemark: () => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(gate)) });
    yield* r.feed.remark(remark(1));
    yield* r.feed.remark(remark(2));
    yield* Deferred.await(entered);
    yield* r.feed.discard;
    const finishing = yield* Effect.forkChild(finish(r));
    expect(finishing.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(finishing);
    expect(labels(r)).toEqual(["相手@1"]);
  }).pipe(Effect.scoped));

  it.effect("discardした並べ替えの保留をdrainやfinishで復活させない", () => Effect.gen(function* () {
    const r = yield* makeFeed({ selfTrack: true });
    yield* r.feed.remark(remark(10));
    expect(yield* r.feed.prepareRestart).toEqual({ 相手: 10 });
    yield* r.feed.discard;
    yield* finish(r);
    expect(r.arrivals).toEqual([]);
  }).pipe(Effect.scoped));

  it.effect("作った発言が無いうちは再起動位置は空", () => Effect.gen(function* () {
    const r = yield* makeFeed();
    yield* r.feed.screen(screen(5));
    expect(yield* r.feed.prepareRestart).toEqual({});
    yield* finish(r);
    expect(r.arrivals).toEqual([]);
  }).pipe(Effect.scoped));

  it.effect("溜まりの未投入分も再起動位置に数え、後で1回ずつ入る", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const r = yield* makeFeed({ idle: Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(gate)) });
    for (const end of [600, 660, 750]) yield* r.feed.remark(remark(end));
    yield* Deferred.await(entered);
    expect(labels(r)).toEqual(["相手@600"]);
    expect(yield* r.feed.prepareRestart).toEqual({ 相手: 750 });
    yield* Deferred.succeed(gate, undefined);
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@600", "相手@660", "相手@750"]);
  }).pipe(Effect.scoped));

  it.effect("並べ替えの保留を出さずにトラック別の最大endを返す", () => Effect.gen(function* () {
    const r = yield* makeFeed({ selfTrack: true });
    yield* r.feed.remark(remark(10));
    expect(yield* r.feed.prepareRestart).toEqual({ 相手: 10 });
    expect(r.arrivals).toEqual([]);
    yield* r.feed.remark(remark(6, "自分"));
    expect(yield* r.feed.prepareRestart).toEqual({ 相手: 10, 自分: 6 });
    yield* r.feed.remark(remark(14));
    yield* finish(r);
    expect(labels(r)).toEqual(["自分@6", "相手@10", "相手@14"]);
  }).pipe(Effect.scoped));

  it.effect.each([false, true])("再起動で最大end以上の画面とscreen-offを刈り、再送分だけが1回入る（selfTrack=%s）", (selfTrack) => Effect.gen(function* () {
    const r = yield* makeFeed({ selfTrack });
    yield* r.feed.screen(screen(5));
    yield* r.feed.screen(screen(7));
    yield* r.feed.screen(screen(10));
    yield* r.feed.screenOff(screenOff(10));
    yield* r.feed.screen(screen(11));
    yield* r.feed.screenOff(screenOff(12));
    yield* r.feed.remark(remark(10));
    if (selfTrack) yield* r.feed.remark(remark(6, "自分"));
    expect(yield* r.feed.prepareRestart).toEqual(selfTrack ? { 相手: 10, 自分: 6 } : { 相手: 10 });
    yield* r.feed.screen({ ...screen(10), lines: ["再送した画面"] });
    yield* r.feed.screenOff(screenOff(10));
    yield* r.feed.remark(remark(14));
    yield* finish(r);
    expect(labels(r)).toEqual(selfTrack
      ? ["screen@5", "自分@6", "screen@7", "相手@10", "screen@10", "screen-off@10", "相手@14"]
      : ["screen@5", "screen@7", "相手@10", "screen@10", "screen-off@10", "相手@14"]);
    expect(r.arrivals.filter((a) => a.kind === "screen").filter((a) => a.value.start === 10).map((a) => a.value.lines)).toEqual([["再送した画面"]]);
  }).pipe(Effect.scoped));

  it.effect("投入済みのscreen-offは再送されても重ならない", () => Effect.gen(function* () {
    const r = yield* makeFeed();
    yield* r.feed.screenOff(screenOff(1));
    yield* r.feed.remark(remark(2));
    yield* until(() => r.arrivals.length === 2, "最初のscreen-offと発言");
    yield* r.feed.prepareRestart;
    yield* r.feed.screenOff(screenOff(1));
    yield* r.feed.remark(remark(4));
    yield* finish(r);
    expect(labels(r)).toEqual(["screen-off@1", "相手@2", "相手@4"]);
  }).pipe(Effect.scoped));

  it.effect("holdが解けるまで入れず、解けたら溜まった順に1回ずつ入る", () => Effect.gen(function* () {
    const r = yield* makeFeed();
    yield* Ref.set(r.state, pausedState);
    for (const end of [1, 2, 3]) yield* r.feed.remark(remark(end));
    yield* until(() => r.reads.some((s) => s.status === "paused"), "一時停止のhold");
    expect(r.arrivals).toEqual([]);
    yield* Ref.set(r.state, { status: "running" });
    yield* r.observe;
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@1", "相手@2", "相手@3"]);
  }).pipe(Effect.scoped));

  it.effect("holdを1件ごとに見直し、同じfeedで再停止と再開に追従する", () => Effect.gen(function* () {
    const r = yield* makeFeed({ afterRemark: (c, state) => c.rest.end === 1 ? Ref.set(state, pausedState) : Effect.void });
    yield* r.feed.remark(remark(1));
    yield* r.feed.remark(remark(2));
    yield* r.feed.remark(remark(3));
    yield* until(() => r.reads.some((s) => s.status === "paused"), "2件目のhold");
    expect(labels(r)).toEqual(["相手@1"]);
    yield* Ref.set(r.state, { status: "running" });
    yield* r.observe;
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@1", "相手@2", "相手@3"]);
  }).pipe(Effect.scoped));

  it.effect("frameの合図は一時停止の通知callbackの完了を待たない", () => Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const r = yield* makeFeed({ onPaused: Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(gate)) });
    yield* Ref.set(r.state, pausedState);
    yield* Ref.set(r.retryAt, 100_000);
    yield* r.feed.remark(remark(1));
    yield* until(() => r.reads.some((s) => s.status === "paused"), "通知前のhold");
    const pausing = yield* Effect.forkChild(r.observe);
    yield* Deferred.await(entered);
    expect(r.arrivals).toEqual([]);
    yield* Ref.set(r.state, { status: "running" });
    const resuming = yield* Effect.forkChild(r.observe);
    yield* until(() => r.arrivals.length === 1, "通知callback保留中の再開");
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(pausing);
    yield* Fiber.join(resuming);
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@1"]);
  }).pipe(Effect.scoped));

  it.effect("hold中のdiscardは待たず戻り、解除しても入らずfinishも戻る", () => Effect.gen(function* () {
    const r = yield* makeFeed();
    yield* r.feed.remark(remark(1));
    yield* until(() => r.arrivals.length === 1, "hold前の正常な投入");
    yield* Ref.set(r.state, pausedState);
    yield* r.feed.remark(remark(2));
    yield* until(() => r.reads.some((s) => s.status === "paused"), "discardするhold");
    yield* r.feed.discard;
    yield* Ref.set(r.state, { status: "running" });
    yield* r.observe;
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@1"]);
    expect(yield* virtualNow).toBe(0);
  }).pipe(Effect.scoped));

  it.effect("holdがなければ時計を進めず全部入る", () => Effect.gen(function* () {
    const r = yield* makeFeed();
    for (const end of [1, 2, 3]) yield* r.feed.remark(remark(end));
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@1", "相手@2", "相手@3"]);
    expect(yield* virtualNow).toBe(0);
  }).pipe(Effect.scoped));

  it.effect("等速もholdを先に待ち、音声の時刻を過ぎてもpausedなら入らない", () => withClock((pending) => Effect.gen(function* () {
    const r = yield* makeFeed({ realtime: true });
    yield* Ref.set(r.state, pausedState);
    yield* r.feed.remark(remark(2));
    yield* until(() => r.reads.some((s) => s.status === "paused"), "時刻待ち前のhold");
    expect(pending).toEqual([]);
    yield* TestClock.adjust(5000);
    expect(r.arrivals).toEqual([]);
    yield* Ref.set(r.state, { status: "running" });
    yield* r.observe;
    yield* until(() => pending.length > 0 || r.arrivals.length > 0, "再開後の待機または投入");
    // hold後のpacerの起点は仕様で固定せず、再開後に必要な時刻だけ進める。
    if (pending.length > 0) yield* TestClock.adjust(pending[0]! - (yield* virtualNow));
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@2"]);
  })).pipe(Effect.scoped));

  it.effect("時刻待ち中にpausedへ変わるとframeが届く前でも入れない", () => withClock((pending) => Effect.gen(function* () {
    const r = yield* makeFeed({ realtime: true });
    yield* r.feed.remark(remark(2));
    yield* until(() => pending.includes(2000), "2秒の時刻待ち");
    yield* Ref.set(r.state, pausedState);
    yield* TestClock.adjust(3000);
    yield* until(() => r.reads.some((s) => s.status === "paused"), "frame到着前のpaused確認");
    expect(r.arrivals).toEqual([]);
    yield* Ref.set(r.retryAt, 100_000);
    yield* r.observe;
    expect(r.arrivals).toEqual([]);
    yield* Ref.set(r.state, { status: "running" });
    yield* r.observe;
    yield* finish(r);
    expect(labels(r)).toEqual(["相手@2"]);
  })).pipe(Effect.scoped));

  it.effect("再停止の新しい理由と時刻を知らせ直し、再開まで保留を入れない", () => Effect.gen(function* () {
    const r = yield* makeFeed();
    yield* Ref.set(r.state, pausedState);
    yield* Ref.set(r.retryAt, 100_000);
    yield* r.observe;
    yield* r.observe;
    yield* r.feed.remark(remark(1));
    yield* until(() => r.reads.some((s) => s.status === "paused"), "初回のhold");
    yield* Ref.set(r.state, { status: "paused", reason: "Claude の利用上限" });
    yield* Ref.set(r.retryAt, 400_000);
    yield* r.observe;
    yield* r.observe;
    expect(r.arrivals).toEqual([]);
    yield* Ref.set(r.state, { status: "running" });
    yield* r.observe;
    yield* r.observe;
    yield* finish(r);
    expect(r.notices).toEqual([{ reason: "ChatGPT の利用上限", retryAt: 100_000 }, { reason: "Claude の利用上限", retryAt: 400_000 }, undefined]);
    expect(labels(r)).toEqual(["相手@1"]);
  }).pipe(Effect.scoped));

  it.effect("再開後に同じ理由で一時停止しても、その都度知らせて保留を止める", () => Effect.gen(function* () {
    const r = yield* makeFeed();
    yield* Ref.set(r.retryAt, 100_000);
    yield* Ref.set(r.state, pausedState);
    yield* r.observe;
    yield* r.feed.remark(remark(1));
    yield* until(() => r.reads.some((state) => state.status === "paused"), "初回の停止");
    expect(r.arrivals).toEqual([]);
    yield* Ref.set(r.state, { status: "running" });
    yield* r.observe;
    yield* until(() => r.arrivals.length === 1, "初回の再開");
    r.reads.length = 0;
    yield* Ref.set(r.state, pausedState);
    yield* r.observe;
    yield* r.observe;
    yield* r.feed.remark(remark(2));
    yield* until(() => r.reads.some((state) => state.status === "paused"), "二度目の停止");
    expect(labels(r)).toEqual(["相手@1"]);
    yield* Ref.set(r.state, { status: "running" });
    yield* r.observe;
    yield* r.feed.finish;
    expect(r.notices).toEqual([
      { reason: pausedState.reason, retryAt: 100_000 }, undefined,
      { reason: pausedState.reason, retryAt: 100_000 }, undefined,
    ]);
    expect(labels(r)).toEqual(["相手@1", "相手@2"]);
  }).pipe(Effect.scoped));
});
