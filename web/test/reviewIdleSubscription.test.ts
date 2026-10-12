import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { makeContext } from "../src/app/review/context.ts";
import { init, makeUpdate, type Model } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { makeSubscriptions, REVIEW_IDLE_MS } from "../src/app/review/subscription.ts";

// 見返しの「触らずに 10 秒で自動に戻る」（Issue #819）の Subscription。時間は Model の条件で開け閉めするタイマーで計り、update は時刻を読まない。
// 開く条件（止めている間だけ）と、計り直しの依存（通し番号）は modelToDependencies、10 秒ちょうどで出す Message は dependenciesToStream を TestClock で確かめる。
// ElapsedIdleTime を受けた後の update の振る舞いは、mapSurfaceCamera.story.test.ts と review.story.test.ts で確かめる

const events = [
  { at: "a", type: "start", title: "定例" },
  { at: "x", type: "remark", remark: { id: "r1", track: "相手", start: 5, end: 10, text: "採用の話をします。" } },
  { at: "x", type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] }], dropped: [] },
];
const context = makeContext(events);
const update = makeUpdate(context);
const subscriptions = makeSubscriptions(context);
const surface = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });
const wheel = (deltaY: number) => surface(MapSurfaceMessage.WheeledMapSurface({ x: 0, y: 0, deltaX: 0, deltaY, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, timeStamp: 0 }));
const measured = (m: Model): Model => update(m, surface(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, t1: 40 } }))).model;
const idleMessage = () => Message.GotMapSurfaceMessage({ message: MapSurfaceMessage.ElapsedIdleTime() });

describe("見返しの 10 秒のタイマー: 開く条件と計り直し", () => {
  it("待つ時間は 10,000ms（React 版の REVIEW_IDLE_MS と同じ）", () => {
    expect(REVIEW_IDLE_MS).toBe(10_000);
  });

  it("止めている（manual）間だけ待つ。自動のとき・全体を見ているときは待たない", () => {
    const auto = measured(init(context));
    expect(subscriptions.idle.modelToDependencies(auto).isWaiting).toBe(false);
    const manual = update(auto, wheel(100)).model;
    expect(manual.mapSurface.viewing.mode).toBe("manual");
    expect(subscriptions.idle.modelToDependencies(manual).isWaiting).toBe(true);
    const overview = update(auto, surface(MapSurfaceMessage.PressedViewKey({ key: "F", metaKey: false, ctrlKey: false, altKey: false }))).model;
    expect(overview.mapSurface.viewing.mode).toBe("overview");
    expect(subscriptions.idle.modelToDependencies(overview).isWaiting).toBe(false);
  });

  it("人が動かすたびに依存が変わり（計り直し）、E・選択では変わらない（計り直さない）", () => {
    const first = update(measured(init(context)), wheel(100)).model;
    const again = update(first, wheel(100)).model;
    const depsOf = (m: Model) => subscriptions.idle.modelToDependencies(m);
    expect(depsOf(again)).not.toEqual(depsOf(first));
    const afterSide = update(again, surface(MapSurfaceMessage.PressedSideKey({ metaKey: false, ctrlKey: false, altKey: false }))).model;
    expect(depsOf(afterSide)).toEqual(depsOf(again));
    const afterSelect = update(again, surface(MapSurfaceMessage.ClickedNodeButton({ nodeId: "t1", clientX: 0, clientY: 0 }))).model;
    expect(depsOf(afterSelect)).toEqual(depsOf(again));
  });
});

describe("見返しの 10 秒のタイマー: キーの一覧の開閉での計り直し", () => {
  const key = (id: "?" | "Escape" | "E" | "C", modifiers: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) =>
    Message.PressedKey({ key: id, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });
  const depsOf = (m: Model) => subscriptions.idle.modelToDependencies(m);
  const manual = (): Model => {
    const m = update(measured(init(context)), wheel(100)).model;
    expect(m.mapSurface.viewing.mode).toBe("manual");
    return m;
  };
  // mode・viewport・選択・見る状態は変わらない
  const expectSameViewing = (after: Model, before: Model) => {
    expect(after.mapSurface.viewing).toEqual(before.mapSurface.viewing);
    expect(after.mapSurface.viewport).toEqual(before.mapSurface.viewport);
  };

  it("? で開くと依存が変わり（待つ状態は保つ）、mode・viewport・選択は変わらない", () => {
    const before = manual();
    const after = update(before, key("?")).model;
    expect(after.keyList.isOpen).toBe(true);
    expect(depsOf(after)).not.toEqual(depsOf(before));
    expect(depsOf(after).isWaiting).toBe(true);
    expectSameViewing(after, before);
  });

  it("? で閉じると依存が変わる", () => {
    const opened = update(manual(), key("?")).model;
    const closed = update(opened, key("?")).model;
    expect(closed.keyList.isOpen).toBe(false);
    expect(depsOf(closed)).not.toEqual(depsOf(opened));
    expectSameViewing(closed, opened);
  });

  it("一覧が開いた状態の Escape で閉じると依存が変わり、選択は残る", () => {
    const selected = update(manual(), surface(MapSurfaceMessage.ClickedNodeButton({ nodeId: "t1", clientX: 0, clientY: 0 }))).model;
    const opened = update(selected, key("?")).model;
    expect(opened.mapSurface.viewing.selection).toBeDefined();
    const closed = update(opened, key("Escape")).model;
    expect(closed.keyList.isOpen).toBe(false);
    expect(closed.mapSurface.viewing.selection).toEqual(opened.mapSurface.viewing.selection);
    expect(depsOf(closed)).not.toEqual(depsOf(opened));
    expectSameViewing(closed, opened);
  });

  it("速さのメニューが開いているときの Escape はメニューを閉じるだけで、依存は変わらず、一覧は開いたまま", () => {
    const opened = update(manual(), key("?")).model;
    const withMenu = { ...opened, rateMenu: { ...opened.rateMenu, isOpen: true } };
    const after = update(withMenu, key("Escape")).model;
    expect(after.rateMenu.isOpen).toBe(false);
    expect(after.keyList.isOpen).toBe(true);
    expect(depsOf(after)).toEqual(depsOf(withMenu));
  });

  it("修飾キー付きの ? では何も起きない。E・C では計り直さない", () => {
    const before = manual();
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      const after = update(before, key("?", modifiers)).model;
      expect(after, JSON.stringify(modifiers)).toEqual(before);
    }
    for (const id of ["E", "C"] as const) expect(depsOf(update(before, key(id)).model), id).toEqual(depsOf(before));
  });

  it("開閉から 10,000ms 経つと自動に戻る（開閉の前の待ちは無効になる）", async () => {
    const before = manual();
    const opened = update(before, key("?")).model;
    // 開閉前の依存の待ちは作り直され、開閉後の依存の待ちが 10,000ms で ElapsedIdleTime を出す
    const afterIdle = update(opened, idleMessage()).model;
    expect(afterIdle.mapSurface.viewing.mode).toBe("auto");
    expect(depsOf(opened).isWaiting).toBe(true);
    expect(depsOf(opened)).not.toEqual(depsOf(before));
  });
});

describe("見返しの 10 秒のタイマー: stream", () => {
  const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });
  // stream を走らせて届いた Message を集める。body は走らせている間の操作。時計は TestClock
  const run = (deps: { isWaiting: boolean; stamp: number }, body: (collected: Array<typeof Message.Type>, fiber: Fiber.Fiber<void, unknown>) => Effect.Effect<void>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const collected: Array<typeof Message.Type> = [];
        const fiber = yield* Effect.forkChild(Stream.runForEach(subscriptions.idle.dependenciesToStream(deps), (m) => Effect.sync(() => void collected.push(m))));
        yield* settle;
        yield* body(collected, fiber);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

  it("待つ間は、9,999ms では何も出さず、10,000ms ちょうどで ElapsedIdleTime を 1 回出す", async () => {
    await run({ isWaiting: true, stamp: 1 }, (collected) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(REVIEW_IDLE_MS - 1);
        yield* settle;
        expect(collected).toEqual([]);
        yield* TestClock.adjust(1);
        yield* settle;
        expect(collected).toEqual([idleMessage()]);
        yield* TestClock.adjust(REVIEW_IDLE_MS * 3);
        yield* settle;
        expect(collected).toEqual([idleMessage()]);
      }),
    );
  });

  it("待たない（止めていない）ときは、時間が経っても何も出さない", async () => {
    await run({ isWaiting: false, stamp: 1 }, (collected) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(REVIEW_IDLE_MS * 6);
        yield* settle;
        expect(collected).toEqual([]);
      }),
    );
  });

  it("待っている最中に止める（依存が変わって作り直される）と、その待ちは出さない", async () => {
    await run({ isWaiting: true, stamp: 1 }, (collected, fiber) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(REVIEW_IDLE_MS - 1);
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust(REVIEW_IDLE_MS * 3);
        yield* settle;
        expect(collected).toEqual([]);
      }),
    );
  });
});
