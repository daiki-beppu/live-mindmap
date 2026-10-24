import { Menu, Popover, Slider, Tooltip } from "@foldkit/ui";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { pressedKeyFields } from "../keys/message.ts";
import { Message as MapSurfaceMessage } from "../mapSurface/message.ts";
import { Message as SessionLayoutMessage } from "../sessionLayout/message.ts";

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
  GotSessionLayoutMessage: { message: SessionLayoutMessage },
  GotSeekSliderMessage: { message: Slider.Message },
  GotVolumeSliderMessage: { message: Slider.Message },
  GotRateMenuMessage: { message: Menu.Message },
  GotTooltipMessage: { tooltipId: TooltipKey, message: Tooltip.Message },
  GotKeyListMessage: { message: Popover.Message },
  PressedKey: pressedKeyFields,
  ClickedMute: {},
  ToggledCaptions: { isOpen: Schema.Boolean },
  ClickedSide: {},
  MovedSeekPointer: { fraction: Schema.Finite },
  LeftSeekPointer: {},
  PressedSliderPointer: {},
  ReleasedSliderPointer: {},
  CancelledSliderPointer: {},
  CompletedReleaseFocus: {},
  CompletedReleaseFocusAfterMenuClose: {},
});
export type Message = typeof Message.Type;
