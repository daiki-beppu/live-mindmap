// 撮影（map.png）の Foldkit プログラム（Issue #827）が受ける Message。受けるのは表示面の Message だけ（表示面の実測が親の Model に入る）
import { defineMessageUnion } from "foldkit/message";
import { Message as MapSurfaceMessage } from "../mapSurface/message.ts";

export const Message = defineMessageUnion({
  GotMapSurfaceMessage: { message: MapSurfaceMessage },
});
export type Message = typeof Message.Type;
