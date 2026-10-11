// 見返しの Foldkit プログラム（Issue #823・#824・#825）が受ける Message。Command の結果は Command の名前から作る（PlayAudio → SucceededPlayAudio・FailedPlayAudio）。prev・next は反映の時刻への移動。
// 表示面と、操作の行の部品（Slider・Menu・Tooltip）の Message は包んで受ける。Slider・Menu の結果は update が OutMessage（ChangedValue・Selected）で受け、中の Message は見ない
import { Menu, Slider, Tooltip } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Message as MapSurfaceMessage } from "../mapSurface/message.ts";

// ボタンごとの Tooltip。Model の tooltips の欄名と同じ
export const TooltipKey = Schema.Literals(["prev", "toggle", "next", "mute", "captions", "rate", "side"]);
export type TooltipKey = typeof TooltipKey.Type;

export const Message = defineMessageUnion({
  ClickedPrev: {},
  ClickedNext: {},
  ClickedToggle: {},
  TickedFrame: { ms: Schema.Finite },
  UpdatedAudioTime: { time: Schema.Finite },
  EndedAudio: {},
  SucceededPlayAudio: {},
  FailedPlayAudio: { isAborted: Schema.Boolean },
  CompletedPauseAudio: {},
  CompletedSeekAudio: {},
  CompletedWriteAudioSettings: {},
  GotMapSurfaceMessage: { message: MapSurfaceMessage },
  GotSeekSliderMessage: { message: Slider.Message },
  GotVolumeSliderMessage: { message: Slider.Message },
  GotRateMenuMessage: { message: Menu.Message },
  GotTooltipMessage: { tooltipId: TooltipKey, message: Tooltip.Message },
  ClickedMute: {},
  // 字幕の Disclosure（#820）が出す Message と同じ形。isOpen は、押したあとに字幕を出すか
  ToggledCaptions: { isOpen: Schema.Boolean },
  ClickedSide: {},
  // シークバーの上のポインタの位置（左端 0・右端 1 の割合）。バーから離れたら LeftSeekPointer
  MovedSeekPointer: { fraction: Schema.Finite },
  LeftSeekPointer: {},
  // スライダー（シーク・音量）を押した事実と、押したあとに文書で離した事実。離したらフォーカスを外す
  PressedSliderPointer: {},
  ReleasedSliderPointer: {},
  // 押している間に pointercancel で中断された事実。離したときと違い、ドラッグを終えて値は中断時点のまま残す
  CancelledSliderPointer: {},
  CompletedReleaseFocus: {},
  CompletedReleaseFocusAfterMenuClose: {},
});
export type Message = typeof Message.Type;
