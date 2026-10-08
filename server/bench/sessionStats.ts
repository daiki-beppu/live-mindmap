// 保存したセッションを、発言の本文を読まずに数だけで調べる（Issue #186）。
// 第三者の会議のログは中身を表示しない決まりなので、出すのは件数・長さ・割合・音量だけにする。
// 使い方は各 Command・Flag の withDescription が正本で、`node bench/sessionStats.ts --help` で読む。
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Schema, Stream, type PlatformError } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Track } from "../src/core/index.ts";
import { describe } from "../src/truthFile.ts";
import { BENCH_VERSION, MissingSessionDir, readInputText, reportFailure, write } from "./entry.ts";

const TRACKS: readonly Track[] = ["相手", "自分"];

export type TrackStats = {
  remarks: number;
  duration: number; // 発言の長さ（end - start）の合計。秒
  overlap: number; // 発言のある時間のうち、2 つ以上の発言が重なっている時間の割合（0〜1）。1 人分のトラックなら小さい
};

export type SessionStats = {
  tracks: Record<Track, TrackStats>;
  lastEnd: number; // 発言の end の最大値。秒
  diffs: number;
  diffErrors: number;
  ops: number;
  intake: { stopped: number; restarted: number; gaveUp: number };
};

type Interval = { start: number; end: number };

// ログの 1 行。数える欄だけを任意で持つ緩い形（古いログ・intake-* の行・input の無い diff の行も数える）。
// 段 1 の LogEvent は start・remark・diff の 3 種で必須欄が厳しいので、ここでは使わない
const LogLine = Schema.Struct({
  type: Schema.String,
  remark: Schema.optionalKey(Schema.Struct({ track: Track, start: Schema.Finite, end: Schema.Finite })),
  ops: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  error: Schema.optionalKey(Schema.Unknown),
});
export type LogLine = typeof LogLine["Type"];

const decodeLogLine = Schema.decodeEffect(Schema.fromJsonString(LogLine));

// ログの 1 行 1 イベントを読む。壊れた行（書きかけの末尾など）と形が合わない行は飛ばす
export function parseLog(text: string) {
  return Effect.forEach(
    text.split("\n").filter((line) => line.trim() !== ""),
    (line) => decodeLogLine(line).pipe(Effect.map((event) => [event]), Effect.orElseSucceed(() => [] as LogLine[])),
  ).pipe(Effect.map((lines) => lines.flat()));
}

// 2 つ以上の発言が重なっている時間 / 1 つ以上の発言がある時間
export function overlapRatio(intervals: readonly Interval[]): number {
  const edges = intervals.flatMap((r) => (r.end > r.start ? [{ at: r.start, d: 1 }, { at: r.end, d: -1 }] : []));
  edges.sort((a, b) => a.at - b.at || a.d - b.d); // 同じ時刻では閉じるほうを先に（接しているだけは重なりにしない）
  let depth = 0;
  let prev = 0;
  let covered = 0;
  let doubled = 0;
  for (const e of edges) {
    const span = e.at - prev;
    if (depth >= 1) covered += span;
    if (depth >= 2) doubled += span;
    depth += e.d;
    prev = e.at;
  }
  return covered === 0 ? 0 : doubled / covered;
}

export function sessionStats(events: readonly LogLine[]): SessionStats {
  const intervals: Record<Track, Interval[]> = { 相手: [], 自分: [] };
  const stats: SessionStats = {
    tracks: { 相手: { remarks: 0, duration: 0, overlap: 0 }, 自分: { remarks: 0, duration: 0, overlap: 0 } },
    lastEnd: 0,
    diffs: 0,
    diffErrors: 0,
    ops: 0,
    intake: { stopped: 0, restarted: 0, gaveUp: 0 },
  };
  for (const e of events) {
    if (e.type === "remark") {
      const r = e.remark;
      if (!r) continue;
      const t = stats.tracks[r.track];
      t.remarks += 1;
      t.duration += Math.max(0, r.end - r.start);
      intervals[r.track].push(r);
      stats.lastEnd = Math.max(stats.lastEnd, r.end);
    } else if (e.type === "diff") {
      stats.diffs += 1;
      if (e.error) stats.diffErrors += 1;
      stats.ops += e.ops?.length ?? 0;
    } else if (e.type === "intake-stopped") stats.intake.stopped += 1;
    else if (e.type === "intake-restarted") stats.intake.restarted += 1;
    else if (e.type === "intake-gave-up") stats.intake.gaveUp += 1;
  }
  for (const track of TRACKS) stats.tracks[track].overlap = overlapRatio(intervals[track]);
  return stats;
}

// セッションのフォルダ（log.jsonl がある）を集める。並べたフォルダを渡されたら、その下を全部
export function sessionDirs(path: string): string[] {
  if (existsSync(join(path, "log.jsonl"))) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(path, d.name, "log.jsonl")))
    .map((d) => join(path, d.name))
    .sort();
}

// 録音（相手.m4a・相手-2.m4a …）の長さの最大と、平均音量。読めないファイル（強制終了で閉じていない録音）は飛ばす
type Audio = { files: number; seconds: number; meanDb: number | null };
const trackAudio = Effect.fnUntraced(function* (dir: string, track: Track) {
  const files = readdirSync(dir).filter((f) => f === `${track}.m4a` || (f.startsWith(`${track}-`) && f.endsWith(".m4a")));
  let seconds = 0;
  let meanDb: number | null = null;
  for (const f of files) {
    const log = yield* runFfmpeg(join(dir, f));
    const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(log);
    const mean = /mean_volume: (-?[\d.]+) dB/.exec(log);
    if (!dur || !mean) continue;
    seconds = Math.max(seconds, Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]));
    if (f === `${track}.m4a` || meanDb === null) meanDb = Number(mean[1]);
  }
  return { files: files.length, seconds, meanDb } satisfies Audio;
});

// ffmpeg は長さと音量を stderr に出すので、stdout と stderr をまとめて受け取る。
// ffmpeg が無い・失敗したときは空の出力として扱う（呼び出し側が、読めない録音として飛ばす）
const runFfmpeg = Effect.fnUntraced(function* (file: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const readText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => Stream.mkString(Stream.decodeText(stream));
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("ffmpeg", ["-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { stdin: "ignore" }),
      );
      const [stdout, stderr] = yield* Effect.all([readText(handle.stdout), readText(handle.stderr), handle.exitCode], { concurrency: "unbounded" });
      return stdout + stderr;
    }),
  );
}, Effect.catchTag("PlatformError", () => Effect.succeed("")));

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatRow(name: string, s: SessionStats, audio: Record<Track, Audio> | null): string[] {
  const length = Math.max(s.lastEnd, audio ? Math.max(audio.相手.seconds, audio.自分.seconds) : 0);
  const head = `${name}\t長さ ${Math.round(length)}s\t差分更新 ${s.diffs}（失敗 ${s.diffErrors}）\t操作 ${s.ops}\t途切れ ${s.intake.stopped}・再開 ${s.intake.restarted}・断念 ${s.intake.gaveUp}`;
  const rows = TRACKS.map((track) => {
    const t = s.tracks[track];
    const a = audio?.[track];
    const audioCol = a ? `\t録音 ${a.files} 本・${a.meanDb === null ? "読めない" : `${a.meanDb.toFixed(1)} dB`}` : "";
    return `  ${track}\t発言 ${t.remarks}\t合計 ${Math.round(t.duration)}s（長さの ${length ? pct(t.duration / length) : "-"}）\t重なり ${pct(t.overlap)}${audioCol}`;
  });
  return [head, ...rows];
}

export const command = Command.make(
  "sessionStats",
  {
    paths: Argument.String("session").pipe(
      Argument.withDescription("セッションのフォルダ、またはそれを並べたフォルダ（log.jsonl があるフォルダを全部数える）"),
      Argument.atLeast(1),
    ),
    noAudio: Flag.Boolean("no-audio").pipe(
      Flag.withDescription("録音（ffmpeg）を読まず、ログだけで数える"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("sessionStats")(function* ({ noAudio, paths }) {
    // 出力の前に全てのパスを解決する（途中のパスが無ければ、何も出さずに失敗する）
    const dirs = (yield* Effect.forEach(paths, (path) =>
      Effect.try({ try: () => sessionDirs(path), catch: (e) => new MissingSessionDir({ path, reason: describe(e) }) }),
    )).flat();
    for (const dir of dirs) {
      const stats = sessionStats(yield* parseLog(yield* readInputText(join(dir, "log.jsonl"))));
      const audio = noAudio ? null : { 相手: yield* trackAudio(dir, "相手"), 自分: yield* trackAudio(dir, "自分") };
      yield* write(formatRow(basename(dir), stats, audio).join("\n") + "\n");
    }
  }),
).pipe(
  Command.withDescription(
    "保存したセッションを、発言の本文を読まずに数だけで調べる（件数・長さ・割合・音量だけを出す。第三者の会議のログは中身を表示しない決まり。Issue #186）",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: BENCH_VERSION }).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
