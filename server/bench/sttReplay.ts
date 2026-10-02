// 発言を、認識結果が届いた時刻（at）で本番のセッションに流す（Issue #97）。
// end の時刻で流すと認識の遅れが消えるので、at の差だけ待つ。
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Remark, Session } from "../src/core/index.ts";
import { indexRemarks, lineDelays, percentile, type Arrival, type SpokenLine } from "./sttLatency.ts";

// at / source は計測用の項目で、セッションには渡さない
export type ReplayItem = Remark & { at: number; source?: string };

export type ReplayOptions = { sleep: (ms: number) => Promise<void> };

// 本番の playback と同じ流し方（等速）。待ち時間だけが、発言の end の差ではなく at の差になる
export async function replayByArrival(session: Session, items: readonly ReplayItem[], { sleep }: ReplayOptions): Promise<void> {
  let prevAt = 0;
  for (const item of items) {
    await sleep((item.at - prevAt) * 1000);
    prevAt = item.at;
    const { id, track, start, end, text } = item;
    session.push({ id, track, start, end, text });
  }
  await session.flush();
}

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

// 使い方: node bench/sttReplay.ts <発言.json（sttLatency.ts --emit の出力）> [--truth <正解>] [--lines <行の時刻.json>] [--title <名前>]
// セッションのフォルダは一時領域に作る。出力: 遅れ（差分更新が返った時刻 − 流し始め − 発言の end）と、再現率
if (import.meta.main) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { truth: { type: "string" }, lines: { type: "string" }, title: { type: "string", default: "bench" } } });
  const file = positionals[0];
  if (!file) throw new Error("usage: sttReplay.ts <発言.json> [--truth <正解ファイル>] [--lines <行の時刻.json>] [--title <名前>]");
  const items = JSON.parse(readFileSync(file, "utf8")) as ReplayItem[];

  const { createSessionDir, startRecordedSession } = await import("../src/cli.ts");
  const { openClaudeUpdater } = await import("../src/claude.ts");
  const root = mkdtempSync(join(tmpdir(), "stt-replay-"));
  mkdirSync(root, { recursive: true });
  const dir = createSessionDir(root);
  const owned = openClaudeUpdater();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const diffEndsMs: number[] = [];
  try {
    const { session } = startRecordedSession({
      dir,
      title: values.title,
      updater: owned.update,
      publish: () => {},
      sleep,
      onDiff: () => diffEndsMs.push(performance.now()),
    });
    const t0 = performance.now();
    await replayByArrival(session, items, { sleep });
    // 差分更新ごとの終わりの時刻と、その呼び出しに渡した発言を、ログから引く
    const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const diffs = log.filter((e) => e.type === "diff") as DiffLogEntry[];
    const arrivals = reflectedArrivals(diffs, diffEndsMs.map((ms) => (ms - t0) / 1000), items);
    // 各文の話し終わりから、その文を含む発言が差分更新に反映されるまで（--lines がなければ、ノードに反映された発言の end から）
    const spoken = values.lines ? (JSON.parse(readFileSync(values.lines, "utf8")) as SpokenLine[]) : arrivals;
    const delays = lineDelays(spoken, arrivals);
    process.stdout.write(`話し終わり → ノード p50 ${percentile(delays, 0.5).toFixed(1)} 秒 / p90 ${percentile(delays, 0.9).toFixed(1)} 秒（${delays.length} 件）\n`);
    // 正解があれば、eval --truth と同じ数え方（core の recall）で再現率を 1 行にして出す。表は runCli eval で見られる
    if (values.truth) {
      const { parseTruth, recall } = await import("../src/core/index.ts");
      const r = recall(session.exportJson(), parseTruth(JSON.parse(readFileSync(values.truth, "utf8"))));
      process.stdout.write(`再現率 決定 ${r["決定"].hit}/${r["決定"].total} TODO ${r["TODO"].hit}/${r["TODO"].total}\n`);
    }
    process.stdout.write(`セッション: ${dir}\n`);
  } finally {
    owned.close();
  }
}
