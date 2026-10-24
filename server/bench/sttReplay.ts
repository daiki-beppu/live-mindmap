import { defaultClaude } from "../src/modelSelection.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Clock, Effect, Layer, Option, Ref, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { DiffUpdater, LogEvent, nameSpeaker, recall, Remark, SpeakerNameLogEvent, speakerNameMap, type SpeakerNameTable, type Session } from "../src/core/index.ts";
import { claudeUpdaterLayer } from "../src/diffUpdater.ts";
import { ManagedDeps } from "../src/managedDeps.ts";
import { depsDirConfig } from "../src/config.ts";
import { startupPreparationFailure } from "../src/managedDepsCheck.ts";
import { describe, fileReason, oneLine, readTextFile, readTruthFile } from "../src/truthFile.ts";
import { BENCH_VERSION, exitNaturallyForManagedDeps, readJsonFile, ReplaySessionFailed, reportFailure, write } from "./entry.ts";
import { indexRemarks, lineDelays, percentile, SpokenLine, type Arrival } from "./sttLatency.ts";

export const ReplayItem = Remark.mapFields((fields) => ({
  ...fields,
  at: Schema.Finite,
  source: Schema.optionalKey(Schema.String),
}));
export type ReplayItem = typeof ReplayItem["Type"];

export const replayByArrival = Effect.fnUntraced(function* (
  session: Session,
  items: readonly ReplayItem[],
): Effect.fn.Return<void> {
  const t0 = yield* Clock.currentTimeMillis;
  for (const item of items) {
    const wait = t0 + item.at * 1000 - (yield* Clock.currentTimeMillis);
    if (wait > 0) yield* Effect.sleep(wait);
    const { id, track, start, end, text, speaker } = item;
    yield* session.push({ id, track, start, end, text, ...(speaker === undefined ? {} : { speaker }) });
  }
  yield* session.flush;
});

type LoggedOp = { op: string; evidence?: string[] };
export type DiffLogEntry = { ops: LoggedOp[]; dropped?: { op: LoggedOp }[]; error?: string };

export function reflectedArrivals(diffs: readonly DiffLogEntry[], doneAts: readonly number[], items: readonly Remark[]): Arrival[] {
  const byId = indexRemarks(items);
  const arrivals: Arrival[] = [];
  const seen = new Set<string>();
  diffs.forEach((diff, i) => {
    if (diff.error) return;
    const dropped = new Set((diff.dropped ?? []).map((d) => JSON.stringify(d.op)));
    for (const op of diff.ops) {
      if (op.op !== "add" && op.op !== "update") continue;
      if (dropped.has(JSON.stringify(op))) continue;
      for (const id of op.evidence ?? []) {
        const remark = byId.get(id);
        if (!remark || seen.has(id)) continue;
        seen.add(id);
        arrivals.push({ start: remark.start, end: remark.end, at: doneAts[i]! });
      }
    }
  });
  return arrivals;
}

type DiffEvent = Extract<LogEvent, { type: "diff" }>;
const decodeLogEvent = Schema.decodeEffect(Schema.fromJsonString(Schema.Union([LogEvent, SpeakerNameLogEvent])));

const importSessionFilesWithVite = Effect.tryPromise({
  try: () => import("../src/sessionFiles.ts"),
  catch: (e) => new ReplaySessionFailed({ path: join(import.meta.dirname, "../src/sessionFiles.ts"), reason: describe(e) }),
});

export const command = Command.make(
  "sttReplay",
  {
    file: Argument.String("items").pipe(Argument.withDescription("再生する発言の JSON（sttLatency.ts --emit の出力）")),
    truth: Flag.File("truth").pipe(
      Flag.withDescription("正解ファイル（JSON）。あれば再現率を 1 行で出す。形は core/evaluate.ts の Truth が正本。再生の前に読む"),
      Flag.optional,
    ),
    lines: Flag.File("lines").pipe(
      Flag.withDescription("行の時刻の JSON。なければ、ノードに反映された発言の end から数える"),
      Flag.optional,
    ),
    title: Flag.String("title").pipe(Flag.withDescription("セッションの題名"), Flag.withDefault("bench")),
  },
  Effect.fn("sttReplay")(function* ({ file, lines, title, truth }) {
    const items = yield* readJsonFile(file, Schema.Array(ReplayItem));
    const expected = Option.isNone(truth) ? undefined : yield* readTruthFile(truth.value);
    const spokenLines = Option.isNone(lines) ? undefined : yield* readJsonFile(lines.value, Schema.Array(SpokenLine));

    const { createSessionDir, openLoggedSession } = yield* importSessionFilesWithVite;
    const tmp = yield* Effect.try({
      try: () => mkdtempSync(join(tmpdir(), "stt-replay-")),
      catch: (e) => new ReplaySessionFailed({ path: tmpdir(), reason: describe(e) }),
    });
    const dir = yield* createSessionDir(tmp).pipe(Effect.mapError((e) => new ReplaySessionFailed({ path: tmp, reason: fileReason(e) })));
    const diffEndsMs: number[] = [];
    const names = yield* Ref.make<SpeakerNameTable>(new Map());
    const baseUpdater = yield* DiffUpdater;
    const namedUpdater = DiffUpdater.of({
      ...baseUpdater,
      update: (input) => Effect.flatMap(Ref.get(names), (table) =>
        baseUpdater.update(table.size === 0 ? input : { ...input, speakerNames: speakerNameMap(table) })),
    });
    const { session, appendLog } = yield* openLoggedSession({
      model: defaultClaude,
      dir,
      title,
      publish: () => Effect.void,
      onDiff: Effect.sync(() => diffEndsMs.push(performance.now())),
      onSpeakerNames: (inferred): Effect.Effect<void> => Effect.forEach(inferred, ({ label, name, basis }) =>
        Effect.uninterruptible(Effect.gen(function* () {
          const next = nameSpeaker(yield* Ref.get(names), { label, name, basis, source: "推定" });
          if (next === undefined) return;
          yield* appendLog({ type: "speaker-name", label, name: next.get(label)!.name, source: "推定" });
          yield* Ref.set(names, next);
        })), { discard: true }),
    }).pipe(Effect.provideService(DiffUpdater, namedUpdater));
    const t0 = performance.now();
    yield* replayByArrival(session, items);
    const logPath = join(dir, "log.jsonl");
    const log = yield* readTextFile(logPath).pipe(Effect.mapError((e) => new ReplaySessionFailed({ path: logPath, reason: fileReason(e) })));
    const events = yield* Effect.forEach(log.trim().split("\n"), (line) => decodeLogEvent(line)).pipe(
      Effect.mapError((e) => new ReplaySessionFailed({ path: logPath, reason: oneLine(e.message) })),
    );
    const diffs = events.filter((e): e is DiffEvent => e.type === "diff");
    const arrivals = reflectedArrivals(diffs, diffEndsMs.map((ms) => (ms - t0) / 1000), items);
    const delays = lineDelays(spokenLines ?? arrivals, arrivals);
    yield* write(`話し終わり → ノード p50 ${percentile(delays, 0.5).toFixed(1)} 秒 / p90 ${percentile(delays, 0.9).toFixed(1)} 秒（${delays.length} 件）\n`);
    if (expected) {
      const r = recall(yield* session.exportJson, expected);
      yield* write(`再現率 決定 ${r["決定"].hit}/${r["決定"].total} TODO ${r["TODO"].hit}/${r["TODO"].total}\n`);
    }
    yield* write(`セッション: ${dir}\n`);
  }, Effect.scoped),
).pipe(
  Command.withDescription(
    "発言を、認識結果が届いた時刻（at）で本番のセッションに流し、遅れ（差分更新が返った時刻 − 流し始め − 発言の end）と再現率を出す（Issue #97）。"
      + "end の時刻で流すと認識の遅れが消えるので、流し始めからの at の時刻どおりに届ける（push が遅れても後ろの発言に遅れを足さず、at を過ぎていれば次はすぐ流す）",
  ),
  Command.provide(Layer.effectContext(Layer.build(claudeUpdaterLayer(defaultClaude)).pipe(
    Effect.mapError(startupPreparationFailure),
  ))),
);

if (import.meta.main) {
  const managedDeps = Layer.unwrap(Effect.gen(function* () {
    const root = yield* depsDirConfig;
    return ManagedDeps.layer({ root }).pipe(Layer.provide(NodeServices.layer));
  }));
  Command.run(command, { version: BENCH_VERSION }).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(Layer.mergeAll(managedDeps, NodeServices.layer)),
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturallyForManagedDeps }),
  );
}
