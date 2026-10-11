// 見返しの Subscription（Issue #824・#825・#819）: 録音なしの時計、スライダーのドラッグ、スライダーを押している間の文書の pointerup、触らずに 10 秒で自動に戻るタイマー。
// 録音なしの時計は、進めている間だけ rAF を開き、フレームの ms を Message にする（update は ms を経過秒にして reducer へ渡す）。
// Slider（シーク・音量）のドラッグは Slider 自身の Subscription を、親の Message に包んで足す。
// スライダーを押して離したことは、Slider の中の Message ではなく、押した事実（PressedSliderPointer）の後に文書の pointerup を受けて知る。
// 触らずに 10 秒で自動に戻る（Issue #819）は、マップを止めている（manual）間だけタイマーを開く。update は時刻を読まない
import { Option, Schema, Stream } from "effect";
import { Slider } from "@foldkit/ui";
import { Dom, Subscription } from "foldkit";
import { idleElapsedStream } from "../mapSurface/subscription.ts";
import type { Context } from "./context.ts";
import type { Model } from "./main.ts";
import { Message } from "./message.ts";

// 触らずに自動へ戻るまでの時間（ms）。SessionView.tsx の REVIEW_IDLE_MS と同じ（React 版の部品には触らないので、ここに別に置く）
export const REVIEW_IDLE_MS = 10_000;

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
    // 依存の stamp は、見る状態を動かす出来事（E・C・選択を除く）のたびに進むので、人が動かすたびに計り直す
    idle: entry(
      { isWaiting: Schema.Boolean, stamp: Schema.Finite },
      {
        modelToDependencies: (model) => ({ isWaiting: model.mapSurface.viewing.mode === "manual", stamp: model.mapSurface.idleStamp }),
        dependenciesToStream: ({ isWaiting }) => Stream.map(idleElapsedStream({ isWaiting, afterMs: REVIEW_IDLE_MS }), (message) => Message.GotMapSurfaceMessage({ message })),
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
