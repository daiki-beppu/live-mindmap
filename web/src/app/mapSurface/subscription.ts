import { Effect, Option, Schema, Stream } from "effect";
import { Dom, Subscription } from "foldkit";
import type { Model } from "./main.ts";
import { Message } from "./message.ts";

export const idleElapsedStream = ({ isWaiting, afterMs }: { isWaiting: boolean; afterMs: number }): Stream.Stream<Message> =>
  Stream.when(Stream.fromEffect(Effect.sleep(afterMs).pipe(Effect.as(Message.ElapsedIdleTime()))), Effect.sync(() => isWaiting));

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
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
