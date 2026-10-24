import type { CaptionsFrame, DiffUpdateFrame, DiffUpdateState, IntakeFrame, ScreenNoticeFrame, SelfPauseFrame, SelfPaused, SessionModeFrame, Snapshot, SpeakerNames, SpeakerNamesFrame, TapNoticeFrame } from "../../server/src/core/index.ts";
import { advanceCaptions, createCaptionState, receiveCaptions, type CaptionState } from "./captions.ts";
import type { IntakeStatus } from "./intake.ts";

const DEFAULT_INTAKE: IntakeStatus = "running";

export type FeedState = { snapshot: Snapshot | null; captions: CaptionState; intake: IntakeStatus; screenNotice: string | null; tapNotice: string | null; diffUpdate: DiffUpdateState | null; selfPaused: SelfPaused; local: boolean; speakerNames: SpeakerNames };

export function createFeedState(): FeedState {
  return { snapshot: null, captions: createCaptionState(), intake: DEFAULT_INTAKE, screenNotice: null, tapNotice: null, diffUpdate: null, selfPaused: false, local: false, speakerNames: {} };
}

export function applyFrame(state: FeedState, frame: Snapshot | CaptionsFrame | IntakeFrame | ScreenNoticeFrame | TapNoticeFrame | SelfPauseFrame | DiffUpdateFrame | SessionModeFrame | SpeakerNamesFrame, now: number): FeedState {
  if (!("type" in frame)) return { ...state, snapshot: frame };
  if (frame.type === "captions") return { ...state, captions: receiveCaptions(state.captions, frame.bubbles, now) };
  if (frame.type === "intake") return { ...state, intake: frame.status };
  if (frame.type === "screen-notice") return { ...state, screenNotice: frame.text };
  if (frame.type === "tap-notice") return { ...state, tapNotice: frame.text };
  if (frame.type === "self-pause") return { ...state, selfPaused: frame.paused ? frame.reason : false };
  if (frame.type === "diff-update") return { ...state, diffUpdate: frame.state };
  if (frame.type === "session-mode") return { ...state, local: frame.local };
  if (frame.type === "speaker-names") return { ...state, speakerNames: Object.fromEntries(frame.names.map(({ label, name }) => [label, name])) };
  return state;
}

export function applyCaptionDeadline(state: FeedState, at: number): FeedState {
  return { ...state, captions: advanceCaptions(state.captions, at) };
}

export function applyOpen(state: FeedState): FeedState {
  return { ...state, captions: createCaptionState(), screenNotice: null, tapNotice: null, selfPaused: false, local: false, speakerNames: {} };
}

export function applyClose(state: FeedState): FeedState {
  return { ...state, screenNotice: null, tapNotice: null, selfPaused: false, local: false };
}
