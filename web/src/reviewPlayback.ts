// 見返しの再生の状態（純粋な reducer）。時刻の元（rAF や音声の currentTime）は知らず、経過の秒（elapsed）か、音声の時刻の通知（audioTime）だけを受け取る。

// 画面の経過 1 秒あたりに進む会議の秒数
// 音声なしの既定の速さ
export const PLAYBACK_RATE = 30;

// 音声なしで選べる速さの並び（昇順）。版ごとに別の並びを PlaybackContext.rates で渡せる
export const PLAYBACK_RATES: readonly number[] = [10, 30, 60, 120];

export type PlaybackState = { time: number; playing: boolean; rate: number };

export type PlaybackEvent =
  | { type: "toggle" }
  | { type: "seek"; time: number }
  | { type: "prev" }
  | { type: "next" }
  | { type: "setRate"; rate: number }
  | { type: "slower" }
  | { type: "faster" }
  | { type: "elapsed"; seconds: number }
  | { type: "audioTime"; time: number } // 音声つき: <audio> の今の currentTime（秒）。音声つきでは時刻はこの通知だけで決まる
  | { type: "ended" };

export type PlaybackContext = { duration: number; reflectionTimes: readonly number[]; rates: readonly number[] };

export function initialPlayback(duration: number, rate: number = PLAYBACK_RATE): PlaybackState {
  return { time: duration, playing: false, rate };
}

const clamp = (time: number, duration: number) => Math.min(Math.max(time, 0), duration);

export function playbackReducer(state: PlaybackState, event: PlaybackEvent, { duration, reflectionTimes, rates }: PlaybackContext): PlaybackState {
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
    case "setRate":
      return rates.includes(event.rate) ? { ...state, rate: event.rate } : state;
    case "slower":
    case "faster": {
      const index = rates.indexOf(state.rate);
      const target = index < 0 ? undefined : rates[index + (event.type === "faster" ? 1 : -1)];
      return target === undefined ? state : { ...state, rate: target };
    }
    case "elapsed": {
      if (!state.playing) return state;
      const time = state.time + event.seconds * state.rate;
      return time >= duration ? { ...state, time: duration, playing: false } : { ...state, time };
    }
    case "audioTime": {
      // 止めている間は無視する（止めた直後に届いた通知で、止めた時刻やシーク先から戻らないように）。録音が会議より長くても、会議の長さで止める
      if (!state.playing) return state;
      return event.time >= duration ? { ...state, time: duration, playing: false } : { ...state, time: Math.max(event.time, 0) };
    }
    case "ended":
      return { ...state, time: duration, playing: false };
  }
}
