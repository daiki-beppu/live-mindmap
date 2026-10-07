import { useEffect, useRef } from "react";

// 音声つきの見返しでは、時刻の元はこの hook ごと <audio> の currentTime に差し替える。
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
