// ポインタを押している間だけ、文書全体の pointermove・pointerup・pointercancel を Message にする。
// 押した対象の外へ出ても届くよう、受ける先は document。起きた事実だけを届け、パンの量や終わりの判断は update が行う
import { Effect, Option, Schema, Stream } from "effect";
import { Dom, Subscription } from "foldkit";
import type { Model } from "./main.ts";
import { Message } from "./message.ts";

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
