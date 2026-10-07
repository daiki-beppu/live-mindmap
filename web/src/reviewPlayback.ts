// 見返しの再生の状態（純粋な reducer）。時刻の元（rAF や音声の currentTime）は知らず、経過の秒（elapsed）か、音声の時刻の通知（audioTime）だけを受け取る。

// 画面の経過 1 秒あたりに進む会議の秒数
// 音声なしの既定の速さ
export const PLAYBACK_RATE = 30;

// 音声なしで選べる速さの並び（昇順）。版ごとに別の並びを PlaybackContext.rates で渡せる
export const PLAYBACK_RATES: readonly number[] = [10, 30, 60, 120];

// 音声つきの最初の速さ（1 倍）と、選べる速さの並び（昇順。声の高さは変えない）
export const AUDIO_RATE = 1;
export const AUDIO_RATES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// muted と volume は音声つきだけが使う。ミュートは volume を 0 にせず別に持つので、戻すとミュート前の音量に戻る
export type PlaybackState = { time: number; playing: boolean; rate: number; muted: boolean; volume: number };

export type PlaybackEvent =
  | { type: "toggle" }
  | { type: "seek"; time: number }
  | { type: "prev" }
  | { type: "next" }
  | { type: "setRate"; rate: number }
  | { type: "slower" }
  | { type: "faster" }
  | { type: "toggleMute" }
  | { type: "setVolume"; volume: number } // 0〜1 に収める。ミュート中なら外す
  | { type: "elapsed"; seconds: number }
  | { type: "audioTime"; time: number } // 音声つき: <audio> の今の currentTime（秒）。音声つきでは時刻はこの通知だけで決まる
  | { type: "ended" };

export type PlaybackContext = { duration: number; reflectionTimes: readonly number[]; rates: readonly number[] };

export function initialPlayback(duration: number, rate: number = PLAYBACK_RATE): PlaybackState {
  return { time: duration, playing: false, rate, muted: false, volume: 1 };
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
    case "toggleMute":
      return { ...state, muted: !state.muted };
    case "setVolume":
      return { ...state, muted: false, volume: Math.min(Math.max(event.volume, 0), 1) };
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
