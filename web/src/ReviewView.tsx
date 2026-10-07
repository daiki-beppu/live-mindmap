import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { ReviewControls } from "./ReviewControls.tsx";
import { initialPlayback, PLAYBACK_RATES, playbackReducer, type PlaybackEvent } from "./reviewPlayback.ts";
import { buildReviewTimeline, reviewChapters, reviewMarks, snapshotAt, speakingAt, topicNameOf } from "./reviewTimeline.ts";
import { SessionView } from "./SessionView.tsx";
import { useAudioClock } from "./useAudioClock.ts";
import { usePlaybackClock } from "./usePlaybackClock.ts";

// 音声つきの版の速さは 1 倍だけ（並び [1]。0.5〜2 倍とミュートは後の段）
const AUDIO_RATES: readonly number[] = [1];

// 見返し（map.html・map-audio.html）。audioUrl があれば音声つき: 時刻の元は <audio> の currentTime だけで、usePlaybackClock は使わない。時刻を動かすと、その時点のマップ・カメラ・「変わったこと」・根拠・字幕を SessionView に渡す。
// 取り込みの状態は渡さない（見返しでは、取り込みの知らせは出さない）
export function ReviewView({ events, audioUrl }: { events: readonly unknown[]; audioUrl?: string }) {
  const timeline = useMemo(() => buildReviewTimeline(events), [events]);
  const chapters = useMemo(() => reviewChapters(timeline), [timeline]);
  const marks = useMemo(() => reviewMarks(timeline), [timeline]);
  const context = useMemo(() => ({ duration: timeline.duration, reflectionTimes: timeline.reflectionTimes, rates: audioUrl ? AUDIO_RATES : PLAYBACK_RATES }), [timeline, audioUrl]);
  const [state, dispatch] = useReducer((s: ReturnType<typeof initialPlayback>, e: PlaybackEvent) => playbackReducer(s, e, context), timeline.duration, (duration) => initialPlayback(duration, audioUrl ? AUDIO_RATES[0] : undefined));
  const audio = useRef<HTMLAudioElement>(null);
  // 人が時刻を動かした回数（▶・シーク・反映の前後）。elapsed・audioTime・ended・setRate では増やさない
  const [timeMoves, setTimeMoves] = useState(0);
  usePlaybackClock(
    state.playing && !audioUrl,
    useCallback((seconds: number) => dispatch({ type: "elapsed", seconds }), []),
  );
  useAudioClock(
    audio,
    state.playing && !!audioUrl,
    useCallback((time: number) => dispatch({ type: "audioTime", time }), []),
    useCallback(() => dispatch({ type: "toggle" }), []),
  );
  // 操作: 今の reducer の規則で行き先の時刻を決めて dispatch し、音声つきなら、その時刻を currentTime に書く（止めている間も同じ）
  const operate = (event: PlaybackEvent) => {
    const next = playbackReducer(state, event, context);
    setTimeMoves((n) => n + 1);
    dispatch(event);
    if (audio.current && next.time !== state.time) audio.current.currentTime = next.time;
  };
  const snapshot = snapshotAt(timeline, state.time);
  return (
    <div className="review">
      <div className="review__session">
        <SessionView snapshot={snapshot} speaking={speakingAt(timeline, state.time)} review={{ timeMoves }} />
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
        onSeek={(time) => operate({ type: "seek", time })}
        onToggle={() => operate({ type: "toggle" })}
        onPrev={() => operate({ type: "prev" })}
        onNext={() => operate({ type: "next" })}
        onRate={(rate) => dispatch({ type: "setRate", rate })}
      />
      {audioUrl && <audio ref={audio} src={audioUrl} preload="auto" onEnded={() => dispatch({ type: "ended" })} />}
    </div>
  );
}
