import { join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  createSpeakerAttribution, decodeHelperEvent, HelperEvent, longestOverlap, RemarkEvent, SPEAKER_WAIT_MS,
  type Segment, type SettledRemark, type SpeakerLogEvent, type SpeakerRecord, type SpeakerRules,
} from "../src/core/index.ts";
import { exitNaturally } from "../src/exitNaturally.ts";
import { createRemarkSettling } from "../src/remarkSettling.ts";
import { benchProgram, InvalidInputFile, MissingSessionDir, readInputText, write } from "./entry.ts";

export type ReplayOptions = {
  rules?: Partial<SpeakerRules>;
  restartAt?: number;
  path?: string;
  tentativeLabels?: boolean;
};

export type ReplayRemark = { source: string; track: string; start: number; end: number; speaker?: string; tentative?: string };
export type ReplayResult = {
  remarks: ReplayRemark[];
  labels: string[];
  mixed: Array<{ at: number; slot: number; label?: string }>;
  links: Array<{ at: number; slot: number; result: "linked" | "new" | "reverted"; label?: string }>;
  restarts: Array<{ at: number; source: "flag" | "log" }>;
  cuts: number;
  timeouts: number;
};

export type InputLine = { no: number; value: unknown };

type Step = { at: number; inputAt: number; run: Effect.Effect<void>; settled?: true };
type Hooks = { restart: Effect.Effect<void>; drain: Effect.Effect<void> };

const ruleSet = (rules: Partial<SpeakerRules> | undefined): SpeakerRules => ({
  longestOverlap: rules?.longestOverlap ?? true,
  fillUnassigned: rules?.fillUnassigned ?? true,
  minRun: rules?.minRun ?? true,
  waitLimit: rules?.waitLimit ?? true,
});

function createCollector(sourceOf: (remark: SettledRemark, index: number) => string) {
  const result: ReplayResult = { remarks: [], labels: [], mixed: [], links: [], restarts: [], cuts: 0, timeouts: 0 };
  let inputAt: number;
  return {
    result,
    setInputAt: (at: number) => { inputAt = at; },
    add: (remarks: readonly SettledRemark[], tentativeOf?: (remark: SettledRemark) => string | undefined) => {
      for (const r of remarks) {
        const tentative = tentativeOf?.(r);
        result.remarks.push({
          source: sourceOf(r, result.remarks.length), track: r.track, start: r.start, end: r.end,
          ...(r.speaker === undefined ? {} : { speaker: r.speaker }),
          ...(tentative === undefined ? {} : { tentative }),
        });
      }
    },
    observe: (record: SpeakerRecord) => {
      switch (record.type) {
        case "mixed":
          result.mixed.push({ at: inputAt, slot: record.slot, ...(record.label === undefined ? {} : { label: record.label }) });
          break;
        case "link":
          result.links.push({ at: inputAt, slot: record.slot, result: record.result, ...(record.label === undefined ? {} : { label: record.label }) });
          break;
        case "cut":
          result.cuts += record.pieces - 1;
          break;
        case "timeout":
          result.timeouts += 1;
          break;
      }
    },
  };
}

const runSteps = (steps: readonly Step[], hooks: Hooks, collector: ReturnType<typeof createCollector>, restartAt: number | undefined) =>
  Effect.gen(function* () {
    let pending = restartAt !== undefined;
    for (const step of steps) {
      collector.setInputAt(step.inputAt);
      if (pending && restartAt !== undefined && step.at >= restartAt) {
        pending = false;
        collector.result.restarts.push({ at: step.at, source: "flag" });
        yield* hooks.restart;
      }
      yield* step.run;
    }
    yield* hooks.drain;
  });

const invalid = (path: string | undefined, line: number, what: string) => new InvalidInputFile({ path: path ?? "(入力)", reason: `${line} 行目の${what}が不正です` });

const Envelope = Schema.Struct({ type: Schema.String, at: Schema.optionalKey(Schema.String) });
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);
const decodeRemarkEvent = Schema.decodeUnknownEffect(RemarkEvent);
const decodeHelper = Schema.decodeUnknownEffect(HelperEvent);

const SPEAKER_TYPES: ReadonlySet<string> = new Set(["speaker", "speaker-off", "speaker-settled", "speaker-mixed", "speaker-centroid"]);
const isSpeakerEvent = (event: HelperEvent): event is SpeakerLogEvent => SPEAKER_TYPES.has(event.type);

type Tagged = SettledRemark & { source: string };

const toInput = (event: typeof RemarkEvent["Type"]): Tagged => ({
  source: event.remark.id,
  track: event.remark.track,
  start: event.remark.start,
  end: event.remark.end,
  text: event.raw ?? event.remark.text,
  ...(event.words === undefined ? {} : { words: event.words }),
  ...(event.wordTimes === undefined ? {} : { wordTimes: event.wordTimes }),
});

function logSteps(lines: readonly InputLine[], path: string | undefined, attribution: ReturnType<typeof createSpeakerAttribution>, collector: ReturnType<typeof createCollector>) {
  return Effect.gen(function* () {
    const steps: Step[] = [];
    let clock = 0;
    let firstMs: number | undefined;
    let lastMs = 0;
    for (const { no: n, value: line } of lines) {
      const head = yield* decodeEnvelope(line).pipe(Effect.mapError(() => invalid(path, n, "行")));
      const ms = head.at === undefined ? Number.NaN : Date.parse(head.at);
      lastMs = Number.isFinite(ms) ? ms : lastMs;
      firstMs ??= lastMs;
      const at = (lastMs - firstMs) / 1000;
      if (head.type === "remark") {
        const event = yield* decodeRemarkEvent(line).pipe(Effect.mapError(() => invalid(path, n, "remark")));
        const input = toInput(event);
        steps.push({ at, inputAt: at, run: Effect.sync(() => {
          clock = Math.max(clock, input.end * 1000);
          collector.add(attribution.remarks([input], clock));
          clock += SPEAKER_WAIT_MS;
          collector.add(attribution.remarks([], clock));
        }) });
      } else if (SPEAKER_TYPES.has(head.type)) {
        const event = yield* decodeHelper(line).pipe(Effect.mapError(() => invalid(path, n, "話者のイベント")));
        if (isSpeakerEvent(event)) steps.push({ at, inputAt: at, run: Effect.sync(() => collector.add(attribution.speaker(event))) });
      } else if (head.type === "intake-restarted") {
        steps.push({ at, inputAt: at, run: Effect.sync(() => {
          collector.result.restarts.push({ at, source: "log" });
          collector.add(attribution.restart());
        }) });
      }
    }
    return steps;
  });
}

export const replayLog = Effect.fn("replayLog")(function* (lines: readonly InputLine[], options: ReplayOptions = {}) {
  const collector = createCollector((r) => (r as Partial<Tagged>).source ?? "");
  const attribution = createSpeakerAttribution({ rules: ruleSet(options.rules), observe: collector.observe });
  const steps = yield* logSteps(lines, options.path, attribution, collector);
  yield* runSteps(steps, {
    restart: Effect.sync(() => collector.add(attribution.restart())),
    drain: Effect.sync(() => collector.add(attribution.drain())),
  }, collector, options.restartAt);
  collector.result.labels = attribution.labels();
  return collector.result;
});

const OfflineArrival = Schema.Struct({ arrival: Schema.Finite });
const decodeArrival = Schema.decodeUnknownEffect(OfflineArrival);

type Settling = Effect.Success<ReturnType<typeof createRemarkSettling>>;
const runOf = (settling: Settling, event: HelperEvent): Omit<Step, "at" | "inputAt"> | undefined => {
  if (event.type === "partial") return { run: settling.partial(event) };
  if (event.type === "remark") return { run: settling.final({ track: event.track, start: event.start, end: event.end, text: event.text, ...(event.words === undefined ? {} : { words: event.words }), ...(event.wordTimes === undefined ? {} : { wordTimes: event.wordTimes }) }) };
  if (!isSpeakerEvent(event)) return undefined;
  return { run: settling.speaker(event), ...(event.type === "speaker-settled" ? { settled: true as const } : {}) };
};

const offlineSteps = (lines: readonly InputLine[], path: string | undefined, settling: Settling) =>
  Effect.gen(function* () {
    const rows: Array<{ arrival: number; index: number; step: Omit<Step, "at" | "inputAt"> }> = [];
    let first = Number.POSITIVE_INFINITY;
    for (const [index, { no: n, value: line }] of lines.entries()) {
      const { arrival } = yield* decodeArrival(line).pipe(Effect.mapError(() => invalid(path, n, "arrival")));
      const decoded = yield* decodeHelperEvent(JSON.stringify(line)).pipe(Effect.mapError(() => invalid(path, n, "イベント")));
      first = Math.min(first, arrival);
      if (decoded.kind === "unknown") continue;
      const step = runOf(settling, decoded.event);
      if (step !== undefined) rows.push({ arrival, index, step });
    }
    rows.sort((a, b) => a.arrival - b.arrival || a.index - b.index);
    return rows.map((row): Step => ({ at: row.arrival - first, inputAt: row.arrival, ...row.step }));
  });

type PreviewSnapshot = { segments: readonly Segment[]; labels: ReadonlyMap<number, string | undefined> };

export const replayOffline = Effect.fn("replayOffline")(function* (lines: readonly InputLine[], options: ReplayOptions = {}) {
  const collector = createCollector((_, index) => `r${index + 1}`);
  let snapshot: PreviewSnapshot = { segments: [], labels: new Map() };
  const tentativeOf = options.tentativeLabels !== true ? undefined : (remark: SettledRemark): string | undefined => {
    if (remark.track !== "相手") return undefined;
    const slot = longestOverlap(remark.start, remark.end, snapshot.segments);
    return slot === undefined ? undefined : snapshot.labels.get(slot);
  };
  const settling = yield* createRemarkSettling({
    emit: (r) => Effect.sync(() => collector.add([r], tentativeOf)),
    speakers: { rules: ruleSet(options.rules), observe: collector.observe },
  });
  const resolve = (segments: readonly Segment[]): PreviewSnapshot => ({ segments, labels: new Map(segments.map((s) => [s.slot, settling.preview.label(s.slot)])) });
  const track = options.tentativeLabels === true;
  const afterStep = (run: Effect.Effect<void>, recapture: boolean) =>
    track ? Effect.andThen(run, Effect.sync(() => { snapshot = resolve(recapture ? settling.preview.segments() : snapshot.segments); })) : run;
  const steps = (yield* offlineSteps(lines, options.path, settling)).map((step): Step => ({ ...step, run: afterStep(step.run, step.settled !== undefined) }));
  yield* runSteps(steps, { restart: afterStep(settling.renumbered, true), drain: settling.drain }, collector, options.restartAt);
  collector.result.labels = settling.labels();
  return collector.result;
});

export const readLines = Effect.fn("readLines")(function* (path: string) {
  const text = yield* readInputText(path);
  const lines: InputLine[] = [];
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (!row.trim()) continue;
    const no = i + 1;
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(row).pipe(
      Effect.mapError(() => new InvalidInputFile({ path, reason: `${no} 行目の JSON が不正です` })),
    );
    lines.push({ no, value });
  }
  return lines;
});

const resolveInput = Effect.fn("resolveInput")(function* (input: string, offline: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(input).pipe(Effect.mapError(() => (offline ? new InvalidInputFile({ path: input, reason: "ファイルを読めません" }) : new MissingSessionDir({ path: input, reason: "フォルダまたはログを読めません" }))));
  if (info.type === "File") return input;
  if (offline || info.type !== "Directory") return yield* new InvalidInputFile({ path: input, reason: "通常のファイルではありません" });
  const path = join(input, "log.jsonl");
  const log = yield* fs.stat(path).pipe(Effect.mapError(() => new InvalidInputFile({ path, reason: "ログを読めません" })));
  if (log.type !== "File") return yield* new InvalidInputFile({ path, reason: "通常のファイルではありません" });
  return path;
});

export const ruleFlags = {
  withoutLongestOverlap: Flag.Boolean("without-longest-overlap").pipe(Flag.withDescription("「最も長い重なり」の規則を外す（先に始まる区間の枠にする）"), Flag.withDefault(false)),
  withoutFill: Flag.Boolean("without-fill").pipe(Flag.withDescription("「誰もいない語を前後に寄せる」規則を外す"), Flag.withDefault(false)),
  withoutMinRun: Flag.Boolean("without-min-run").pipe(Flag.withDescription("「0.5 秒の下限」の規則を外す"), Flag.withDefault(false)),
  withoutWait: Flag.Boolean("without-wait").pipe(Flag.withDescription("「3 秒の待ち」を外す（揃うまで待つ）"), Flag.withDefault(false)),
  restartAt: Flag.Finite("restart-at").pipe(Flag.withDescription("届いた時刻（最初の入力からの秒）。この時刻以降の最初の入力の直前に、話者分離の枠の状態を捨てる"), Flag.optional),
};

export type RuleFlagValues = {
  withoutLongestOverlap: boolean;
  withoutFill: boolean;
  withoutMinRun: boolean;
  withoutWait: boolean;
  restartAt: Option.Option<number>;
};

export const replayOptionsOf = (args: RuleFlagValues, path: string): ReplayOptions => ({
  path,
  rules: {
    longestOverlap: !args.withoutLongestOverlap,
    fillUnassigned: !args.withoutFill,
    minRun: !args.withoutMinRun,
    waitLimit: !args.withoutWait,
  },
  ...(Option.isSome(args.restartAt) ? { restartAt: args.restartAt.value } : {}),
});

export const command = Command.make("speakerReplay", {
  input: Argument.String("input").pipe(Argument.withDescription("log.jsonl のあるセッションフォルダか log.jsonl。--offline ではオフライン出力のファイル")),
  offline: Flag.Boolean("offline").pipe(Flag.withDescription("入力を、arrival（秒）つきのヘルパーのイベントの JSONL として読む"), Flag.withDefault(false)),
  ...ruleFlags,
}, Effect.fn("speakerReplay")(function* (args) {
  const path = yield* resolveInput(args.input, args.offline);
  const lines = yield* readLines(path);
  const options = replayOptionsOf(args, path);
  const result = yield* (args.offline ? replayOffline(lines, options) : replayLog(lines, options));
  yield* write(JSON.stringify(result));
})).pipe(Command.withDescription("log.jsonl かオフライン出力を、届いた順に話者の結び付けへ流し直し、発言・ラベル・混入・つなぎ直し・規則の効き目の数を本文なしで JSON に出す"));

if (import.meta.main) {
  benchProgram(command).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
