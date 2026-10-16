import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { createRecordedBacklog } from "../src/recordedBacklog.ts";
import { settleUntil } from "./fixtures/sessionLayers.ts";

// Issue #1092: 溜まりから 1 件ずつ入れる前に、止めが解けるまで待つ（hold）。待っている間に discard されたら、その 1 件は入れずに抜ける。
// 一時停止の間に入る発言が増えないこと（invRecordedBacklog）を、溜まりの単位で確かめる。

describe("recordedBacklog の hold（一時停止の間は入れない）", () => {
  it.effect("hold が解けるまで 1 件も入れず、解けたら溜まっていた分を溜めた順に 1 回ずつ入れる", () => Effect.gen(function* () {
    const open = yield* Deferred.make<void>();
    const delivered: number[] = [];
    const backlog = yield* createRecordedBacklog<number>({
      deliver: (item) => Effect.sync(() => void delivered.push(item)),
      hold: Deferred.await(open),
    });
    for (const item of [1, 2, 3]) yield* backlog.offer(item);
    yield* settleUntil(() => delivered.length > 0); // 入るなら、ここで入る
    expect(delivered).toEqual([]);

    yield* Deferred.succeed(open, undefined);
    yield* backlog.finish;
    expect(delivered).toEqual([1, 2, 3]);
  }).pipe(Effect.scoped));

  it.effect("hold は 1 件ごとに見直す。2 件目の前でまた止まると、2 件目は入らず、解けたら続きから入る（重複・抜けなし）", () => Effect.gen(function* () {
    const second = yield* Deferred.make<void>();
    const checks = { count: 0 };
    const delivered: number[] = [];
    const backlog = yield* createRecordedBacklog<number>({
      deliver: (item) => Effect.sync(() => void delivered.push(item)),
      // 1 件目の前は通り、2 件目の前で止まる
      hold: Effect.suspend(() => {
        checks.count += 1;
        return checks.count === 2 ? Deferred.await(second) : Effect.void;
      }),
    });
    for (const item of [1, 2, 3]) yield* backlog.offer(item);
    yield* settleUntil(() => delivered.length > 1);
    expect(delivered).toEqual([1]);

    yield* Deferred.succeed(second, undefined);
    yield* backlog.finish;
    expect(delivered).toEqual([1, 2, 3]);
  }).pipe(Effect.scoped));

  it.effect("hold で待っている間の discard は、その 1 件を入れずに戻る。finish も戻る", () => Effect.gen(function* () {
    const delivered: number[] = [];
    const backlog = yield* createRecordedBacklog<number>({
      deliver: (item) => Effect.sync(() => void delivered.push(item)),
      hold: Effect.never,
    });
    for (const item of [1, 2]) yield* backlog.offer(item);
    yield* settleUntil(() => delivered.length > 0);
    yield* backlog.discard;
    const finishing = yield* Effect.forkChild(backlog.finish);
    yield* settleUntil(() => finishing.pollUnsafe() !== undefined);
    expect(finishing.pollUnsafe()).toBeDefined();
    yield* Fiber.join(finishing);
    expect(delivered).toEqual([]);
  }).pipe(Effect.scoped));

  it.effect("hold が無いときは、今までどおり待たずに入れる", () => Effect.gen(function* () {
    const delivered: number[] = [];
    const backlog = yield* createRecordedBacklog<number>({ deliver: (item) => Effect.sync(() => void delivered.push(item)) });
    for (const item of [1, 2, 3]) yield* backlog.offer(item);
    yield* backlog.finish;
    expect(delivered).toEqual([1, 2, 3]);
  }).pipe(Effect.scoped));
});
