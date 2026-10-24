import { Option } from "effect";
import type { Screen } from "../keys/table.ts";
import { AUDIO_RATES, PLAYBACK_RATES, type PlaybackContext } from "../../reviewPlayback.ts";
import { buildReviewTimeline, reviewChapters, reviewMarks, type Chapter, type Mark, type ReviewTimeline } from "../../reviewTimeline.ts";

export type Context = { timeline: ReviewTimeline; playback: PlaybackContext; isMac: boolean; maybeAudioUrl: Option.Option<string>; chapters: readonly Chapter[]; marks: readonly Mark[] };

export const makeContext = (events: readonly unknown[], { isMac = false, maybeAudioUrl = Option.none<string>() }: { isMac?: boolean; maybeAudioUrl?: Option.Option<string> } = {}): Context => {
  const timeline = buildReviewTimeline(events);
  return { timeline, playback: { duration: timeline.duration, reflectionTimes: timeline.reflectionTimes, rates: Option.isSome(maybeAudioUrl) ? AUDIO_RATES : PLAYBACK_RATES }, isMac, maybeAudioUrl, chapters: reviewChapters(timeline), marks: reviewMarks(timeline) };
};

export const reviewScreenOf = (context: Context): Screen => (Option.isSome(context.maybeAudioUrl) ? "reviewAudio" : "review");
