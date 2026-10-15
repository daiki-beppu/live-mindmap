import type { CaptionBubble, CaptionsFrame, HelperPartial, Remark, SettledRemark, Track, WordTime } from "../../src/core/index.ts";

export const remark = (n: number, track: Track, text: string, extra: Partial<Remark> = {}): Remark => ({ id: `r${n}`, track, start: n * 10, end: n * 10 + 9, text, ...extra });

// 1 語だけの途中結果。語の区間は本文全体
export const partialOf = (track: Track, text: string, start = 10, extra: Partial<HelperPartial> = {}): HelperPartial => {
  const wordTimes: WordTime[] = [{ location: 0, length: text.length, start, end: start + 1 }];
  return { track, start, end: start + 1, text, duplicate: false, wordTimes, ...extra };
};

// 出た発言（id つき）。remark(n, …) と同じ時刻で、語の区間は本文全体
export const spoken = (n: number, track: Track, text: string, speaker?: string): { id: string; remark: SettledRemark } => ({
  id: `r${n}`,
  remark: { track, start: n * 10, end: n * 10 + 9, text, wordTimes: [{ location: 0, length: text.length, start: n * 10, end: n * 10 + 9 }], ...(speaker === undefined ? {} : { speaker }) },
});

export const bubbleTexts = (frame: CaptionsFrame | CaptionBubble[]): string[] => (Array.isArray(frame) ? frame : frame.bubbles).map((b) => b.text);
export const lastTexts = (frames: CaptionsFrame[]): string[] => bubbleTexts(frames.at(-1)!);
