import { defineMessageUnion } from "foldkit/message";
import { Message as MapSurfaceMessage } from "../mapSurface/message.ts";

export const Message = defineMessageUnion({
  GotMapSurfaceMessage: { message: MapSurfaceMessage },
});
export type Message = typeof Message.Type;
