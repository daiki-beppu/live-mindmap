import { Match } from "effect";
import type { DiffUpdateState, SelfPaused, Snapshot, SpeakerNames, ViewerFrame } from "../../server/src/core/index.ts";
import { advanceCaptions, createCaptionState, receiveCaptions, type CaptionState } from "./captions.ts";
import type { IntakeStatus } from "./intake.ts";

const DEFAULT_INTAKE: IntakeStatus = "running";

export type FeedState = { snapshot: Snapshot | null; captions: CaptionState; intake: IntakeStatus; screenNotice: string | null; tapNotice: string | null; discussionNotice: string | null; diffUpdate: DiffUpdateState | null; selfPaused: SelfPaused; local: boolean; speakerNames: SpeakerNames };

export function createFeedState(): FeedState {
  return { snapshot: null, captions: createCaptionState(), intake: DEFAULT_INTAKE, screenNotice: null, tapNotice: null, discussionNotice: null, diffUpdate: null, selfPaused: false, local: false, speakerNames: {} };
}

export function applyFrame(state: FeedState, frame: ViewerFrame, now: number): FeedState {
  return Match.type<ViewerFrame>().pipe(
    Match.withReturnType<FeedState>(),
    Match.discriminatorsExhaustive("type")({
      snapshot: (frame) => ({ ...state, snapshot: frame.snapshot }),
      captions: (frame) => ({ ...state, captions: receiveCaptions(state.captions, frame.bubbles, now) }),
      intake: (frame) => ({ ...state, intake: frame.status }),
      "screen-notice": (frame) => ({ ...state, screenNotice: frame.text }),
      "discussion-notice": (frame) => ({ ...state, discussionNotice: frame.text }),
      "tap-notice": (frame) => ({ ...state, tapNotice: frame.text }),
      "self-pause": (frame) => ({ ...state, selfPaused: frame.paused ? frame.reason : false }),
      "diff-update": (frame) => ({ ...state, diffUpdate: frame.state }),
      "session-mode": (frame) => ({ ...state, local: frame.local }),
      "speaker-names": (frame) => ({ ...state, speakerNames: Object.fromEntries(frame.names.map(({ label, name }) => [label, name])) }),
    }),
  )(frame);
}

export function applyCaptionDeadline(state: FeedState, at: number): FeedState {
  return { ...state, captions: advanceCaptions(state.captions, at) };
}

export function applyOpen(state: FeedState): FeedState {
  return { ...state, captions: createCaptionState(), screenNotice: null, tapNotice: null, discussionNotice: null, selfPaused: false, local: false, speakerNames: {} };
}

export function applyClose(state: FeedState): FeedState {
  return { ...state, screenNotice: null, tapNotice: null, discussionNotice: null, selfPaused: false, local: false };
}
