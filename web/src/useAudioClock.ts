import { useEffect, useRef, type RefObject } from "react";

// 音声つきの見返しの時刻の元。進めている間は、<audio> を鳴らし、currentTime を通知する。
// 表示を滑らかにするため requestAnimationFrame ごとに通知する（timeupdate は間隔が粗い）。
// 背景タブでは rAF が呼ばれず、会議の長さに達した判断が届かないため、timeupdate でも同じ currentTime を通知する。
// 止めると pause する。シーク等で currentTime を書くのは呼び出し側。
// play() が拒否されたとき、pause による中断（AbortError）は想定内。それ以外は onPlayFailed で画面を止めた状態に戻す
export function useAudioClock(
  audio: RefObject<HTMLAudioElement | null>,
  playing: boolean,
  onTime: (seconds: number) => void,
  onPlayFailed: () => void,
) {
  const latest = useRef({ onTime, onPlayFailed });
  latest.current = { onTime, onPlayFailed };
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    if (!playing) {
      element.pause();
      return;
    }
    let cancelled = false;
    element.play().catch((error: unknown) => {
      if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
      latest.current.onPlayFailed();
    });
    const notify = () => latest.current.onTime(element.currentTime);
    element.addEventListener("timeupdate", notify);
    let frame = requestAnimationFrame(function tick() {
      notify();
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      element.removeEventListener("timeupdate", notify);
    };
  }, [audio, playing]);
}
