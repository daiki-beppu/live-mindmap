// 保存したセッションを、発言の本文を読まずに数だけで調べる（Issue #186）。
// 第三者の会議のログは中身を表示しない決まりなので、出すのは件数・長さ・割合・音量だけにする。
// 使い方: node bench/sessionStats.ts <セッションのフォルダ、またはそれを並べたフォルダ>...
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Track } from "../src/core/index.ts";

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

// ログの 1 行 1 イベントを読む。壊れた行（書きかけの末尾など）は飛ばす
export function parseLog(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // 飛ばす
    }
  }
  return events;
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

export function sessionStats(events: readonly Record<string, unknown>[]): SessionStats {
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
      const r = e.remark as { track: Track; start: number; end: number };
      const t = stats.tracks[r.track];
      if (!t) continue;
      t.remarks += 1;
      t.duration += Math.max(0, r.end - r.start);
      intervals[r.track].push(r);
      stats.lastEnd = Math.max(stats.lastEnd, r.end);
    } else if (e.type === "diff") {
      stats.diffs += 1;
      if (e.error) stats.diffErrors += 1;
      stats.ops += Array.isArray(e.ops) ? e.ops.length : 0;
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
function trackAudio(dir: string, track: Track): Audio {
  const files = readdirSync(dir).filter((f) => f === `${track}.m4a` || (f.startsWith(`${track}-`) && f.endsWith(".m4a")));
  let seconds = 0;
  let meanDb: number | null = null;
  for (const f of files) {
    const log = runFfmpeg(join(dir, f));
    const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(log);
    const mean = /mean_volume: (-?[\d.]+) dB/.exec(log);
    if (!dur || !mean) continue;
    seconds = Math.max(seconds, Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]));
    if (f === `${track}.m4a` || meanDb === null) meanDb = Number(mean[1]);
  }
  return { files: files.length, seconds, meanDb };
}

// ffmpeg は長さと音量を stderr に出すので、sh で stdout にまとめて受け取る
function runFfmpeg(file: string): string {
  try {
    return execFileSync("sh", ["-c", 'ffmpeg -nostats -i "$1" -af volumedetect -f null - 2>&1', "sh", file], { encoding: "utf8" });
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? "");
  }
}

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

if (import.meta.main) {
  const args = process.argv.slice(2);
  const noAudio = args.includes("--no-audio");
  const paths = args.filter((a) => a !== "--no-audio");
  if (paths.length === 0) throw new Error("usage: sessionStats.ts <セッションのフォルダ、またはそれを並べたフォルダ>... [--no-audio]");
  for (const dir of paths.flatMap(sessionDirs)) {
    const stats = sessionStats(parseLog(readFileSync(join(dir, "log.jsonl"), "utf8")));
    const audio = noAudio ? null : { 相手: trackAudio(dir, "相手"), 自分: trackAudio(dir, "自分") };
    process.stdout.write(formatRow(basename(dir), stats, audio).join("\n") + "\n");
  }
}
