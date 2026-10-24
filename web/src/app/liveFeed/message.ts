import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { CaptionsFrame, DiffUpdateFrame, IntakeFrame, ScreenNoticeFrame, SelfPauseFrame, SessionModeFrame, Snapshot, SpeakerNamesFrame, TapNoticeFrame } from "../../../../server/src/core/index.ts";

const SnapshotFrame = Schema.Struct({ ...Snapshot.fields, type: Schema.optionalKey(Schema.Never) });

export const LiveFrame = Schema.Union([SnapshotFrame, CaptionsFrame, IntakeFrame, ScreenNoticeFrame, TapNoticeFrame, SelfPauseFrame, DiffUpdateFrame, SessionModeFrame, SpeakerNamesFrame]);
export type LiveFrame = typeof LiveFrame.Type;

export const Message = defineMessageUnion({
  ConnectedLiveFeed: {},
  ReceivedLiveFrame: { frame: LiveFrame, receivedAt: Schema.Finite },
  ReachedCaptionDeadline: { at: Schema.Finite },
  DisconnectedLiveFeed: {},
});
export type Message = typeof Message.Type;
