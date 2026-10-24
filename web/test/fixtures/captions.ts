import type { CaptionBubble, CaptionsFrame, Track } from "../../../server/src/core/index.ts";
import { createCaptionState, receiveCaptions, type CaptionState } from "../../src/captions.ts";

export const spokenBubble = (text: string, track: Track = "相手", start = track === "相手" ? 0 : 1): CaptionBubble => ({
  id: `spoken-${track}`,
  track,
  speaker: track === "自分" ? "自分" : "相手 A",
  label: "確定",
  start,
  end: start + 1,
  text,
  settledLength: text.length,
});

export const spokenFrame = (text: string, track: Track = "相手"): CaptionsFrame => ({ type: "captions", bubbles: [spokenBubble(text, track)] });

export const spoken = (相手: string, 自分: string): CaptionState =>
  receiveCaptions(createCaptionState(), [...(相手 === "" ? [] : [spokenBubble(相手, "相手")]), ...(自分 === "" ? [] : [spokenBubble(自分, "自分")])], 0);
