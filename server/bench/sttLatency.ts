// 音声認識の確定の遅れの集計と、本番の区切り方（core の createRemarkSettler）で作った発言の遅れの計算（Issue #97、#1079）。
// 入力は `stt-bench run` の出力（1 行 1 結果の JSONL）。
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { createRemarkSettler, SETTLE_QUIET_MS, Track } from "../src/core/index.ts";
import { exitNaturally } from "../src/exitNaturally.ts";
import { benchProgram, inputFileError, readInputText, readJsonFile, write } from "./entry.ts";

// arrival は流し始めを 0 とする壁時計の秒、start / end は音声ファイルの秒
export const SttResult = Schema.Struct({ track: Track, arrival: Schema.Finite, isFinal: Schema.Boolean, start: Schema.Finite, end: Schema.Finite, text: Schema.String });
export type SttResult = typeof SttResult["Type"];

export type SettledRemark = { id: string; track: Track; start: number; end: number; text: string; at: number; source?: "final" };

// 1 行 1 結果。壊れた行・形が違う行は飛ばさず、SchemaError で失敗する
export function parseResults(text: string) {
  return Effect.forEach(
    text.split("\n").filter((line) => line.trim() !== ""),
    (line) => Schema.decodeEffect(Schema.fromJsonString(SttResult))(line),
  );
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

const EPSILON = 1e-6;

// 本番の規則の時計を進める刻み（ミリ秒）。規則の期限は結果が届く間に来るので、刻みごとに拾って出た時刻にする。誤差は刻み以下
const CLOCK_STEP_MS = 10;

// 途中結果と確定結果を、届いた時刻の順（同時刻はファイルの順）に本番の createRemarkSettler へ通して出た発言。ID は出た順に r1, r2, …
// 規則の時計は届いた結果の end（音声の時刻）でしか進まないので、届いた時刻（arrival）へは、自分の途中結果（発言にならず時計だけ進む）で進める。
// 区切り方（期限・文の終わり・出した分の後ろだけ・自分の扱い）は core の規則が決める。ここでは写さない
export function settledRemarks(results: readonly SttResult[], quietSeconds: number): SettledRemark[] {
  const settler = createRemarkSettler(quietSeconds * 1000);
  const out: SettledRemark[] = [];
  const keep = (remarks: readonly { track: Track; start: number; end: number; text: string }[], atMs: number) => {
    for (const r of remarks) out.push({ id: `r${out.length + 1}`, track: r.track, start: r.start, end: r.end, text: r.text, at: atMs / 1000 });
  };
  // 時計を ms まで進める。*1000 で ms に届かない丸め誤差は、1 ulp ずつ上げて消す
  const tick = (ms: number) => {
    let end = ms / 1000;
    while (end * 1000 < ms) end *= 1 + Number.EPSILON;
    return settler.partial({ track: "自分", start: 0, end, text: "", duplicate: false });
  };
  const ordered = results.map((r, i) => ({ r, i })).sort((a, b) => a.r.arrival - b.r.arrival || a.i - b.i).map(({ r }) => r);
  // 規則の時計は 0 から始まるので、最初の結果が届く時刻まで、一度に進める（それまでは何も出ない）
  let clockMs = ordered.length === 0 ? 0 : Math.round(ordered[0]!.arrival * 1000);
  tick(clockMs);
  const advanceTo = (targetMs: number) => {
    while (clockMs < targetMs) {
      clockMs = Math.min(clockMs + CLOCK_STEP_MS, targetMs);
      keep(tick(clockMs), clockMs);
    }
  };
  for (const r of ordered) {
    const arrivalMs = Math.round(r.arrival * 1000);
    advanceTo(arrivalMs);
    keep(
      r.isFinal
        ? settler.final({ track: r.track, start: r.start, end: r.end, text: r.text })
        : settler.partial({ track: r.track, start: r.start, end: r.end, text: r.text, duplicate: false }),
      arrivalMs,
    );
  }
  if (ordered.length > 0) {
    advanceTo(clockMs + Math.round(quietSeconds * 1000));
    keep(settler.drain(), clockMs);
  }
  return out;
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
export const SpokenLine = Schema.Struct({ start: Schema.Finite, end: Schema.Finite });
export type SpokenLine = typeof SpokenLine["Type"];
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

// lines を渡すと、確定結果の end ではなく、各文の話し終わりから数えた遅れ（lineDelays）を出す
export function summarize(results: SttResult[], quietSeconds: number, lines?: readonly SpokenLine[]): string {
  const rows: string[][] = [["方式", "件数", "遅れ p50 (秒)", "遅れ p90 (秒)"]];
  const row = (name: string, delays: number[]) => rows.push([name, String(delays.length), fmt(percentile(delays, 0.5)), fmt(percentile(delays, 0.9))]);
  const finals = results.filter((r) => r.isFinal);
  row("確定結果（現状）", lines ? lineDelays(lines, finals.map((r) => ({ start: r.start, end: r.end, at: r.arrival }))) : finalDelays(results));
  const remarks = settledRemarks(results, quietSeconds);
  row(`途中結果を本番の区切り方で（静かな間 ${quietSeconds} 秒）`, lines ? lineDelays(lines, remarks) : remarks.map((r) => r.at - r.end));
  return rows.map((r) => `| ${r.join(" | ")} |`).join("\n") + "\n";
}

// 使い方は各 Command・Flag の withDescription が正本で、`node bench/sttLatency.ts --help` で読む
export const command = Command.make(
  "sttLatency",
  {
    file: Argument.String("results").pipe(Argument.withDescription("stt-bench run の出力（1 行 1 結果の JSONL）")),
    quiet: Flag.Finite("quiet").pipe(
      Flag.withDescription("本番の区切り方の、途中結果が変わらなければ発言にする秒数（既定は本番の定数）"),
      Flag.withDefault(SETTLE_QUIET_MS / 1000),
    ),
    emit: Flag.Literals("emit", ["final", "discard"]).pipe(
      Flag.withDescription("表の代わりに、発言（sttReplay.ts 用の JSON）を出す。final は確定結果だけ、discard は本番の区切り方で作る"),
      Flag.optional,
    ),
    lines: Flag.File("lines").pipe(
      Flag.withDescription("行の時刻の JSON。渡すと、確定結果の end ではなく各文の話し終わりから数えた遅れを出す"),
      Flag.optional,
    ),
  },
  Effect.fn("sttLatency")(function* ({ emit, file, lines, quiet }) {
    const results = yield* parseResults(yield* readInputText(file)).pipe(Effect.mapError(inputFileError(file)));
    if (Option.isSome(emit)) {
      const remarks = emit.value === "final" ? finalRemarks(results) : settledRemarks(results, quiet);
      yield* write(JSON.stringify(remarks) + "\n");
      return;
    }
    const spoken = Option.isNone(lines) ? undefined : yield* readJsonFile(lines.value, Schema.Array(SpokenLine));
    yield* write(summarize(results, quiet, spoken));
  }),
).pipe(
  Command.withDescription("音声認識の確定の遅れを集計し、確定結果と、本番の区切り方で作った発言の遅れを表で出す"),
);

if (import.meta.main) {
  benchProgram(command).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
