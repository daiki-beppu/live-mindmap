// 見返しの Subscription（Issue #824・#825）: 録音なしの時計、スライダーのドラッグ、スライダーを押している間の文書の pointerup。
// 録音なしの時計は、進めている間だけ rAF を開き、フレームの ms を Message にする（update は ms を経過秒にして reducer へ渡す）。
// Slider（シーク・音量）のドラッグは Slider 自身の Subscription を、親の Message に包んで足す。
// スライダーを押して離したことは、Slider の中の Message ではなく、押した事実（PressedSliderPointer）の後に文書の pointerup を受けて知る
import { Option, Schema, Stream } from "effect";
import { Slider } from "@foldkit/ui";
import { Dom, Subscription } from "foldkit";
import type { Context } from "./context.ts";
import type { Model } from "./main.ts";
import { Message } from "./message.ts";

export const makeSubscriptions = (context: Context) => {
  const own = Subscription.make<Model, Message>()((entry) => ({
    frame: Subscription.animationFrameEntry({
      isActive: (model) => model.playback.playing && Option.isNone(context.maybeAudioUrl),
      toMessage: (ms) => Message.TickedFrame({ ms }),
    }),
    // 押している間だけ、押した対象の外で離しても届くよう文書の pointerup（と pointercancel）を受ける
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
  }));
  const seek = Subscription.lift({ seekDragPointer: Slider.subscriptions.dragPointer, seekDragEscape: Slider.subscriptions.dragEscape })<Model, Message>({
    read: (model) => Option.some(model.seekSlider),
    toParentMessage: (message) => Message.GotSeekSliderMessage({ message }),
  });
  const volume = Subscription.lift({ volumeDragPointer: Slider.subscriptions.dragPointer, volumeDragEscape: Slider.subscriptions.dragEscape })<Model, Message>({
    read: (model) => Option.some(model.volumeSlider),
    toParentMessage: (message) => Message.GotVolumeSliderMessage({ message }),
  });
  return Subscription.aggregate(own, seek, volume);
};
