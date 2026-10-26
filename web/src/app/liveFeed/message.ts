import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { ViewerFrame } from "../../../../server/src/core/index.ts";

export const LiveFrame = ViewerFrame;
export type LiveFrame = typeof LiveFrame.Type;

export const Message = defineMessageUnion({
  ConnectedLiveFeed: {},
  ReceivedLiveFrame: { frame: LiveFrame, receivedAt: Schema.Finite },
  ReachedCaptionDeadline: { at: Schema.Finite },
  DisconnectedLiveFeed: {},
});
export type Message = typeof Message.Type;
