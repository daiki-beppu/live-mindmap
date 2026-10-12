import { Popover } from "@foldkit/ui";
import { defineMessageUnion } from "foldkit/message";
import { pressedKeyFields } from "../keys/message.ts";
import { Message as LiveFeedMessage } from "../liveFeed/message.ts";
import { Message as MapSurfaceMessage } from "../mapSurface/message.ts";
import { Message as SessionLayoutMessage } from "../sessionLayout/message.ts";

export const Message = defineMessageUnion({
  GotLiveFeedMessage: { message: LiveFeedMessage },
  GotMapSurfaceMessage: { message: MapSurfaceMessage },
  GotSessionLayoutMessage: { message: SessionLayoutMessage },
  GotKeyListMessage: { message: Popover.Message },
  PressedKey: pressedKeyFields,
});
export type Message = typeof Message.Type;
