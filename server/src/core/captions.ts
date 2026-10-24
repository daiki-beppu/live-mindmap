import { Schema } from "effect";
import type { HelperPartial } from "./live.ts";
import { placeCorrectionForCaptions, type CaptionCorrection, type Replacement } from "./correction.ts";
import { Track } from "./remark.ts";
import type { SettledRemark } from "./settle.ts";
import { longestOverlap, type Segment } from "./speakers.ts";

export const CaptionLabel = Schema.Literals(["仮", "確定", "なし"]);
export type CaptionLabel = typeof CaptionLabel["Type"];

export const CaptionBubble = Schema.Struct({
  id: Schema.String,
  track: Track,
  speaker: Schema.optionalKey(Schema.String),
  label: CaptionLabel,
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
  settledLength: Schema.Int,
  splitFrom: Schema.optionalKey(Schema.String),
});
export type CaptionBubble = typeof CaptionBubble["Type"];

export const CaptionsFrame = Schema.Struct({ type: Schema.Literal("captions"), bubbles: Schema.Array(CaptionBubble) });
export type CaptionsFrame = typeof CaptionsFrame["Type"];

export type CaptionBoardInput = {
  readonly partials: readonly HelperPartial[];
  readonly unreflected: readonly { readonly id: string; readonly remark: SettledRemark; readonly replacements?: readonly Replacement[] }[];
  readonly held: readonly SettledRemark[];
  readonly intervals: readonly Segment[];
  readonly previewLabel: (slot: number) => string | undefined;
};

type Unit = { source: number; start: number; end: number; text: string; speaker: string | undefined; label: CaptionLabel; settled: boolean };
type Boundary = { id: string; start: number; last: number; open: boolean; splitFrom?: string };
const START_TOLERANCE_S = 0.5;
const HELD_OVERLAP_S = 0.05;

export const CAPTION_CONTINUE_GAP_S = 0.3;
export const continuesAfter = (previousEnd: number, start: number): boolean => Math.round((start - previousEnd) * 1000) < CAPTION_CONTINUE_GAP_S * 1000;

const ownerOf = (previous: readonly Boundary[], start: number): Boundary | undefined =>
  [...previous].reverse().find((b) => b.start <= start && start <= b.last) ?? previous.find((b) => b.start - START_TOLERANCE_S <= start && start < b.start);

const joinUnits = (us: readonly Unit[]): { text: string; settledLength: number } => {
  let raw = "";
  let settledEnd = 0;
  let contiguous = true;
  for (const u of us) {
    raw += (needsSpace(raw, u.text) ? " " : "") + u.text;
    contiguous = contiguous && u.settled;
    if (contiguous) settledEnd = raw.length;
  }
  const text = raw.trim();
  const dropped = raw.length - raw.trimStart().length;
  return { text, settledLength: Math.min(text.length, Math.max(0, settledEnd - dropped)) };
};

const TRACKS: readonly Track[] = ["相手", "自分"];
const needsSpace = (left: string, right: string) => /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);

const wordUnits = (
  text: string,
  start: number,
  end: number,
  wordTimes: readonly { readonly location: number; readonly start: number; readonly end: number }[] | undefined,
  unit: (start: number, end: number, text: string) => Unit,
): Unit[] => {
  const times = wordTimes === undefined || wordTimes.length === 0 ? undefined : [...wordTimes].sort((a, b) => a.location - b.location);
  if (times === undefined) return [unit(start, end, text)];
  return times.map((w, i) => unit(w.start, w.end, text.slice(i === 0 ? 0 : w.location, times[i + 1]?.location ?? text.length)));
};

const partialUnits = (p: HelperPartial, source: number, intervals: readonly Segment[], previewLabel: (slot: number) => string | undefined): Unit[] =>
  wordUnits(p.text, p.start, p.end, p.wordTimes, (start, end, text) => {
    if (p.track === "自分") return { source, start, end, text, speaker: "自分", label: "確定", settled: false };
    const slot = longestOverlap(start, end, intervals);
    const speaker = slot === undefined ? undefined : previewLabel(slot);
    return { source, start, end, text, speaker, label: speaker === undefined ? "なし" : "仮", settled: false };
  });

const remarkUnits = (r: SettledRemark, source: number, intervals: readonly Segment[], previewLabel: (slot: number) => string | undefined, settled: boolean): Unit[] =>
  wordUnits(r.text, r.start, r.end, r.wordTimes, (start, end, text) => {
    const base = { source, start, end, text, settled: true };
    if (r.track === "自分") return { ...base, speaker: "自分", label: "確定" };
    if (settled) return { ...base, speaker: r.speaker, label: r.speaker === undefined ? "なし" : "確定" };
    const slot = longestOverlap(start, end, intervals);
    const speaker = slot === undefined ? undefined : previewLabel(slot);
    return { ...base, speaker, label: speaker === undefined ? "なし" : "仮" };
  });

type Draft = { serial: number; corrections: Map<string, CaptionCorrection>; boundariesOf: Map<Track, Boundary[]> };

export function createCaptionBoard() {
  const boundariesOf = new Map<Track, Boundary[]>();
  let corrections = new Map<string, CaptionCorrection>();
  let serial = 0;

  const correctionOf = (draft: Draft, id: string, remark: SettledRemark, replacements: readonly Replacement[], previous: readonly Boundary[]): CaptionCorrection | undefined => {
    const made = draft.corrections.get(id);
    if (made !== undefined || remark.wordTimes === undefined) return made;
    const placed = placeCorrectionForCaptions(remark.text, remark.wordTimes, replacements, (w) => ownerOf(previous, w.start)?.id);
    draft.corrections.set(id, placed);
    return placed;
  };

  const unitsOf = (draft: Draft, track: Track, input: CaptionBoardInput, previous: readonly Boundary[]): Unit[] => {
    const out: Unit[] = [];
    let source = 0;
    for (const { id, remark, replacements } of input.unreflected) {
      if (remark.track !== track) continue;
      const placed = replacements === undefined ? undefined : correctionOf(draft, id, remark, replacements, previous);
      out.push(...remarkUnits(placed === undefined ? remark : { ...remark, text: placed.text, wordTimes: placed.wordTimes }, source++, input.intervals, input.previewLabel, true));
    }
    const held = input.held.filter((r) => r.track === track);
    for (const remark of held) out.push(...remarkUnits(remark, source++, input.intervals, input.previewLabel, false));
    const covered = (u: Unit) => held.some((r) => r.start - HELD_OVERLAP_S <= u.start && u.start <= r.end);
    for (const p of input.partials) if (p.track === track && !p.duplicate) out.push(...partialUnits(p, source++, input.intervals, input.previewLabel).filter((u) => !covered(u)));
    return out.filter((u) => u.text !== "").sort((a, b) => a.start - b.start);
  };

  const trackBubbles = (draft: Draft, track: Track, input: CaptionBoardInput): CaptionBubble[] => {
    const previous = boundariesOf.get(track) ?? [];
    const units = unitsOf(draft, track, input, previous);
    const groups = new Map<Boundary, Unit[]>();
    const boundaries: Boundary[] = [];
    const splits = new Map<Boundary, Boundary>();
    const placeInOwner = (owner: Boundary, u: Unit): Boundary => {
      const target = splits.get(owner) ?? owner;
      const last = groups.get(target)?.at(-1);
      if (!owner.open || last === undefined || last.speaker === u.speaker) return target;
      const split: Boundary = { id: `caption-${track}-${draft.serial++}`, start: u.start, last: u.start, open: true, splitFrom: owner.id };
      splits.set(owner, split);
      return split;
    };
    let current: Boundary | undefined;
    let before: Unit | undefined;
    for (const u of units) {
      const owner = ownerOf(previous, u.start);
      if (owner !== undefined) {
        current = placeInOwner(owner, u);
      } else if (current === undefined || before === undefined || before.source !== u.source || before.speaker !== u.speaker || (u.speaker === undefined && !continuesAfter(before.end, u.start))) {
        current = { id: `caption-${track}-${draft.serial++}`, start: u.start, last: u.start, open: true };
      }
      if (!boundaries.includes(current)) boundaries.push(current);
      groups.set(current, [...(groups.get(current) ?? []), u]);
      before = u;
    }
    draft.boundariesOf.set(track, boundaries.map((b) => ({ ...b, last: Math.max(...groups.get(b)!.map((u) => u.start)), open: b.open && groups.get(b)!.every((u) => u.speaker === undefined) })));
    return [...groups].map(([b, us]): CaptionBubble => {
      const named = us.find((u) => u.speaker !== undefined);
      const { text, settledLength } = joinUnits(us);
      return {
        id: b.id,
        track,
        ...(named?.speaker === undefined ? {} : { speaker: named.speaker }),
        label: named?.label ?? "なし",
        start: us[0]!.start,
        end: us.at(-1)!.end,
        text,
        settledLength,
        ...(b.splitFrom === undefined ? {} : { splitFrom: b.splitFrom }),
      };
    });
  };

  const compute = (input: CaptionBoardInput): { bubbles: CaptionBubble[]; draft: Draft } => {
    const draft: Draft = { serial, corrections: new Map(corrections), boundariesOf: new Map() };
    const bubbles = TRACKS.flatMap((track) => trackBubbles(draft, track, input)).sort((a, b) => a.start - b.start);
    const unreflected = new Set(input.unreflected.map(({ id }) => id));
    for (const id of draft.corrections.keys()) if (!unreflected.has(id)) draft.corrections.delete(id);
    return { bubbles, draft };
  };

  return {
    build(input: CaptionBoardInput): CaptionBubble[] {
      const { bubbles, draft } = compute(input);
      serial = draft.serial;
      corrections = draft.corrections;
      for (const [track, boundaries] of draft.boundariesOf) boundariesOf.set(track, boundaries);
      return bubbles;
    },
    preview(input: CaptionBoardInput): CaptionBubble[] {
      return compute(input).bubbles;
    },
    reset(): void {
      boundariesOf.clear();
      corrections = new Map();
    },
  };
}
