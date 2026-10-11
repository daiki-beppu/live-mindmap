// 見返しの Foldkit プログラム（Issue #823）が受ける Message。prev・next は反映の時刻への移動。表示面の Message は包んで受ける
import { defineMessageUnion } from "foldkit/message";
import { Message as MapSurfaceMessage } from "../mapSurface/message.ts";

export const Message = defineMessageUnion({
  ClickedPrev: {},
  ClickedNext: {},
  GotMapSurfaceMessage: { message: MapSurfaceMessage },
});
export type Message = typeof Message.Type;
