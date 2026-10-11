// ポインタを押している間だけ、文書全体の pointermove・pointerup・pointercancel を Message にする。
// 押した対象の外へ出ても届くよう、受ける先は document。起きた事実だけを届け、パンの量や終わりの判断は update が行う
import { Effect, Option, Schema, Stream } from "effect";
import { Dom, Subscription } from "foldkit";
import type { Model } from "./main.ts";
import { Message } from "./message.ts";

// 触らずに待つ時間（ms）が過ぎたことを、isWaiting が真の間だけ 1 回届ける Stream（Issue #819）。時間は Subscription が計り、update は時刻を読まない。
// 見返しだけが 10 秒で自動に戻るので、いつ開くか（見返しの Model の条件）と待つ時間は、見返しの Subscription が決めて渡す
export const idleElapsedStream = ({ isWaiting, afterMs }: { isWaiting: boolean; afterMs: number }): Stream.Stream<Message> =>
  Stream.when(Stream.fromEffect(Effect.sleep(afterMs).pipe(Effect.as(Message.ElapsedIdleTime()))), Effect.sync(() => isWaiting));

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  // 位置を補間している間だけ、フレームごとに経過 ms を Message にする
  animationFrame: Subscription.animationFrameEntry<Model, Message>({
    isActive: (model) => Option.isSome(model.motion),
    toMessage: (deltaMs) => Message.TickedAnimationFrame({ deltaMs }),
  }),
  pointer: entry(
    { isPressing: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isPressing: Option.isSome(model.pointer) }),
      dependenciesToStream: ({ isPressing }) =>
        Stream.when(
          Stream.merge(
            Stream.merge(
              Dom.streamFromEvent({ target: document, type: "pointermove", mapEvent: (event) => Message.MovedPointer({ clientX: event.clientX, clientY: event.clientY, buttons: event.buttons }) }),
              Dom.streamFromEvent({ target: document, type: "pointerup", mapEvent: (event) => Message.ReleasedPointer({ ctrlKey: event.ctrlKey, metaKey: event.metaKey }) }),
            ),
            Dom.streamFromEvent({ target: document, type: "pointercancel", mapEvent: () => Message.CanceledPointer() }),
          ),
          Effect.sync(() => isPressing),
        ),
    },
  ),
}));
