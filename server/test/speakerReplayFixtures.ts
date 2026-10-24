import { Effect } from "effect";
import type { SettledRemark, SpeakerLogEvent, WordTime } from "../src/core/index.ts";
import { createRemarkSettling } from "../src/remarkSettling.ts";

export type Line = Record<string, unknown>;

export const numbered = (lines: readonly Line[]): Array<{ no: number; value: unknown }> => lines.map((value, index) => ({ no: index + 1, value }));

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();

export const logText = (lines: readonly Line[]): string => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

type Part = readonly [text: string, start: number, end: number];
const wordTimesOf = (parts: readonly Part[]): WordTime[] => {
  let location = 0;
  return parts.map(([text, start, end]) => {
    const word = { location, length: text.length, start, end };
    location += text.length;
    return word;
  });
};

export const startLine = (sec: number): Line => ({ at: iso(sec), type: "start", title: "fixture" });
export const segLine = (sec: number, slot: number, start: number, end: number): Line => ({ at: iso(sec), type: "speaker", track: "相手", start, end, slot, final: true });
export const settledLine = (sec: number, to: number): Line => ({ at: iso(sec), type: "speaker-settled", track: "相手", to });
const centroidLine = (sec: number, slot: number, centroid: readonly number[]): Line => ({ at: iso(sec), type: "speaker-centroid", track: "相手", slot, centroid });

export const remarkLine = (sec: number, id: string, track: "自分" | "相手", start: number, end: number, text: string, { parts }: { parts?: readonly Part[] } = {}): Line => ({
  at: iso(sec),
  type: "remark",
  remark: { id, track, start, end, text },
  raw: text,
  ...(parts === undefined ? {} : { wordTimes: wordTimesOf(parts) }),
});

export const overlapLog: Line[] = [
  segLine(1, 0, 0, 1), segLine(1, 1, 2, 3), segLine(1, 1, 10, 10.8), segLine(1, 0, 10.5, 14), settledLine(2, 14),
  remarkLine(3, "r1", "相手", 0, 1, "あ"), remarkLine(4, "r2", "相手", 2, 3, "い"), remarkLine(5, "r3", "相手", 10, 14, "うえお"),
];

export const fillLog: Line[] = [
  segLine(1, 0, 0, 2), segLine(1, 1, 3, 4), settledLine(2, 4),
  remarkLine(3, "r1", "相手", 0, 4, "こんにちは、えーとありがとう", { parts: [["こんにちは、", 0, 2], ["えーと", 2, 3], ["ありがとう", 3, 4]] }),
];

export const minRunLog: Line[] = [
  segLine(1, 0, 0, 2.5), segLine(1, 1, 2.5, 2.75), segLine(1, 0, 2.75, 6), settledLine(2, 6),
  remarkLine(3, "r1", "相手", 0, 6, "あああいいううう", { parts: [["あああ", 0, 2.5], ["いい", 2.5, 2.75], ["ううう", 2.75, 6]] }),
];

export const waitLog: Line[] = [
  remarkLine(1, "r1", "相手", 0, 2, "あいう"),
  segLine(2, 0, 0, 2), settledLine(3, 2),
];

export const restartLog: Line[] = [
  startLine(0),
  centroidLine(1, 0, [1, 0]), centroidLine(1, 1, [0, 1]),
  segLine(2, 0, 0, 2), segLine(2, 1, 3, 5), settledLine(2, 5),
  remarkLine(3, "r1", "相手", 0, 2, "ああ"), remarkLine(3, "r2", "相手", 3, 5, "いい"),
  segLine(12, 2, 20, 22), settledLine(12, 22),
  remarkLine(13, "r3", "相手", 20, 22, "うう"),
  centroidLine(14, 2, [0.99, 0.1]),
  segLine(15, 2, 30, 32), settledLine(15, 32),
  remarkLine(16, "r4", "相手", 30, 32, "ええ"),
  segLine(17, 3, 40, 42), centroidLine(17, 3, [-1, 0]), settledLine(17, 42),
  remarkLine(18, "r5", "相手", 40, 42, "おお"),
];

export const offlineLog: Line[] = [
  { arrival: 5.0, type: "speaker-settled", track: "相手", to: 4 },
  { arrival: 4.5, type: "remark", track: "相手", start: 0, end: 4, text: "こんにちは、ありがとう", duplicate: false, wordTimes: wordTimesOf([["こんにちは、", 0, 2], ["ありがとう", 2, 4]]) },
  { arrival: 8.0, type: "partial", track: "相手", start: 10, end: 11, text: "あい", duplicate: false },
  { arrival: 3.1, type: "speaker", track: "相手", start: 2, end: 4, slot: 1, final: true },
  { arrival: 0, type: "origin", hostTime: "123456" },
  { arrival: 3.0, type: "speaker", track: "相手", start: 0, end: 2, slot: 0, final: true },
  { arrival: 0.5, type: "not-a-known-event", note: "future" },
];

export const offlineRestartLog: Line[] = [
  { arrival: 0, type: "speaker-centroid", track: "相手", slot: 0, centroid: [1, 0] },
  { arrival: 0, type: "speaker-centroid", track: "相手", slot: 1, centroid: [0, 1] },
  { arrival: 2, type: "speaker", track: "相手", start: 0, end: 2, slot: 0, final: true },
  { arrival: 2, type: "speaker", track: "相手", start: 3, end: 5, slot: 1, final: true },
  { arrival: 2, type: "speaker-settled", track: "相手", to: 5 },
  { arrival: 3, type: "remark", track: "相手", start: 0, end: 2, text: "ああ", duplicate: false },
  { arrival: 3, type: "remark", track: "相手", start: 3, end: 5, text: "いい", duplicate: false },
  { arrival: 12, type: "speaker", track: "相手", start: 20, end: 22, slot: 2, final: true },
  { arrival: 12, type: "speaker-settled", track: "相手", to: 22 },
  { arrival: 13, type: "remark", track: "相手", start: 20, end: 22, text: "うう", duplicate: false },
  { arrival: 14, type: "speaker-centroid", track: "相手", slot: 2, centroid: [0.99, 0.1] },
  { arrival: 15, type: "speaker", track: "相手", start: 30, end: 32, slot: 2, final: true },
  { arrival: 15, type: "speaker-settled", track: "相手", to: 32 },
  { arrival: 16, type: "remark", track: "相手", start: 30, end: 32, text: "ええ", duplicate: false },
];

export const offlineMixedRestartLog: Line[] = [
  { arrival: 2, type: "origin", hostTime: "123456" },
  { arrival: 3, type: "speaker-centroid", track: "相手", slot: 0, centroid: [1, 0] },
  { arrival: 3, type: "speaker-centroid", track: "相手", slot: 1, centroid: [0, 1] },
  { arrival: 3.5, type: "speaker", track: "相手", slot: 1, start: 0, end: 4, final: false },
  { arrival: 4, type: "speaker", track: "相手", slot: 0, start: 0, end: 4, final: true },
  { arrival: 4, type: "speaker", track: "相手", slot: 1, start: 4, end: 6, final: true },
  { arrival: 4, type: "speaker-settled", track: "相手", to: 6 },
  { arrival: 5, type: "remark", track: "相手", start: 0, end: 4, text: "EVENTSSECRETALPHA", duplicate: false },
  { arrival: 5, type: "remark", track: "相手", start: 4, end: 6, text: "EVENTSSECRETBETA", duplicate: false },
  { arrival: 7, type: "speaker", track: "相手", slot: 1, start: 6, end: 7, final: true },
  { arrival: 8, type: "speaker-mixed", track: "相手", slot: 1, start: 7 },
  { arrival: 14, type: "speaker", track: "相手", slot: 0, start: 20, end: 22, final: true },
  { arrival: 14, type: "speaker", track: "相手", slot: 1, start: 22, end: 24, final: true },
  { arrival: 14, type: "speaker", track: "相手", slot: 2, start: 24, end: 26, final: true },
  { arrival: 14, type: "speaker", track: "相手", slot: 3, start: 26, end: 28, final: true },
  { arrival: 15, type: "speaker-centroid", track: "相手", slot: 0, centroid: [1, 0] },
  { arrival: 15, type: "speaker-centroid", track: "相手", slot: 1, centroid: [0, 1] },
  { arrival: 15, type: "speaker-centroid", track: "相手", slot: 2, centroid: [-1, 0] },
  { arrival: 16, type: "speaker-settled", track: "相手", to: 28 },
  { arrival: 17, type: "remark", track: "相手", start: 20, end: 22, text: "EVENTSSECRETGAMMA", duplicate: false },
];

export const textsOf = (lines: readonly Line[]): string[] =>
  lines.flatMap((line) => {
    const remark = line.remark as { text?: string } | undefined;
    return remark?.text === undefined ? [] : [remark.text];
  });

type LiveStep =
  | { speaker: SpeakerLogEvent }
  | { final: SettledRemark }
  | { restart: true };

const seg = (slot: number, start: number, end: number): LiveStep => ({ speaker: { type: "speaker", track: "相手", start, end, slot, final: true } });
const settled = (to: number): LiveStep => ({ speaker: { type: "speaker-settled", track: "相手", to } });
const centroid = (slot: number, c: readonly number[]): LiveStep => ({ speaker: { type: "speaker-centroid", track: "相手", slot, centroid: c } });
const said = (track: "自分" | "相手", start: number, end: number, text: string, parts?: readonly Part[]): LiveStep => ({
  final: { track, start, end, text, ...(parts === undefined ? {} : { wordTimes: wordTimesOf(parts) }) },
});

const LIVE_STEPS: LiveStep[] = [
  centroid(0, [1, 0]), centroid(1, [0, 1]),
  seg(0, 0, 2), seg(1, 2, 4), settled(4),
  said("相手", 0, 4, "こんにちは、ありがとう", [["こんにちは、", 0, 2], ["ありがとう", 2, 4]]),
  said("相手", 10, 12, "あいう"),
  said("自分", 20, 21, "はい"),
  seg(0, 10, 12), settled(12),
  seg(1, 40, 42), settled(42), { speaker: { type: "speaker-mixed", track: "相手", slot: 1, start: 42 } },
  said("相手", 40, 42, "えおか"),
  { restart: true },
  seg(2, 50, 52), settled(52),
  said("相手", 50, 52, "きく"),
  centroid(2, [0.99, 0.1]),
  seg(2, 60, 62), settled(62),
  said("相手", 60, 62, "けこ"),
];

type LiveLog = { lines: Line[]; liveSpeakers: Array<[id: string, speaker: string | undefined]> };

export const liveLog = Effect.gen(function* () {
  const lines: Line[] = [];
  const liveSpeakers: LiveLog["liveSpeakers"] = [];
  let n = 0;
  const next = () => iso(n++);
  const settling = yield* createRemarkSettling({
    emit: (r) => Effect.sync(() => {
      const id = `r${liveSpeakers.length + 1}`;
      liveSpeakers.push([id, r.speaker]);
      const { wordTimes, speaker, ...rest } = r;
      lines.push({
        at: next(),
        type: "remark",
        remark: { id, ...rest, ...(speaker === undefined ? {} : { speaker }) },
        raw: r.text,
        ...(wordTimes === undefined ? {} : { wordTimes }),
      });
    }),
  });
  for (const step of LIVE_STEPS) {
    if ("speaker" in step) {
      lines.push({ at: next(), ...step.speaker });
      yield* settling.speaker(step.speaker);
    } else if ("final" in step) {
      yield* settling.final(step.final);
    } else {
      yield* settling.renumbered;
      lines.push({ at: next(), type: "intake-restarted", trigger: "auto" });
    }
  }
  yield* settling.drain;
  return { lines, liveSpeakers } satisfies LiveLog;
});
