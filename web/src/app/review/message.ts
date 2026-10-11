// 見返しの Foldkit プログラム（Issue #823・#824）が受ける Message。Command の結果は Command の名前から作る（PlayAudio → SucceededPlayAudio・FailedPlayAudio）。prev・next は反映の時刻への移動。表示面の Message は包んで受ける
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Message as MapSurfaceMessage } from "../mapSurface/message.ts";

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
});
export type Message = typeof Message.Type;
