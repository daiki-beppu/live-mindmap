// #761 の一時計測（コミットしない）。sttReplay と同じ流し方で、差分更新の呼び出しの始まり・終わりと渡した発言を記録し、
// 行ごとに「話し終わり → 発言 → 呼び出し → 応答（ノード）」の区間を出す。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { DiffUpdater, LogEvent, recall } from "../src/core/index.ts";
import { claudeUpdaterLayer } from "../src/diffUpdater.ts";
import { defaultClaude } from "../src/modelSelection.ts";
import { readTruthFile, readTextFile } from "../src/truthFile.ts";
import { readJsonFile } from "./entry.ts";
import { SpokenLine } from "./sttLatency.ts";
import { ReplayItem, reflectedArrivals, replayByArrival } from "./sttReplay.ts";

const [itemsPath, linesPath, outPath, truthPath] = process.argv.slice(2);
type Call = { start: number; end: number; fresh: string[]; ok: boolean };
const calls: Call[] = [];
let t0 = 0;
const now = () => (performance.now() - t0) / 1000;

const timed = Layer.effect(DiffUpdater)(Effect.gen(function* () {
  const inner = yield* DiffUpdater;
  return {
    update: (input) => Effect.gen(function* () {
      const start = now();
      const result = yield* inner.update(input).pipe(Effect.tapError(() => Effect.sync(() => calls.push({ start, end: now(), fresh: input.fresh.map((r) => r.id), ok: false }))));
      calls.push({ start, end: now(), fresh: input.fresh.map((r) => r.id), ok: true });
      return result;
    }),
  };
})).pipe(Layer.provide(claudeUpdaterLayer(defaultClaude)));

const main = Effect.gen(function* () {
  const items = yield* readJsonFile(itemsPath!, Schema.Array(ReplayItem));
  const lines = yield* readJsonFile(linesPath!, Schema.Array(SpokenLine));
  const { createSessionDir, openRecordedSession } = yield* Effect.promise(() => import("../src/sessionFiles.ts"));
  const dir = yield* createSessionDir(mkdtempSync(join(tmpdir(), "m761-"))).pipe(Effect.orDie);
  const diffEnds: number[] = [];
  const { session } = yield* openRecordedSession({ model: defaultClaude, dir, title: "bench", publish: () => Effect.void, onDiff: Effect.sync(() => diffEnds.push(now())) });
  t0 = performance.now();
  yield* replayByArrival(session, items);
  const log = yield* readTextFile(join(dir, "log.jsonl")).pipe(Effect.orDie);
  const events = yield* Effect.forEach(log.trim().split("\n"), (l) => Schema.decodeEffect(Schema.fromJsonString(LogEvent))(l)).pipe(Effect.orDie);
  const diffs = events.filter((e) => e.type === "diff");
  const arrivals = reflectedArrivals(diffs as never, diffEnds, items);
  const usage = diffs.reduce((a, d) => { const u = (d as { usage?: Record<string, number> }).usage; if (u) for (const k in u) if (typeof u[k] === "number") a[k] = (a[k] ?? 0) + u[k]!; return a; }, {} as Record<string, number>);
  const rec = truthPath ? recall(yield* session.exportJson, yield* readTruthFile(truthPath)) : undefined;
  writeFileSync(outPath!, JSON.stringify({ dir, items, lines, calls, diffEnds, arrivals, usage, recall: rec }));
  console.log(`done ${dir} calls=${calls.length}`);
}).pipe(Effect.scoped, Effect.provide(timed));

main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
