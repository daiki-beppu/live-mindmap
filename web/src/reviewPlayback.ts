// 見返しの再生の状態（純粋な reducer）。時刻の元（rAF や音声の currentTime）は知らず、経過の秒だけを受け取る。

// 画面の経過 1 秒あたりに進む会議の秒数
export const PLAYBACK_RATE = 30;

export type PlaybackState = { time: number; playing: boolean; rate: number };

export type PlaybackEvent =
  | { type: "toggle" }
  | { type: "seek"; time: number }
  | { type: "prev" }
  | { type: "next" }
  | { type: "elapsed"; seconds: number }
  | { type: "ended" };

export type PlaybackContext = { duration: number; reflectionTimes: readonly number[] };

export function initialPlayback(duration: number): PlaybackState {
  return { time: duration, playing: false, rate: PLAYBACK_RATE };
}

const clamp = (time: number, duration: number) => Math.min(Math.max(time, 0), duration);

export function playbackReducer(state: PlaybackState, event: PlaybackEvent, { duration, reflectionTimes }: PlaybackContext): PlaybackState {
  switch (event.type) {
    case "toggle":
      if (state.playing) return { ...state, playing: false };
      return { ...state, time: state.time >= duration ? 0 : state.time, playing: true };
    case "seek":
      return { ...state, time: clamp(event.time, duration) };
    case "prev": {
      const target = reflectionTimes.filter((x) => x < state.time).at(-1);
      return target === undefined ? state : { ...state, time: target };
    }
    case "next": {
      const target = reflectionTimes.find((x) => x > state.time);
      return target === undefined ? state : { ...state, time: target };
    }
    case "elapsed": {
      if (!state.playing) return state;
      const time = state.time + event.seconds * state.rate;
      return time >= duration ? { ...state, time: duration, playing: false } : { ...state, time };
    }
    case "ended":
      return { ...state, time: duration, playing: false };
  }
}
