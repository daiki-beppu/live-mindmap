import type { Remark, SpeakingFrame, Track } from "../../src/core/index.ts";

export const remark = (n: number, track: Track, text: string, extra: Partial<Remark> = {}): Remark => ({ id: `r${n}`, track, start: n * 10, end: n * 10 + 9, text, ...extra });

export const textsOf = (frames: SpeakingFrame[], track: Track) => frames.filter((f) => f.track === track).map((f) => f.text);
