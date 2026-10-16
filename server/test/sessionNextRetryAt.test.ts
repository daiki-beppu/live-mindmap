import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePaused, makeSession, type DiffInput, type Remark } from "../src/core/index.ts";
import { settleUntil, silentLog, updaterLayer } from "./fixtures/sessionLayers.ts";

// Issue #1092: 一時停止の間、進み具合に「次に試す時刻」を出すため、Session が次に試す時刻（エポックからのミリ秒）を読めるようにする。
// 時刻の規則は今までと同じ: retryAt が先ならその時刻、無い・過ぎていれば DIFF_UPDATE_RETRY_MS 後、再試行でも戻らなければ DIFF_UPDATE_RETRY_MS ごと。

const remark = (n: number): Remark => ({ id: `r${n}`, track: "相手", start: n, end: n + 1, text: `発言${n}。` });
const reason = "ChatGPT の利用上限";
const pausedWith = (retryAt?: number) => new DiffUpdatePaused({ reason, message: reason, ...(retryAt === undefined ? {} : { retryAt }) });

// failures の i 番目の呼び出しは、その値で一時停止し、それより後の呼び出しは成功する。
const session = Effect.fnUntraced(function* (failures: ReadonlyArray<DiffUpdatePaused>) {
  const calls: DiffInput[] = [];
  const made = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(
    updaterLayer((input) => Effect.suspend(() => {
      calls.push(input);
      const failure = failures[calls.length - 1];
      return failure === undefined ? Effect.succeed({ ops: [] }) : Effect.fail(failure);
    })), silentLog,
  )));
  return { session: made, calls };
});

describe("Session.nextRetryAt（一時停止の次に試す時刻）", () => {
  it.effect("一時停止していなければ undefined", () => Effect.gen(function* () {
    const { session: s } = yield* session([]);
    expect(yield* s.nextRetryAt).toBeUndefined();
    yield* s.push(remark(1));
    yield* s.idle;
    expect(yield* s.nextRetryAt).toBeUndefined();
  }));

  it.effect("retryAt が先の時刻なら、その時刻。その時刻に再試行が呼ばれ、成功すると undefined に戻る", () => Effect.gen(function* () {
    yield* TestClock.adjust(1_000);
    const retryAt = 1_000 + 7 * 60_000;
    const { session: s, calls } = yield* session([pausedWith(retryAt)]);
    yield* s.push(remark(1));
    yield* s.idle;
    expect(yield* s.nextRetryAt).toBe(retryAt);

    yield* TestClock.adjust(retryAt - 1_000 - 1);
    yield* settleUntil(() => calls.length > 1);
    expect(calls).toHaveLength(1);
    yield* TestClock.adjust(1);
    yield* settleUntil(() => calls.length > 1);
    expect(calls).toHaveLength(2);
    yield* s.idle;
    expect(yield* s.nextRetryAt).toBeUndefined();
  }));

  it.effect.each<{ name: string; retryAt: (now: number) => number | undefined }>([
    { name: "retryAt が無い", retryAt: () => undefined },
    { name: "retryAt が過ぎている", retryAt: (now) => now - 1_000 },
    { name: "retryAt が今と同じ", retryAt: (now) => now },
  ])("$name ときは、DIFF_UPDATE_RETRY_MS 後", ({ retryAt }) => Effect.gen(function* () {
    yield* TestClock.adjust(10_000);
    const now = 10_000;
    const { session: s, calls } = yield* session([pausedWith(retryAt(now))]);
    yield* s.push(remark(1));
    yield* s.idle;
    expect(yield* s.nextRetryAt).toBe(now + DIFF_UPDATE_RETRY_MS);

    yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
    yield* settleUntil(() => calls.length > 1);
    expect(calls).toHaveLength(2);
  }));

  it.effect("再試行でも戻らなければ、返ってきた retryAt に関わらず、その時点から DIFF_UPDATE_RETRY_MS 後に更新される。更新後の時刻にまた試す", () => Effect.gen(function* () {
    const first = 2 * 60_000;
    const { session: s, calls } = yield* session([pausedWith(first), pausedWith(first + 3_600_000)]);
    yield* s.push(remark(1));
    yield* s.idle;
    expect(yield* s.nextRetryAt).toBe(first);

    yield* TestClock.adjust(first);
    yield* settleUntil(() => calls.length > 1);
    yield* s.idle;
    expect(calls).toHaveLength(2);
    // 古い時刻（first）のままではなく、再試行した時点（first）から 5 分後
    expect(yield* s.nextRetryAt).toBe(first + DIFF_UPDATE_RETRY_MS);

    yield* TestClock.adjust(DIFF_UPDATE_RETRY_MS);
    yield* settleUntil(() => calls.length > 2);
    expect(calls).toHaveLength(3);
    yield* s.idle;
    expect(yield* s.nextRetryAt).toBeUndefined();
  }));
});
