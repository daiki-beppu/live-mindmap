import { Schema } from "effect";
import { DiscussionNoticeFrame } from "./discussionNotice.ts";
import { CaptionsFrame } from "./captions.ts";
import { DiffUpdateFrame } from "./diffUpdate.ts";
import { IntakeFrame } from "./intake.ts";
import { ScreenNoticeFrame } from "./screenNotice.ts";
import { SelfPauseFrame } from "./selfPause.ts";
import { SessionModeFrame } from "./sessionMode.ts";
import { SnapshotFrame } from "./snapshot.ts";
import { SpeakerNamesFrame } from "./speakerNames.ts";
import { TapNoticeFrame } from "./tapNotice.ts";

export const ViewerFrame = Schema.Union([DiscussionNoticeFrame, SnapshotFrame, CaptionsFrame, IntakeFrame, ScreenNoticeFrame, TapNoticeFrame, SelfPauseFrame, DiffUpdateFrame, SessionModeFrame, SpeakerNamesFrame]);
export type ViewerFrame = typeof ViewerFrame.Type;
