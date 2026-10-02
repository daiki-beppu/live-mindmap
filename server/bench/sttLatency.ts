// 音声認識の確定の遅れの集計と、「途中結果が T 秒変わらなければ確定として扱う」案の計算（Issue #97）。
// 入力は `stt-bench run` の出力（1 行 1 結果の JSONL）。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Track } from "../src/core/index.ts";

// arrival は流し始めを 0 とする壁時計の秒、start / end は音声ファイルの秒
export type SttResult = { track: Track; arrival: number; isFinal: boolean; start: number; end: number; text: string };

export type RemarkSource = "stable" | "final" | "correction";
export type SettledRemark = { id: string; track: Track; start: number; end: number; text: string; at: number; source: RemarkSource };

// 確定結果が、途中結果から出した発言を出し終えた後に届いたときの扱い。
// discard: 出した発言を残し、確定結果は流さない。correct: 確定結果を、訂正の発言として 1 件流す。
export type LateFinal = "discard" | "correct";
export type SettleOptions = { quietSeconds: number; lateFinal: LateFinal };

export function parseResults(text: string): SttResult[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SttResult);
}

// 確定までの遅れ: 確定結果が届いた時刻 − 発言の end
export function finalDelays(results: SttResult[]): number[] {
  return results.filter((r) => r.isFinal).map((r) => r.arrival - r.end);
}

// 整列した値の floor(p × 件数) 番目。最大を超えない。空なら NaN。入力は並べ替えない
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

// 本文の比較では、句読点と空白の違いを無視する（確定結果は句読点が付く）
const normalize = (text: string) => text.replace(/[\s、。，．,.!?！？]/g, "");

// 区間が同じ発話の途中結果: 同じトラックで start が同じもの
type Utterance = { track: Track; start: number; end: number; text: string; lastArrival: number; closedBy?: SttResult; consumed: boolean };

const EPSILON = 1e-6;
// 途中結果の区間は、確定結果の区間と端がずれる（実測: 途中結果の start は直前の確定の end、確定の start はそれより遅い）。
// そのため、発話の区間の中央が確定結果の区間に入るかで、確定結果が覆う発話を決める
const midpoint = (u: Utterance) => (u.start + u.end) / 2;

// 途中結果が T 秒変わらなければ、最後の本文・区間で発言にする。
// - 発話 = 同じトラックで start が同じ途中結果の列（本文が変わっても同じ発話の更新）。更新の間隔が T 以内の間は続き、最後の途中結果の arrival + T に出す。間隔が T を超えたら、そこで出して、後の途中結果は別の発話にする
// - 確定結果は、同じトラックで区間の中央が確定結果の区間に入る発話を覆う
// - 覆われる発話の T が満ちる前（arrival <= 最後の arrival + T）に確定が届けば、途中結果からは出さず、確定結果を届いた時刻に 1 件出す
// - 覆われる発話のどれかが先に出ていれば、確定は後から届いたもの。本文（句読点・空白を除く）が出した発言の連結と違えば、
//   1 件の上書きとして数える。lateFinal が "correct" なら、確定結果を訂正として届いた時刻に 1 件流す
//   （先に出した発言の一部だけが覆われ、残りの発話が T 前だったときは、その発話を確定の届いた時刻に出す）
// - ID は、出した時刻の順（同時刻は作った順）に r1, r2, …
export function settleVolatile(results: SttResult[], { quietSeconds, lateFinal }: SettleOptions): { remarks: SettledRemark[]; overwritten: number } {
  const ordered = results.map((r, i) => ({ r, i })).sort((a, b) => a.r.arrival - b.r.arrival || a.i - b.i).map(({ r }) => r);

  // 発話 = 同じトラックで start が同じ途中結果の列。ただし、更新の間隔が T を超えたところで、その時点の本文は出されるので、
  // そこで列を分ける（後の途中結果は、同じ start の別の発話として数える）。
  // 結果は届いた順に処理する。確定結果は、それまでに届いた途中結果の発話だけを覆い、後から届く途中結果は新しい発話になる
  const utterances: Utterance[] = [];
  const open = new Map<string, Utterance>();
  const settleAt = (u: Utterance) => u.lastArrival + quietSeconds;

  type Pending = Omit<SettledRemark, "id">;
  const out: Pending[] = [];
  let overwritten = 0;

  for (const r of ordered) {
    if (!r.isFinal) {
      const key = `${r.track}\u0000${r.start}`;
      const current = open.get(key);
      if (current && r.arrival - current.lastArrival <= quietSeconds) {
        Object.assign(current, { end: r.end, text: r.text, lastArrival: r.arrival });
        continue;
      }
      const next: Utterance = { track: r.track, start: r.start, end: r.end, text: r.text, lastArrival: r.arrival, consumed: false };
      utterances.push(next);
      open.set(key, next);
      continue;
    }
    const f = r;
    const covered = utterances.filter(
      (u) => !u.consumed && u.track === f.track && midpoint(u) >= f.start - EPSILON && midpoint(u) <= f.end + EPSILON,
    );
    covered.forEach((u) => {
      u.consumed = true;
      open.delete(`${u.track}\u0000${u.start}`);
    });
    const emittedBefore = covered.filter((u) => settleAt(u) < f.arrival);
    if (emittedBefore.length === 0) {
      out.push({ track: f.track, start: f.start, end: f.end, text: f.text, at: f.arrival, source: "final" });
      continue;
    }
    for (const u of covered) {
      if (settleAt(u) < f.arrival) out.push({ track: u.track, start: u.start, end: u.end, text: u.text, at: settleAt(u), source: "stable" });
      else out.push({ track: u.track, start: u.start, end: u.end, text: u.text, at: f.arrival, source: "stable" });
    }
    // 同じ start の発話（更新の間隔で分けたもの）は本文が積み上がるので、最後の本文だけを使う
    const lastByStart = new Map(covered.map((u) => [u.start, u.text]));
    if (normalize([...lastByStart.values()].join("")) === normalize(f.text)) continue;
    overwritten++;
    if (lateFinal === "correct") out.push({ track: f.track, start: f.start, end: f.end, text: f.text, at: f.arrival, source: "correction" });
  }
  // 確定結果に覆われなかった発話は、T が満ちた時刻に出す
  for (const u of utterances) {
    if (!u.consumed) out.push({ track: u.track, start: u.start, end: u.end, text: u.text, at: settleAt(u), source: "stable" });
  }
  return { remarks: out.map((p, i) => ({ p, i })).sort((a, b) => a.p.at - b.p.at || a.i - b.i).map(({ p }, n) => ({ id: `r${n + 1}`, ...p })), overwritten };
}

// 現状: 確定結果だけを、届いた時刻に発言として流す（ID は届いた順の連番）
export function finalRemarks(results: SttResult[]): SettledRemark[] {
  return results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.isFinal)
    .sort((a, b) => a.r.arrival - b.r.arrival || a.i - b.i)
    .map(({ r }, n) => ({ id: `r${n + 1}`, track: r.track, start: r.start, end: r.end, text: r.text, at: r.arrival, source: "final" as const }));
}

// 話し終わり → 届く: 合成した各行について、行の区間の中央を覆う発言（出した時刻 at）のうち最初のものが届くまでの時間 − 行の end。
// 確定結果が複数の文をまとめて 1 件にするので、確定結果の end ではなく、各文の話し終わりから数える。覆う発言がない行は数えない
export type SpokenLine = { start: number; end: number };
export type Arrival = { start: number; end: number; at: number };
export function lineDelays(lines: readonly SpokenLine[], arrivals: readonly Arrival[]): number[] {
  const delays: number[] = [];
  for (const line of lines) {
    const mid = (line.start + line.end) / 2;
    const ats = arrivals.filter((a) => a.start - EPSILON <= mid && mid <= a.end + EPSILON).map((a) => a.at);
    if (ats.length > 0) delays.push(Math.min(...ats) - line.end);
  }
  return delays;
}

// ID から発言を引く。同じ ID が 2 件あれば例外（ぶつかったまま遅れを数えない）
export function indexRemarks<T extends { id: string }>(remarks: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const r of remarks) {
    if (byId.has(r.id)) throw new Error(`発言の ID が重複している: ${r.id}`);
    byId.set(r.id, r);
  }
  return byId;
}

const fmt = (x: number) => (Number.isNaN(x) ? "" : x.toFixed(1));

// 使い方: node bench/sttLatency.ts <結果.jsonl> [--quiet T] [--lines <行の時刻.json>]（確定の遅れと、途中結果から出した場合の遅れ・上書き件数を表で出す）
// --emit <規則> を付けると、その規則の発言（replay 用）を JSON で出す
// lines を渡すと、確定結果の end ではなく、各文の話し終わりから数えた遅れ（lineDelays）を出す
export function summarize(results: SttResult[], quietSeconds: number, lines?: readonly SpokenLine[]): string {
  const rows: string[][] = [["方式", "件数", "遅れ p50 (秒)", "遅れ p90 (秒)", "上書き"]];
  const row = (name: string, delays: number[], overwritten: string) =>
    rows.push([name, String(delays.length), fmt(percentile(delays, 0.5)), fmt(percentile(delays, 0.9)), overwritten]);
  const finals = results.filter((r) => r.isFinal);
  row("確定結果（現状）", lines ? lineDelays(lines, finals.map((r) => ({ start: r.start, end: r.end, at: r.arrival }))) : finalDelays(results), "");
  for (const lateFinal of ["discard", "correct"] as const) {
    const { remarks, overwritten } = settleVolatile(results, { quietSeconds, lateFinal });
    const counted = remarks.filter((r) => r.source !== "correction");
    row(`途中結果が ${quietSeconds} 秒変わらなければ（${lateFinal}）`, lines ? lineDelays(lines, counted) : counted.map((r) => r.at - r.end), String(overwritten));
  }
  return rows.map((r) => `| ${r.join(" | ")} |`).join("\n") + "\n";
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { quiet: { type: "string", default: "2" }, emit: { type: "string" }, lines: { type: "string" } } });
  const file = positionals[0];
  if (!file) throw new Error("usage: sttLatency.ts <結果.jsonl> [--quiet <秒>] [--lines <行の時刻.json>] [--emit final|discard|correct]");
  const results = parseResults(readFileSync(file, "utf8"));
  const quietSeconds = Number(values.quiet);
  if (values.emit) {
    if (values.emit !== "final" && values.emit !== "discard" && values.emit !== "correct") throw new Error("--emit は final か discard か correct");
    const remarks = values.emit === "final" ? finalRemarks(results) : settleVolatile(results, { quietSeconds, lateFinal: values.emit }).remarks;
    process.stdout.write(JSON.stringify(remarks) + "\n");
  } else {
    process.stdout.write(summarize(results, quietSeconds, values.lines ? (JSON.parse(readFileSync(values.lines, "utf8")) as SpokenLine[]) : undefined));
  }
}
