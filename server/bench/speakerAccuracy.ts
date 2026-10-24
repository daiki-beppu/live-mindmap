import { NodeRuntime } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { decodeHelperEvent } from "../src/core/index.ts";
import { exitNaturally } from "../src/exitNaturally.ts";
import { benchProgram, InvalidInputFile, readInputText, write } from "./entry.ts";
import { type InputLine, readLines, replayOffline, type ReplayResult, replayOptionsOf, ruleFlags } from "./speakerReplay.ts";
import { parseTimeline } from "./sttAccuracy.ts";

const EPSILON = 1e-6;
const DER_COLLAR_SECONDS = 0.25;

type Span = { start: number; end: number };
type TruthRow = Span & { speaker: string };
type Scored = Span & { track: string; speaker?: string };
type Segment = Span & { slot: number };

const overlap = (a: Span, b: Span) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

function overlapByPerson(span: Span, timeline: readonly TruthRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of timeline) {
    const o = overlap(span, row);
    if (o > EPSILON) totals.set(row.speaker, (totals.get(row.speaker) ?? 0) + o);
  }
  return totals;
}

export function groundTruthSpeaker(remark: Span, timeline: readonly TruthRow[]): string | undefined {
  let best: string | undefined;
  let bestSeconds = 0;
  for (const [speaker, seconds] of overlapByPerson(remark, timeline)) {
    if (seconds > bestSeconds) {
      best = speaker;
      bestSeconds = seconds;
    }
  }
  return best;
}

const SENTINEL_COLUMN = 0;
const NO_ROW = 0;

type OneBased = number[];
type Assignment = { n: number; rowPotential: OneBased; columnPotential: OneBased; matchedRow: OneBased; previousColumn: OneBased };

function relax(cost: (i: number, j: number) => number, state: Assignment, i0: number, j0: number, used: readonly boolean[], minv: number[]) {
  let delta = Number.POSITIVE_INFINITY;
  let next = 0;
  for (let j = 1; j <= state.n; j++) {
    if (used[j]) continue;
    const current = cost(i0, j) - state.rowPotential[i0]! - state.columnPotential[j]!;
    if (current < minv[j]!) {
      minv[j] = current;
      state.previousColumn[j] = j0;
    }
    if (minv[j]! < delta) {
      delta = minv[j]!;
      next = j;
    }
  }
  return { delta, next };
}

function shiftPotentials(state: Assignment, used: readonly boolean[], minv: number[], delta: number): void {
  for (let j = 0; j <= state.n; j++) {
    if (used[j]) {
      state.rowPotential[state.matchedRow[j]!] = state.rowPotential[state.matchedRow[j]!]! + delta;
      state.columnPotential[j] = state.columnPotential[j]! - delta;
    } else minv[j] = minv[j]! - delta;
  }
}

function addRow(cost: (i: number, j: number) => number, state: Assignment, i: number): void {
  state.matchedRow[SENTINEL_COLUMN] = i;
  let j0 = SENTINEL_COLUMN;
  const minv = new Array<number>(state.n + 1).fill(Number.POSITIVE_INFINITY);
  const used = new Array<boolean>(state.n + 1).fill(false);
  do {
    used[j0] = true;
    const { delta, next } = relax(cost, state, state.matchedRow[j0]!, j0, used, minv);
    shiftPotentials(state, used, minv, delta);
    j0 = next;
  } while (state.matchedRow[j0] !== NO_ROW);
  for (let j1 = state.previousColumn[j0]!; ; j1 = state.previousColumn[j0]!) {
    state.matchedRow[j0] = state.matchedRow[j1]!;
    j0 = j1;
    if (j0 === SENTINEL_COLUMN) break;
  }
}

export function assignOneToOne(weights: readonly (readonly number[])[]): (number | undefined)[] {
  const rows = weights.length;
  const n = Math.max(rows, ...weights.map((row) => row.length));
  if (rows === 0) return [];
  const weight = (i: number, j: number) => weights[i - 1]?.[j - 1] ?? 0;
  const cost = (i: number, j: number) => -weight(i, j);
  const state: Assignment = { n, rowPotential: new Array<number>(n + 1).fill(0), columnPotential: new Array<number>(n + 1).fill(0), matchedRow: new Array<number>(n + 1).fill(NO_ROW), previousColumn: new Array<number>(n + 1).fill(SENTINEL_COLUMN) };
  for (let i = 1; i <= n; i++) addRow(cost, state, i);
  const result: (number | undefined)[] = new Array<number | undefined>(rows).fill(undefined);
  for (let j = 1; j <= n; j++) {
    const i = state.matchedRow[j]!;
    if (i >= 1 && i <= rows && weight(i, j) > 0) result[i - 1] = j - 1;
  }
  return result;
}

const heardRemarks = (remarks: readonly Scored[]) => remarks.filter((r) => r.track === "相手");
const otherRows = (self: string, timeline: readonly TruthRow[]) => timeline.filter((row) => row.speaker !== self);

export type Attribution = {
  correct: number;
  wrong: number;
  none: number;
  noTruth: number;
  rates: { correct: number; wrong: number; none: number };
};

export function assignSpeakers({ self, timeline, remarks }: { self: string; timeline: readonly TruthRow[]; remarks: readonly Scored[] }): ReadonlyMap<string, string | undefined> {
  const assignment = createSpeakerAssignment({ self, timeline });
  for (const remark of remarks) assignment.add(remark);
  return assignment.finish();
}

export function createSpeakerAssignment({ self, timeline }: { self: string; timeline: readonly TruthRow[] }) {
  const rows = otherRows(self, timeline);
  const people = [...new Set(rows.map((row) => row.speaker))];
  const weights = new Map<string, number[]>();
  return {
    add(remark: Scored): void {
      if (remark.track !== "相手" || remark.speaker === undefined) return;
      let row = weights.get(remark.speaker);
      if (row === undefined) {
        row = people.map(() => 0);
        weights.set(remark.speaker, row);
      }
      for (const [person, seconds] of overlapByPerson(remark, rows)) row[people.indexOf(person)]! += seconds;
    },
    finish(): ReadonlyMap<string, string | undefined> {
      const assignment = assignOneToOne([...weights.values()]);
      return new Map([...weights.keys()].map((label, i) => [label, assignment[i] === undefined ? undefined : people[assignment[i]!]]));
    },
  };
}

export function scoreAttribution({ self, timeline, remarks, personOf }: { self: string; timeline: readonly TruthRow[]; remarks: readonly Scored[]; personOf: ReadonlyMap<string, string | undefined> }): Attribution {
  const rows = otherRows(self, timeline);
  let correct = 0;
  let wrong = 0;
  let none = 0;
  let noTruth = 0;
  for (const r of heardRemarks(remarks)) {
    const truth = groundTruthSpeaker(r, rows);
    if (truth === undefined) noTruth++;
    else if (r.speaker === undefined) none++;
    else if (personOf.get(r.speaker) === truth) correct++;
    else wrong++;
  }
  const total = correct + wrong + none;
  const rate = (n: number) => (total === 0 ? 0 : n / total);
  return { correct, wrong, none, noTruth, rates: { correct: rate(correct), wrong: rate(wrong), none: rate(none) } };
}

type ArrivedSegment = Segment & { arrival: number };
type RecoveryInput = { self: string; timeline: readonly TruthRow[]; segments: readonly ArrivedSegment[]; origin: number; restarts: ReplayResult["restarts"] };
type Mixing = { people: number; detected: number; hits: number; falsePositives: number; medianDelay: number | undefined };
type Relinking = { correct: number; wrong: number; new: number; none: number };

const generationAt = (arrival: number, origin: number, restarts: ReplayResult["restarts"]) => restarts.filter((restart) => origin + restart.at <= arrival).length;

function slotOverlaps(segments: readonly ArrivedSegment[], rows: readonly TruthRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const seg of segments) {
    for (const [person, seconds] of overlapByPerson(seg, rows)) totals.set(person, (totals.get(person) ?? 0) + seconds);
  }
  return totals;
}

export function scoreMixing({ self, timeline, segments, origin, restarts, mixed }: RecoveryInput & { mixed: ReplayResult["mixed"] }): Mixing {
  const rows = otherRows(self, timeline);
  const delays: number[] = [];
  for (const detection of mixed) {
    const generation = generationAt(detection.at, origin, restarts);
    const arrived = segments.filter((seg) => seg.slot === detection.slot && seg.arrival <= detection.at && generationAt(seg.arrival, origin, restarts) === generation);
    const overlaps = [...slotOverlaps(arrived, rows)].sort((a, b) => b[1] - a[1]);
    const second = overlaps[1];
    if (second === undefined || second[1] / overlaps.reduce((sum, [, seconds]) => sum + seconds, 0) < 0.1) continue;
    const firstStart = Math.min(...arrived.filter((seg) => overlapByPerson(seg, rows).has(second[0])).map((seg) => seg.start));
    delays.push(detection.at - firstStart);
  }
  delays.sort((a, b) => a - b);
  const middle = Math.floor(delays.length / 2);
  const medianDelay = delays.length === 0 ? undefined : delays.length % 2 === 0 ? (delays[middle - 1]! + delays[middle]!) / 2 : delays[middle]!;
  return { people: new Set(rows.map((row) => row.speaker)).size, detected: mixed.length, hits: delays.length, falsePositives: mixed.length - delays.length, medianDelay };
}

function restartedSlots({ segments, origin, restarts }: Pick<RecoveryInput, "segments" | "origin" | "restarts">) {
  const slots = new Map<string, { generation: number; slot: number; spans: ArrivedSegment[] }>();
  for (const seg of segments) {
    const generation = generationAt(seg.arrival, origin, restarts);
    if (generation === 0) continue;
    const key = `${generation}:${seg.slot}`;
    const group = slots.get(key);
    if (group === undefined) slots.set(key, { generation, slot: seg.slot, spans: [seg] });
    else group.spans.push(seg);
  }
  return slots.values();
}

export function scoreRelinking({ self, timeline, segments, origin, restarts, links, personOf }: RecoveryInput & { links: ReplayResult["links"]; personOf: ReadonlyMap<string, string | undefined> }): Relinking | undefined {
  if (restarts.length === 0) return undefined;
  const rows = otherRows(self, timeline);
  const counts: Relinking = { correct: 0, wrong: 0, new: 0, none: 0 };
  for (const { generation, slot, spans } of restartedSlots({ segments, origin, restarts })) {
    const person = [...slotOverlaps(spans, rows)].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (person === undefined) continue;
    const link = links.findLast((record) => record.slot === slot && generationAt(record.at, origin, restarts) === generation);
    if (link === undefined || link.result === "reverted") counts.none++;
    else if (link.result === "new") counts.new++;
    else if (link.label !== undefined && personOf.get(link.label) === person) counts.correct++;
    else counts.wrong++;
  }
  return counts;
}

export type Der = { der: number; referenceSeconds: number; missedSeconds: number; falseAlarmSeconds: number; confusionSeconds: number };

type DerSpan = { duration: number; speakers: string[]; slots: number[] };

function derSpans(reference: readonly TruthRow[], hypothesis: readonly Segment[]): DerSpan[] {
  const events: Array<{ at: number; speaker?: string; slot?: number; collar?: boolean; delta: 1 | -1 }> = [];
  for (const row of reference) {
    events.push({ at: row.start, speaker: row.speaker, delta: 1 }, { at: row.end, speaker: row.speaker, delta: -1 });
    for (const boundary of [row.start, row.end]) {
      events.push({ at: boundary - DER_COLLAR_SECONDS, collar: true, delta: 1 }, { at: boundary + DER_COLLAR_SECONDS, collar: true, delta: -1 });
    }
  }
  for (const seg of hypothesis) events.push({ at: seg.start, slot: seg.slot, delta: 1 }, { at: seg.end, slot: seg.slot, delta: -1 });
  events.sort((a, b) => a.at - b.at);
  const speakers = new Map<string, number>();
  const slots = new Map<number, number>();
  let collar = 0;
  const spans: DerSpan[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.speaker !== undefined) speakers.set(e.speaker, (speakers.get(e.speaker) ?? 0) + e.delta);
    else if (e.slot !== undefined) slots.set(e.slot, (slots.get(e.slot) ?? 0) + e.delta);
    else collar += e.delta;
    const next = events[i + 1];
    if (next === undefined || next.at <= e.at || collar > 0) continue;
    const active = <K>(counts: Map<K, number>) => [...counts].filter(([, n]) => n > 0).map(([key]) => key);
    spans.push({ duration: next.at - e.at, speakers: active(speakers), slots: active(slots) });
  }
  return spans;
}

export function computeDer({ reference, hypothesis }: { reference: readonly TruthRow[]; hypothesis: readonly Segment[] }): Der {
  const spans = derSpans(reference, hypothesis);
  const people = [...new Set(reference.map((row) => row.speaker))];
  const slots = [...new Set(hypothesis.map((seg) => seg.slot))];
  const weights = slots.map(() => people.map(() => 0));
  for (const span of spans) {
    for (const slot of span.slots) for (const speaker of span.speakers) weights[slots.indexOf(slot)]![people.indexOf(speaker)]! += span.duration;
  }
  const assignment = assignOneToOne(weights);
  const personOf = new Map(slots.map((slot, i) => [slot, assignment[i] === undefined ? undefined : people[assignment[i]!]]));
  let referenceSeconds = 0;
  let missedSeconds = 0;
  let falseAlarmSeconds = 0;
  let confusionSeconds = 0;
  for (const { duration, speakers, slots: active } of spans) {
    const correct = active.filter((slot) => {
      const person = personOf.get(slot);
      return person !== undefined && speakers.includes(person);
    }).length;
    referenceSeconds += duration * speakers.length;
    missedSeconds += duration * Math.max(0, speakers.length - active.length);
    falseAlarmSeconds += duration * Math.max(0, active.length - speakers.length);
    confusionSeconds += duration * (Math.min(speakers.length, active.length) - correct);
  }
  return {
    der: referenceSeconds > 0 ? (missedSeconds + falseAlarmSeconds + confusionSeconds) / referenceSeconds : Number.NaN,
    referenceSeconds, missedSeconds, falseAlarmSeconds, confusionSeconds,
  };
}

export function tentativeChangeRate({ remarks }: { remarks: ReadonlyArray<{ speaker?: string; tentative?: string }> }): { changed: number; total: number } {
  let changed = 0;
  let total = 0;
  for (const r of remarks) {
    if (r.tentative === undefined || r.speaker === undefined) continue;
    total++;
    if (r.tentative !== r.speaker) changed++;
  }
  return { changed, total };
}

export function countUnsplit({ self, timeline, remarks }: { self: string; timeline: readonly TruthRow[]; remarks: readonly Scored[] }): number {
  const rows = otherRows(self, timeline);
  return heardRemarks(remarks).filter((r) => overlapByPerson(r, rows).size >= 2).length;
}

const Arrival = Schema.Struct({ arrival: Schema.Finite });
const decodeArrival = Schema.decodeUnknownEffect(Arrival);

const finalSegments = (lines: readonly InputLine[], path: string) =>
  Effect.gen(function* () {
    const segments: ArrivedSegment[] = [];
    let origin = Number.POSITIVE_INFINITY;
    for (const { no, value } of lines) {
      const bad = (what: string) => new InvalidInputFile({ path, reason: `${no} 行目の${what}が不正です` });
      const { arrival } = yield* decodeArrival(value).pipe(Effect.mapError(() => bad("arrival")));
      origin = Math.min(origin, arrival);
      const decoded = yield* decodeHelperEvent(JSON.stringify(value)).pipe(Effect.mapError(() => bad("イベント")));
      if (decoded.kind === "unknown") continue;
      const event = decoded.event;
      if (event.type === "speaker" && event.track === "相手" && event.final) segments.push({ arrival, slot: event.slot, start: event.start, end: event.end });
    }
    return { segments, origin };
  });

const percent = (value: number) => (Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(1)}%`);

function renderTable(attribution: Attribution, der: Der, tentative: { changed: number; total: number }, replay: Pick<ReplayResult, "cuts" | "timeouts">, unsplit: number, mixing: Mixing, relinking: Relinking | undefined): string {
  const { correct, wrong, none, noTruth, rates } = attribution;
  const judged = correct + wrong + none === 0;
  const columns: Array<[string, string]> = [
    ["発言数", String(correct + wrong + none + noTruth)],
    ["正解", percent(judged ? Number.NaN : rates.correct)],
    ["取り違え", percent(judged ? Number.NaN : rates.wrong)],
    ["話者なし", percent(judged ? Number.NaN : rates.none)],
    ["採点対象外", String(noTruth)],
    ["DER", percent(der.der)],
    ["仮→確定", percent(tentative.total === 0 ? Number.NaN : tentative.changed / tentative.total)],
    ["切った", String(replay.cuts)],
    ["3秒で話者なし", String(replay.timeouts)],
    ["切れなかった", String(unsplit)],
    ["相手の人数", String(mixing.people)],
    ["混入の検出", String(mixing.detected)],
    ["当たり", String(mixing.hits)],
    ["誤検出", String(mixing.falsePositives)],
    ["検出まで", mixing.medianDelay === undefined ? "—" : mixing.medianDelay.toFixed(1)],
    ["誤ってつないだ", relinking === undefined ? "—" : String(relinking.wrong)],
    ["正しくつないだ", relinking === undefined ? "—" : String(relinking.correct)],
    ["新しいラベル", relinking === undefined ? "—" : String(relinking.new)],
    ["話者なし", relinking === undefined ? "—" : String(relinking.none)],
  ];
  return [
    `| ${columns.map(([name]) => name).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    `| ${columns.map(([, value]) => value).join(" | ")} |`,
  ].join("\n");
}

export const command = Command.make("speakerAccuracy", {
  self: Flag.String("self").pipe(Flag.withDescription("進行役（自分 トラックに入れた話者）。台本のこの話者の行は採点しない")),
  ...ruleFlags,
  timeline: Argument.String("timeline").pipe(Argument.withDescription("合成会議の timeline.tsv（話者・開始秒・終了秒・文）")),
  events: Argument.String("events").pipe(Argument.withDescription("stt-bench run --events の出力（arrival つきのヘルパーのイベントの JSONL）")),
}, Effect.fn("speakerAccuracy")(function* (args) {
  const timelineText = yield* readInputText(args.timeline);
  const timeline = parseTimeline(timelineText).map(({ speaker, start, end }) => ({ speaker, start, end }));
  if (!timeline.some((row) => row.speaker === args.self)) {
    return yield* new InvalidInputFile({ path: args.timeline, reason: `--self の話者「${args.self}」が台本にありません` });
  }
  const lines = yield* readLines(args.events);
  const replay = yield* replayOffline(lines, { ...replayOptionsOf(args, args.events), tentativeLabels: true });
  const scored = replay.remarks;
  const rows = otherRows(args.self, timeline);
  const { segments, origin } = yield* finalSegments(lines, args.events);
  const heard = heardRemarks(scored);
  const input = { self: args.self, timeline, remarks: scored };
  const personOf = assignSpeakers(input);
  const recovery = { self: args.self, timeline, segments, origin, restarts: replay.restarts };
  const table = renderTable(
    scoreAttribution({ ...input, personOf }),
    computeDer({ reference: rows, hypothesis: segments }),
    tentativeChangeRate({ remarks: heard }),
    replay,
    countUnsplit({ self: args.self, timeline, remarks: scored }),
    scoreMixing({ ...recovery, mixed: replay.mixed }),
    scoreRelinking({ ...recovery, links: replay.links, personOf }),
  );
  yield* write(table);
})).pipe(Command.withDescription("合成会議の発言を、正解・取り違え・話者なしに分けた割合と、DER・仮から確定で替わった割合・規則の効き目の数を、本文なしの表で出す"));

if (import.meta.main) {
  benchProgram(command).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
