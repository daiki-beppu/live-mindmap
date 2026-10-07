// 途中結果から発言を出す規則（core/settle.ts）に、時計をつなぐ。
// 予約は Effect の Clock と Effect.sleep のファイバーで張る（中核は実行環境のタイマーを使わない。ADR 0003）。
import { Clock, Effect, Fiber, Ref } from "effect";
import { createRemarkSettler, type HelperPartial, type SettledRemark } from "./core/index.ts";

export type RemarkSettlingOptions = {
  emit: (remark: SettledRemark) => Effect.Effect<void>;
};

// 予約のファイバーは、作ったときの Scope に結び付く（Scope が閉じたら止まる）
export const createRemarkSettling = Effect.fnUntraced(function* ({ emit }: RemarkSettlingOptions) {
  const settler = createRemarkSettler();
  const scope = yield* Effect.scope;
  const timer = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const stopped = yield* Ref.make(false);

  const cancel = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(timer, undefined);
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
  });

  // 次に出す時刻に合わせて、予約を 1 本だけ張り直す
  const schedule: Effect.Effect<void> = Effect.gen(function* () {
    yield* cancel;
    const at = settler.nextDue();
    if (at === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const fiber = yield* Effect.forkIn(
      Effect.gen(function* () {
        yield* Effect.sleep(Math.max(0, at - now));
        yield* Ref.set(timer, undefined); // 出す処理の途中で、自分自身を取り消さない
        for (const remark of settler.due(yield* Clock.currentTimeMillis)) yield* emit(remark);
        yield* schedule;
      }),
      scope,
    );
    yield* Ref.set(timer, fiber);
  });

  // 停止後は何も受け付けない
  const unlessStopped = (effect: Effect.Effect<void>) =>
    Effect.flatMap(Ref.get(stopped), (isStopped) => (isStopped ? Effect.void : effect));

  return {
    partial: (p: HelperPartial) =>
      unlessStopped(
        Effect.gen(function* () {
          settler.partial(p, yield* Clock.currentTimeMillis);
          yield* schedule;
        }),
      ),
    final: (r: SettledRemark) =>
      unlessStopped(
        Effect.gen(function* () {
          for (const remark of settler.final(r, yield* Clock.currentTimeMillis)) yield* emit(remark);
          yield* schedule;
        }),
      ),
    // 停止時。まだ出ていない発話を T を待たずにすべて出す
    drain: () =>
      unlessStopped(
        Effect.gen(function* () {
          for (const remark of settler.drain()) yield* emit(remark);
          yield* schedule;
        }),
      ),
    // 予約を取り消す。以後の入力は無視する
    stop: () =>
      Effect.gen(function* () {
        yield* Ref.set(stopped, true);
        yield* cancel;
      }),
    // 予約のファイバーがあるか
    scheduled: Effect.map(Ref.get(timer), (fiber) => fiber !== undefined),
  };
});
