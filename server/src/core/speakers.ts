import type { SpeakerLogEvent } from "./live.ts";
import type { SettledRemark } from "./remarkGate.ts";
import { cutWords, keepWordsBefore } from "./words.ts";

export const SPEAKER_WAIT_MS = 3000;
const MIN_RUN_SECONDS = 0.5;
const EPSILON = 1e-6;

export type Segment = { readonly start: number; readonly end: number; readonly slot: number };
export type SpeakerCut = { remark: SettledRemark; slot: number | undefined };

export type SpeakerRules = { readonly longestOverlap: boolean; readonly fillUnassigned: boolean; readonly minRun: boolean; readonly waitLimit: boolean };
const DEFAULT_RULES: SpeakerRules = Object.freeze({ longestOverlap: true, fillUnassigned: true, minRun: true, waitLimit: true });

type Unit = { location: number; start: number; end: number; slot: number | undefined };
type Run = { slot: number | undefined; first: number; last: number };

const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

export const longestOverlap = (start: number, end: number, segments: readonly Segment[]): number | undefined => {
  const totals = new Map<number, number>();
  for (const s of segments) {
    const o = overlap(start, end, s.start, s.end);
    if (o > EPSILON) totals.set(s.slot, (totals.get(s.slot) ?? 0) + o);
  }
  let best: number | undefined;
  let bestTotal = 0;
  for (const [slot, total] of totals) {
    if (total > bestTotal || (total === bestTotal && best !== undefined && slot < best)) {
      best = slot;
      bestTotal = total;
    }
  }
  return best;
};

const fillSlots = (units: Unit[]): void => {
  let previous: number | undefined;
  for (const u of units) {
    if (u.slot === undefined) u.slot = previous;
    else previous = u.slot;
  }
  let next: number | undefined;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    if (u.slot === undefined) u.slot = next;
    else next = u.slot;
  }
};

const toRuns = (units: readonly Unit[]): Run[] => {
  const runs: Run[] = [];
  units.forEach((u, i) => {
    const last = runs.at(-1);
    if (last !== undefined && last.slot === u.slot) last.last = i;
    else runs.push({ slot: u.slot, first: i, last: i });
  });
  return runs;
};

const earliestOverlap = (start: number, end: number, segments: readonly Segment[]): number | undefined => {
  let best: Segment | undefined;
  for (const s of segments) {
    if (overlap(start, end, s.start, s.end) <= EPSILON) continue;
    if (best === undefined || s.start < best.start || (s.start === best.start && s.slot < best.slot)) best = s;
  }
  return best?.slot;
};

const lengthOf = (s: Segment) => s.end - s.start;

const joinSameSlot = (sorted: readonly Segment[]): Segment[] => {
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last !== undefined && last.slot === s.slot && s.start <= last.end + EPSILON) out[out.length - 1] = { slot: s.slot, start: last.start, end: Math.max(last.end, s.end) };
    else out.push(s);
  }
  return out;
};

const longerNeighborSlot = (segments: readonly Segment[], at: number): number => {
  const previous = segments[at - 1];
  const next = segments[at + 1];
  if (previous === undefined) return next!.slot;
  if (next === undefined) return previous.slot;
  return lengthOf(next) > lengthOf(previous) ? next.slot : previous.slot;
};

const shortestShortSegment = (segments: readonly Segment[]): number => {
  let at = -1;
  if (segments.length < 2) return at;
  for (const [i, s] of segments.entries()) {
    const movable = lengthOf(s) < MIN_RUN_SECONDS - EPSILON && longerNeighborSlot(segments, i) !== s.slot;
    if (movable && (at < 0 || lengthOf(s) < lengthOf(segments[at]!))) at = i;
  }
  return at;
};

const foldShortSegments = (segments: readonly Segment[], start: number, end: number): Segment[] => {
  const near = segments.filter((s) => overlap(start, end, s.start, s.end) > EPSILON).sort((a, b) => a.start - b.start || a.end - b.end);
  let folded = joinSameSlot(near);
  for (;;) {
    const at = shortestShortSegment(folded);
    if (at < 0) return folded;
    const slot = longerNeighborSlot(folded, at);
    folded = joinSameSlot(folded.map((s, i) => (i === at ? { ...s, slot } : s)));
  }
};

type Piece = { slot: number | undefined; textStart: number; timeStart: number };

const piecesOf = (remark: SettledRemark, units: readonly Unit[], runs: readonly Run[]): Piece[] => {
  const pieces: Piece[] = [{ slot: runs[0]!.slot, textStart: 0, timeStart: remark.start }];
  for (const run of runs.slice(1)) {
    const previous = pieces.at(-1)!;
    const unit = units[run.first]!;
    const degenerate = unit.location <= previous.textStart || unit.start <= previous.timeStart || unit.start >= remark.end;
    if (run.slot === previous.slot || degenerate) continue;
    pieces.push({ slot: run.slot, textStart: unit.location, timeStart: unit.start });
  }
  return pieces;
};

const sliceRemark = (r: SettledRemark, from: number, to: number, start: number, end: number): SettledRemark => ({
  ...r,
  start,
  end,
  text: r.text.slice(from, to),
  ...(r.words === undefined ? {} : { words: cutWords(keepWordsBefore(r.words, to), from) }),
  ...(r.wordTimes === undefined ? {} : { wordTimes: cutWords(keepWordsBefore(r.wordTimes, to), from) }),
});

export function splitBySpeaker(remark: SettledRemark, segments: readonly Segment[], rules: SpeakerRules = DEFAULT_RULES): SpeakerCut[] {
  const folded = rules.minRun ? foldShortSegments(segments, remark.start, remark.end) : segments;
  const pick = rules.longestOverlap ? longestOverlap : earliestOverlap;
  const times = remark.wordTimes === undefined || remark.wordTimes.length === 0 ? undefined : [...remark.wordTimes].sort((a, b) => a.location - b.location);
  if (times === undefined) return [{ remark, slot: pick(remark.start, remark.end, folded) }];
  const units: Unit[] = times.map((w) => ({ location: w.location, start: w.start, end: w.end, slot: pick(w.start, w.end, folded) }));
  if (units.every((u) => u.slot === undefined)) return [{ remark, slot: undefined }];
  if (rules.fillUnassigned) fillSlots(units);
  const runs = toRuns(units);
  const pieces = piecesOf(remark, units, runs);
  if (pieces.length === 1) return [{ remark, slot: pieces[0]!.slot }];
  return pieces.map((p, i) => {
    const next = pieces[i + 1];
    return { remark: sliceRemark(remark, p.textStart, next?.textStart ?? remark.text.length, p.timeStart, next?.timeStart ?? remark.end), slot: p.slot };
  });
}

const letters = (n: number): string => (n < 26 ? "" : letters(Math.floor(n / 26) - 1)) + String.fromCharCode(65 + (n % 26));

export const LINK_MIN_SIMILARITY = 0.9;
export const NEW_LABEL_MAX_SIMILARITY = 0.6;

const norm = (v: readonly number[]) => Math.hypot(...v);

const cosine = (a: readonly number[], b: readonly number[]): number | undefined => {
  const denominator = norm(a) * norm(b);
  if (a.length !== b.length || !(denominator > 0)) return undefined;
  return a.reduce((sum, x, i) => sum + x * b[i]!, 0) / denominator;
};

export type SpeakerRecord =
  | { type: "mixed"; slot: number; label?: string }
  | { type: "link"; slot: number; result: "linked" | "new" | "reverted"; label?: string }
  | { type: "cut"; pieces: number }
  | { type: "timeout" };
export type SpeakerAttributionOptions = { rules?: SpeakerRules; observe?: (record: SpeakerRecord) => void };

type Held = { remark: SettledRemark; heldAt: number };
type SlotState = "linked" | "new";

// ヘルパーを起動し直すと Sortformer の枠は振り直される。
export function createSpeakerAttribution({ rules = DEFAULT_RULES, observe }: SpeakerAttributionOptions = {}) {
  let off = false;
  let clock = 0;
  const held: Held[] = [];

  let labelCount = 0;
  const labelCentroids = new Map<string, readonly number[]>();
  const revertedLabels = new Set<string>();
  let renumbered = false;

  let segments: Segment[] = [];
  // 確定区間の end からは判定しない（FluidAudio は確定区間を枠の番号順に、閉じたものだけ流すので、end の最大値は「揃った」を保証しない）
  let settledTo = Number.NEGATIVE_INFINITY;
  let slotLabels = new Map<number, string>();
  let slotStates = new Map<number, SlotState>();
  let slotCentroids = new Map<number, readonly number[]>();
  let revertedSlots = new Set<number>();
  let provisionalShown: Segment[] = [];
  let provisionalAwaitingSettled: Segment[] = [];
  let seenSlots: number[] = [];
  const see = (slot: number) => {
    if (!seenSlots.includes(slot)) seenSlots.push(slot);
  };

  const isPending = (slot: number) => renumbered && !revertedSlots.has(slot) && !slotStates.has(slot);

  const isUnlabeled = (slot: number) => {
    if (revertedSlots.has(slot) || isPending(slot)) return true;
    const label = slotLabels.get(slot);
    return label !== undefined && revertedLabels.has(label);
  };

  const assignLabel = (slot: number): string => {
    const label = `相手 ${letters(labelCount++)}`;
    slotLabels.set(slot, label);
    const centroid = slotCentroids.get(slot);
    if (centroid !== undefined) labelCentroids.set(label, centroid);
    return label;
  };

  const labelOf = (slot: number): string => slotLabels.get(slot) ?? assignLabel(slot);

  const match = (slot: number, centroid: readonly number[]): void => {
    const similar: string[] = [];
    let farFromAll = true;
    for (const [label, other] of labelCentroids) {
      const value = cosine(centroid, other);
      if (value === undefined) continue;
      if (value >= LINK_MIN_SIMILARITY) similar.push(label);
      if (value >= NEW_LABEL_MAX_SIMILARITY) farFromAll = false;
    }
    if (similar.length > 1) return;
    const linked = similar[0];
    if (linked !== undefined) {
      if (revertedLabels.has(linked)) {
        revertedSlots.add(slot);
        observe?.({ type: "link", slot, result: "reverted", label: linked });
      } else {
        slotLabels.set(slot, linked);
        slotStates.set(slot, "linked");
        observe?.({ type: "link", slot, result: "linked", label: linked });
      }
    } else if (farFromAll) {
      slotStates.set(slot, "new");
      observe?.({ type: "link", slot, result: "new" });
    }
  };

  const onCentroid = (slot: number, centroid: readonly number[]): void => {
    if (!(norm(centroid) > 0)) return;
    slotCentroids.set(slot, centroid);
    if (revertedSlots.has(slot)) return;
    if (isPending(slot)) match(slot, centroid);
    const label = slotLabels.get(slot);
    if (label !== undefined && slotStates.get(slot) !== "linked") labelCentroids.set(label, centroid);
  };

  const isSettled = (r: SettledRemark) => settledTo >= r.end - EPSILON;

  const attribute = (r: SettledRemark): SettledRemark[] => {
    const cuts = splitBySpeaker(r, segments, rules);
    if (cuts.length > 1) observe?.({ type: "cut", pieces: cuts.length });
    return cuts.map(({ remark, slot }) => (slot === undefined || isUnlabeled(slot) ? remark : { ...remark, speaker: labelOf(slot) }));
  };

  const release = (): SettledRemark[] => {
    const out: SettledRemark[] = [];
    for (let head = held[0]; head !== undefined; head = held[0]) {
      if (isSettled(head.remark)) out.push(...attribute(head.remark));
      else if (rules.waitLimit && head.heldAt + SPEAKER_WAIT_MS <= clock) {
        observe?.({ type: "timeout" });
        out.push(head.remark);
      } else break;
      held.shift();
    }
    return out;
  };

  const flush = (): SettledRemark[] => held.splice(0).flatMap((h) => (isSettled(h.remark) ? attribute(h.remark) : [h.remark]));

  return {
    remarks(settled: readonly SettledRemark[], now: number): SettledRemark[] {
      clock = Math.max(clock, now);
      const out = release();
      for (const r of settled) {
        if (r.track === "自分") out.push({ ...r, speaker: "自分" });
        else if (off) out.push(r);
        else {
          held.push({ remark: r, heldAt: clock });
          out.push(...release());
        }
      }
      return out;
    },

    speaker(event: SpeakerLogEvent): SettledRemark[] {
      if (off) return [];
      if (event.type === "speaker-off") {
        off = true;
        provisionalShown = [];
        provisionalAwaitingSettled = [];
        return held.splice(0).map((h) => h.remark);
      }
      if (event.track !== "相手") return [];
      if (event.type === "speaker-mixed") {
        revertedSlots.add(event.slot);
        const label = slotLabels.get(event.slot);
        if (label !== undefined) revertedLabels.add(label);
        observe?.({ type: "mixed", slot: event.slot, ...(label === undefined ? {} : { label }) });
        return [];
      }
      if (event.type === "speaker-centroid") {
        onCentroid(event.slot, event.centroid);
        return [];
      }
      if (event.type === "speaker-settled") {
        settledTo = Math.max(settledTo, event.to);
        provisionalShown = provisionalAwaitingSettled;
        provisionalAwaitingSettled = [];
        return release();
      }
      see(event.slot);
      if (event.final) segments.push({ start: event.start, end: event.end, slot: event.slot });
      else provisionalAwaitingSettled.push({ start: event.start, end: event.end, slot: event.slot });
      return [];
    },

    restart(): SettledRemark[] {
      const out = flush();
      renumbered = true;
      segments = [];
      settledTo = Number.NEGATIVE_INFINITY;
      slotLabels = new Map();
      slotStates = new Map();
      slotCentroids = new Map();
      revertedSlots = new Set();
      provisionalShown = [];
      provisionalAwaitingSettled = [];
      seenSlots = [];
      return out;
    },

    heldRemarks: (): SettledRemark[] => held.map((h) => h.remark),

    previewSegments: (): Segment[] => [...segments, ...provisionalShown],

    previewLabel(slot: number): string | undefined {
      if (isUnlabeled(slot)) return undefined;
      const known = slotLabels.get(slot);
      if (known !== undefined) return known;
      const unassigned = seenSlots.filter((s) => !slotLabels.has(s) && !isUnlabeled(s));
      const rank = unassigned.indexOf(slot);
      return `相手 ${letters(labelCount + (rank < 0 ? unassigned.length : rank))}`;
    },

    labels: (): string[] => Array.from({ length: labelCount }, (_, n) => `相手 ${letters(n)}`),

    drain: flush,
  };
}
