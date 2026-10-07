import { useCallback, useMemo, useReducer } from "react";
import { ReviewControls } from "./ReviewControls.tsx";
import { initialPlayback, PLAYBACK_RATES, playbackReducer, type PlaybackEvent } from "./reviewPlayback.ts";
import { buildReviewTimeline, reviewChapters, reviewMarks, snapshotAt, speakingAt, topicNameOf } from "./reviewTimeline.ts";
import { SessionView } from "./SessionView.tsx";
import { usePlaybackClock } from "./usePlaybackClock.ts";

// 見返し（map.html）。時刻を動かすと、その時点のマップ・カメラ・「変わったこと」・根拠・字幕を SessionView に渡す。
// 取り込みの状態は渡さない（見返しでは、取り込みの知らせは出さない）
export function ReviewView({ events }: { events: readonly unknown[] }) {
  const timeline = useMemo(() => buildReviewTimeline(events), [events]);
  const chapters = useMemo(() => reviewChapters(timeline), [timeline]);
  const marks = useMemo(() => reviewMarks(timeline), [timeline]);
  const context = useMemo(() => ({ duration: timeline.duration, reflectionTimes: timeline.reflectionTimes, rates: PLAYBACK_RATES }), [timeline]);
  const [state, dispatch] = useReducer((s: ReturnType<typeof initialPlayback>, e: PlaybackEvent) => playbackReducer(s, e, context), timeline.duration, initialPlayback);
  usePlaybackClock(
    state.playing,
    useCallback((seconds: number) => dispatch({ type: "elapsed", seconds }), []),
  );
  const snapshot = snapshotAt(timeline, state.time);
  return (
    <div className="review">
      <div className="review__session">
        <SessionView snapshot={snapshot} speaking={speakingAt(timeline, state.time)} />
      </div>
      <ReviewControls
        time={state.time}
        duration={timeline.duration}
        playing={state.playing}
        rate={state.rate}
        rates={context.rates}
        topicName={topicNameOf(snapshot)}
        chapters={chapters}
        marks={marks}
        onSeek={(time) => dispatch({ type: "seek", time })}
        onToggle={() => dispatch({ type: "toggle" })}
        onPrev={() => dispatch({ type: "prev" })}
        onNext={() => dispatch({ type: "next" })}
        onRate={(rate) => dispatch({ type: "setRate", rate })}
      />
    </div>
  );
}
