import { Schema } from "effect";

export const PLAYBACK_RATE = 30;

export const PLAYBACK_RATES: readonly number[] = [10, 30, 60, 120];

export const AUDIO_RATE = 1;
export const AUDIO_RATES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export const PlaybackState = Schema.Struct({ time: Schema.Finite, playing: Schema.Boolean, rate: Schema.Finite, muted: Schema.Boolean, volume: Schema.Finite });
export type PlaybackState = typeof PlaybackState.Type;

export type PlaybackEvent =
  | { type: "toggle" }
  | { type: "seek"; time: number }
  | { type: "prev" }
  | { type: "next" }
  | { type: "setRate"; rate: number }
  | { type: "slower" }
  | { type: "faster" }
  | { type: "toggleMute" }
  | { type: "setVolume"; volume: number }
  | { type: "elapsed"; seconds: number }
  | { type: "audioTime"; time: number }
  | { type: "ended" };

export type PlaybackContext = { duration: number; reflectionTimes: readonly number[]; rates: readonly number[] };

export function initialPlayback(duration: number, rate: number = PLAYBACK_RATE): PlaybackState {
  return { time: duration, playing: false, rate, muted: false, volume: 1 };
}

const clamp = (time: number, duration: number) => Math.min(Math.max(time, 0), duration);

function togglePlay(state: PlaybackState, duration: number): PlaybackState {
  if (state.playing) return { ...state, playing: false };
  return { ...state, time: state.time >= duration ? 0 : state.time, playing: true };
}

function stepReflection(state: PlaybackState, reflectionTimes: readonly number[], dir: "prev" | "next"): PlaybackState {
  const target = dir === "prev" ? reflectionTimes.filter((x) => x < state.time).at(-1) : reflectionTimes.find((x) => x > state.time);
  return target === undefined ? state : { ...state, time: target };
}

function stepRate(state: PlaybackState, rates: readonly number[], dir: "slower" | "faster"): PlaybackState {
  const index = rates.indexOf(state.rate);
  const target = index < 0 ? undefined : rates[index + (dir === "faster" ? 1 : -1)];
  return target === undefined ? state : { ...state, rate: target };
}

function stoppedAtEnd(state: PlaybackState, duration: number): PlaybackState {
  return { ...state, time: duration, playing: false };
}

function advanceTo(state: PlaybackState, time: number, duration: number): PlaybackState {
  return time >= duration ? stoppedAtEnd(state, duration) : { ...state, time };
}

export function playbackReducer(state: PlaybackState, event: PlaybackEvent, { duration, reflectionTimes, rates }: PlaybackContext): PlaybackState {
  switch (event.type) {
    case "toggle":
      return togglePlay(state, duration);
    case "seek":
      return { ...state, time: clamp(event.time, duration) };
    case "prev":
    case "next":
      return stepReflection(state, reflectionTimes, event.type);
    case "setRate":
      return rates.includes(event.rate) ? { ...state, rate: event.rate } : state;
    case "slower":
    case "faster":
      return stepRate(state, rates, event.type);
    case "toggleMute":
      return { ...state, muted: !state.muted };
    case "setVolume":
      return { ...state, muted: false, volume: Math.min(Math.max(event.volume, 0), 1) };
    case "elapsed":
      return state.playing ? advanceTo(state, state.time + event.seconds * state.rate, duration) : state;
    case "audioTime":
      if (!state.playing) return state;
      return event.time >= duration ? stoppedAtEnd(state, duration) : { ...state, time: Math.max(event.time, 0) };
    case "ended":
      return stoppedAtEnd(state, duration);
  }
}

export const rateOptionLabel = (rate: number, duration: number) => `${rate} 倍（${Math.round(duration / 60)} 分を ${(Math.round((duration / rate / 60) * 10) / 10).toFixed(1)} 分で）`;

export const rateItemLabel = (rate: number, duration: number, timesOnly: boolean) => (timesOnly ? `${rate} 倍` : rateOptionLabel(rate, duration));
