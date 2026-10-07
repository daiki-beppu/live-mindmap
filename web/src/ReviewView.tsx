import { useHotkey } from "@tanstack/react-hotkeys";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { ReviewControls } from "./ReviewControls.tsx";
import { AUDIO_RATE, AUDIO_RATES, initialPlayback, PLAYBACK_RATES, playbackReducer, type PlaybackEvent } from "./reviewPlayback.ts";
import { AUDIO_HOTKEYS, REVIEW_HOTKEYS, reviewKeyEvent } from "./reviewKeys.ts";
import { buildReviewTimeline, reviewChapters, reviewMarks, snapshotAt, speakingAt, topicNameOf } from "./reviewTimeline.ts";
import { SessionView, type ReviewOverlay } from "./SessionView.tsx";
import { useAudioClock } from "./useAudioClock.ts";
import { usePlaybackClock } from "./usePlaybackClock.ts";

// 見返し（map.html・map-audio.html）。audioUrl があれば音声つき: 時刻の元は <audio> の currentTime だけで、usePlaybackClock は使わない。時刻を動かすと、その時点のマップ・カメラ・「変わったこと」・根拠・字幕を SessionView に渡す。キー: Space・K・J・L・, . < > Home End、音声つきは M（ミュート）も（C・E・矢印などは SessionView の登録）。
// 取り込みの状態は渡さない（見返しでは、取り込みの知らせは出さない）
export function ReviewView({ events, audioUrl }: { events: readonly unknown[]; audioUrl?: string }) {
  const timeline = useMemo(() => buildReviewTimeline(events), [events]);
  const chapters = useMemo(() => reviewChapters(timeline), [timeline]);
  const marks = useMemo(() => reviewMarks(timeline), [timeline]);
  const context = useMemo(() => ({ duration: timeline.duration, reflectionTimes: timeline.reflectionTimes, rates: audioUrl ? AUDIO_RATES : PLAYBACK_RATES }), [timeline, audioUrl]);
  const [state, dispatch] = useReducer((s: ReturnType<typeof initialPlayback>, e: PlaybackEvent) => playbackReducer(s, e, context), timeline.duration, (duration) => initialPlayback(duration, audioUrl ? AUDIO_RATE : undefined));
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
  // REVIEW_HOTKEYS は定数で、hook を呼ぶ数と順序は変わらない。< > は時刻を動かさないので operate を通さない
  for (const [hotkey, action] of REVIEW_HOTKEYS) {
    useHotkey(hotkey, (e) => {
      const key = reviewKeyEvent(action, { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, state.time, timeline.duration);
      if (key === null) return;
      if (key.movesTime) operate(key.event);
      else dispatch(key.event);
    });
  }
  // M（ミュート）は音声つきだけ。hook を呼ぶ数と順序を変えないよう、常に登録して音声なしでは enabled で切る。時刻を動かさないので operate を通さない
  for (const [hotkey, action] of AUDIO_HOTKEYS) {
    useHotkey(
      hotkey,
      (e) => {
        const key = reviewKeyEvent(action, { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, state.time, timeline.duration);
        if (key !== null) dispatch(key.event);
      },
      { enabled: !!audioUrl },
    );
  }
  // 速さ・ミュート・音量を <audio> に書く。声の高さは変えない。defaultPlaybackRate も書いて、読み込み直しで 1 倍に戻らないようにする
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.preservesPitch = true;
    el.defaultPlaybackRate = state.rate;
    el.playbackRate = state.rate;
    el.muted = state.muted;
    el.volume = state.volume;
  }, [audioUrl, state.rate, state.muted, state.volume]);
  const snapshot = snapshotAt(timeline, state.time);
  const frame = (session: ReactNode, overlay: ReviewOverlay) => (
    <div className="review">
      <div className="review__session">{session}</div>
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
        captionsHidden={overlay.captionsHidden}
        sideHidden={overlay.sideHidden}
        onCaptions={overlay.onCaptions}
        onSide={overlay.onSide}
        audio={audioUrl ? { muted: state.muted, volume: state.volume, onMute: () => dispatch({ type: "toggleMute" }), onVolume: (volume) => dispatch({ type: "setVolume", volume }) } : undefined}
      />
      {audioUrl && <audio ref={audio} src={audioUrl} preload="auto" onEnded={() => dispatch({ type: "ended" })} />}
    </div>
  );
  return <SessionView snapshot={snapshot} speaking={speakingAt(timeline, state.time)} review={{ timeMoves, frame, audio: !!audioUrl }} />;
}
