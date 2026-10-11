// 見返しの Foldkit プログラム（Issue #823）の Context。起動時に決まる入力（時間軸と再生の文脈）を Model の外に持つ。
// 時間軸の snapshotAt が書き込む cache（Map）もここにあり、Model には入らない
import { PLAYBACK_RATES, type PlaybackContext } from "../../reviewPlayback.ts";
import { buildReviewTimeline, type ReviewTimeline } from "../../reviewTimeline.ts";

export type Context = { timeline: ReviewTimeline; playback: PlaybackContext };

export const makeContext = (events: readonly unknown[]): Context => {
  const timeline = buildReviewTimeline(events);
  return { timeline, playback: { duration: timeline.duration, reflectionTimes: timeline.reflectionTimes, rates: PLAYBACK_RATES } };
};
