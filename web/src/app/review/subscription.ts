import { Option, Schema, Stream } from "effect";
import { Slider } from "@foldkit/ui";
import { Dom, Subscription } from "foldkit";
import { keyPressStream } from "../keys/subscription.ts";
import { subscriptions as mapSurfaceSubscriptions, idleElapsedStream } from "../mapSurface/subscription.ts";
import { reviewScreenOf, type Context } from "./context.ts";
import { surfaceOf } from "./main.ts";
import type { Model } from "./main.ts";
import { Message } from "./message.ts";

export const REVIEW_IDLE_MS = 10_000;

export const makeSubscriptions = (context: Context) => {
  const own = Subscription.make<Model, Message>()((entry) => ({
    frame: Subscription.animationFrameEntry({
      isActive: (model) => model.playback.playing && Option.isNone(context.maybeAudioUrl),
      toMessage: (ms) => Message.TickedFrame({ ms }),
    }),
    sliderRelease: entry(
      { isPressing: Schema.Boolean },
      {
        modelToDependencies: (model) => ({ isPressing: model.isPressingSlider }),
        dependenciesToStream: ({ isPressing }) =>
          isPressing
            ? Stream.merge(
                Dom.streamFromEvent({ target: document, type: "pointerup", mapEvent: () => Message.ReleasedSliderPointer() }),
                Dom.streamFromEvent({ target: document, type: "pointercancel", mapEvent: () => Message.CancelledSliderPointer() }),
              )
            : Stream.empty,
      },
    ),
    idle: entry(
      { isWaiting: Schema.Boolean, stamp: Schema.Finite },
      {
        modelToDependencies: (model) => ({ isWaiting: model.mapSurface.viewing.mode === "manual", stamp: model.mapSurface.idleStamp }),
        dependenciesToStream: ({ isWaiting }) => Stream.map(idleElapsedStream({ isWaiting, afterMs: REVIEW_IDLE_MS }), (message) => Message.GotMapSurfaceMessage({ message })),
      },
    ),
    keys: entry(
      { hasSelection: Schema.Boolean },
      {
        modelToDependencies: (model) => ({ hasSelection: model.mapSurface.viewing.selection !== undefined }),
        keepAliveEquivalence: () => true,
        dependenciesToStream: (_, readDependencies) => keyPressStream({ screen: reviewScreenOf(context), hasSelection: () => readDependencies().hasSelection }),
      },
    ),
  }));
  const seek = Subscription.lift({ seekDragPointer: Slider.subscriptions.dragPointer, seekDragEscape: Slider.subscriptions.dragEscape })<Model, Message>({
    read: (model) => Option.some(model.seekSlider),
    toParentMessage: (message) => Message.GotSeekSliderMessage({ message }),
  });
  const volume = Subscription.lift({ volumeDragPointer: Slider.subscriptions.dragPointer, volumeDragEscape: Slider.subscriptions.dragEscape })<Model, Message>({
    read: (model) => Option.some(model.volumeSlider),
    toParentMessage: (message) => Message.GotVolumeSliderMessage({ message }),
  });
  const pointer = Subscription.lift({ mapSurfaceAnimationFrame: mapSurfaceSubscriptions.animationFrame, mapSurfacePointer: mapSurfaceSubscriptions.pointer })<Model, Message>({
    read: (model) => Option.some(surfaceOf(context, model)),
    toParentMessage: (message) => Message.GotMapSurfaceMessage({ message }),
  });
  return Subscription.aggregate(own, seek, volume, pointer);
};
