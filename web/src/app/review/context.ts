// 見返しの Foldkit プログラム（Issue #823）の Context。起動時に決まる入力（時間軸と再生の文脈）を Model の外に持つ。
// 時間軸の snapshotAt が書き込む cache（Map）もここにあり、Model には入らない
import { Option } from "effect";
import { AUDIO_RATES, PLAYBACK_RATES, type PlaybackContext } from "../../reviewPlayback.ts";
import { buildReviewTimeline, type ReviewTimeline } from "../../reviewTimeline.ts";

// isMac は表示面のパン（Shift＋縦スクロールの向き）とズームの修飾キーに要る、起動時に決まる値。
// maybeAudioUrl: 録音つきなら <audio> の URL。録音の有無は起動時に決まるので Model には持たない
export type Context = { timeline: ReviewTimeline; playback: PlaybackContext; isMac: boolean; maybeAudioUrl: Option.Option<string> };

export const makeContext = (events: readonly unknown[], { isMac = false, maybeAudioUrl = Option.none<string>() }: { isMac?: boolean; maybeAudioUrl?: Option.Option<string> } = {}): Context => {
  const timeline = buildReviewTimeline(events);
  return { timeline, playback: { duration: timeline.duration, reflectionTimes: timeline.reflectionTimes, rates: Option.isSome(maybeAudioUrl) ? AUDIO_RATES : PLAYBACK_RATES }, isMac, maybeAudioUrl };
};
