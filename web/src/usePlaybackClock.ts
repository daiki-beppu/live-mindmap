import { useEffect, useRef } from "react";

// 音声なしの見返しの時刻の元。音声つきの見返しでは使わず、時刻の元は <audio> の currentTime（useAudioClock）になる。
export function usePlaybackClock(playing: boolean, onElapsed: (seconds: number) => void) {
  const latest = useRef(onElapsed);
  latest.current = onElapsed;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      latest.current((now - last) / 1000);
      last = now;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);
}
