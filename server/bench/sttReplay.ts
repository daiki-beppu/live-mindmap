// 発言を、認識結果が届いた時刻（at）で本番のセッションに流す（Issue #97）。
// end の時刻で流すと認識の遅れが消えるので、at の差だけ待つ。
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { LogEvent, recall, Remark, type Session } from "../src/core/index.ts";
import { claudeUpdaterLayer } from "../src/diffUpdater.ts";
import { describe, oneLine, readTruthFile } from "../src/truthFile.ts";
import { BENCH_VERSION, readJsonFile, reportFailure, write } from "./entry.ts";
import { indexRemarks, lineDelays, percentile, SpokenLine, type Arrival } from "./sttLatency.ts";

// at / source は計測用の項目で、セッションには渡さない
export const ReplayItem = Remark.mapFields((fields) => ({
  ...fields,
  at: Schema.Finite,
  source: Schema.optionalKey(Schema.String),
}));
export type ReplayItem = typeof ReplayItem["Type"];

export type ReplayOptions = { sleep?: (ms: number) => Effect.Effect<void> }; // 既定は Effect.sleep

// 本番の playback と同じ流し方（等速）。待ち時間だけが、発言の end の差ではなく at の差になる
export const replayByArrival = (session: Session, items: readonly ReplayItem[], { sleep = (ms) => Effect.sleep(ms) }: ReplayOptions = {}): Effect.Effect<void> =>
  Effect.gen(function* () {
    let prevAt = 0;
    for (const item of items) {
      yield* sleep((item.at - prevAt) * 1000);
      prevAt = item.at;
      const { id, track, start, end, text } = item;
      yield* session.push({ id, track, start, end, text });
    }
    yield* session.flush;
  });

type LoggedOp = { op: string; evidence?: string[] };
export type DiffLogEntry = { ops: LoggedOp[]; dropped?: { op: LoggedOp }[]; error?: string };

// ノードに反映された発言の時刻。成功した差分更新のうち、ノードを足す・更新する操作（add / update）の根拠に挙がった発言だけを、
// その差分更新が終わった時刻（doneAts[i] は i 番目の差分更新の終わり）の到着として数える。ops が空・noop だけの更新はノードを出していない
export function reflectedArrivals(diffs: readonly DiffLogEntry[], doneAts: readonly number[], items: readonly Remark[]): Arrival[] {
  const byId = indexRemarks(items);
  const arrivals: Arrival[] = [];
  const seen = new Set<string>();
  diffs.forEach((diff, i) => {
    if (diff.error) return;
    // 適用されなかった操作も ops には残る（session.ts の diff ログ）。dropped に載った操作は、ノードに反映されていない
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
const decodeLogEvent = Schema.decodeEffect(Schema.fromJsonString(LogEvent));

// 使い方は各 Command・Flag の withDescription が正本で、`node bench/sttReplay.ts --help` で読む
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
    // 入力は再生の前にまとめて読む。壊れていれば、再生せずにすぐ失敗する
    const items = yield* readJsonFile(file, Schema.Array(ReplayItem));
    const expected = Option.isNone(truth) ? undefined : yield* readTruthFile(truth.value);
    const spokenLines = Option.isNone(lines) ? undefined : yield* readJsonFile(lines.value, Schema.Array(SpokenLine));

    // cli.ts は vite と playwright を読み込むので、再生を始めるときだけ読む
    const { createSessionDir, openRecordedSession } = yield* Effect.tryPromise({ try: () => import("../src/cli.ts"), catch: describe });
    // セッションのフォルダは一時領域に作る
    const dir = yield* Effect.try({ try: () => createSessionDir(mkdtempSync(join(tmpdir(), "stt-replay-"))), catch: describe });
    const diffEndsMs: number[] = [];
    const { session } = yield* openRecordedSession({
      dir,
      title,
      publish: () => Effect.void,
      onDiff: Effect.sync(() => diffEndsMs.push(performance.now())),
    });
    const t0 = performance.now();
    yield* replayByArrival(session, items);
    // 差分更新ごとの終わりの時刻と、その呼び出しに渡した発言を、ログから引く
    const log = yield* Effect.try({ try: () => readFileSync(join(dir, "log.jsonl"), "utf8"), catch: describe });
    const events = yield* Effect.forEach(log.trim().split("\n"), (line) => decodeLogEvent(line)).pipe(
      Effect.mapError((e) => oneLine(e.message)),
    );
    const diffs = events.filter((e): e is DiffEvent => e.type === "diff");
    const arrivals = reflectedArrivals(diffs, diffEndsMs.map((ms) => (ms - t0) / 1000), items);
    // 各文の話し終わりから、その文を含む発言が差分更新に反映されるまで（--lines がなければ、ノードに反映された発言の end から）
    const delays = lineDelays(spokenLines ?? arrivals, arrivals);
    yield* write(`話し終わり → ノード p50 ${percentile(delays, 0.5).toFixed(1)} 秒 / p90 ${percentile(delays, 0.9).toFixed(1)} 秒（${delays.length} 件）\n`);
    // 正解があれば、eval --truth と同じ数え方（core の recall）で再現率を 1 行にして出す。表は runCli eval で見られる
    if (expected) {
      const r = recall(yield* session.exportJson, expected);
      yield* write(`再現率 決定 ${r["決定"].hit}/${r["決定"].total} TODO ${r["TODO"].hit}/${r["TODO"].total}\n`);
    }
    yield* write(`セッション: ${dir}\n`);
  }, Effect.scoped),
).pipe(
  Command.withDescription(
    "発言を、認識結果が届いた時刻（at）で本番のセッションに流し、遅れ（差分更新が返った時刻 − 流し始め − 発言の end）と再現率を出す（Issue #97）。"
      + "end の時刻で流すと認識の遅れが消えるので、at の差だけ待つ",
  ),
  // 差分更新は Layer が取得と解放を持ち、出力の後に 1 回だけ閉じる
  Command.provide(claudeUpdaterLayer),
);

if (import.meta.main) {
  Command.run(command, { version: BENCH_VERSION }).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
