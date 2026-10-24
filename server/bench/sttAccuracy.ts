import { NodeRuntime } from "@effect/platform-node";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { TranscriptFile } from "../src/core/index.ts";
import { createRemarkSettler } from "../src/core/settle.ts";
import { exitNaturally } from "../src/exitNaturally.ts";
import { benchProgram, InvalidInputFile, inputFileError, readInputText, write } from "./entry.ts";
import { parseResults, type SttResult } from "./sttLatency.ts";

export type TimedText = { start: number; end: number; text: string };

export function parseTimeline(text: string): Array<TimedText & { speaker: string }> {
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length === 4 && !cols[0]!.startsWith("#"))
    .map(([speaker, start, end, body]) => ({ speaker: speaker!, start: Number(start), end: Number(end), text: body! }));
}

const DIGITS = "〇一二三四五六七八九";
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

export function kanjiToDigits(text: string): string {
  return text.replace(/[〇一二三四五六七八九十百千万]+/g, (run) => {
    if (!/[十百千万]/.test(run)) return Array.from(run, (c) => DIGITS.indexOf(c)).join("");
    let total = 0;
    let section = 0;
    let digit = -1;
    for (const c of run) {
      if (DIGITS.includes(c)) digit = DIGITS.indexOf(c);
      else if (c === "万") {
        total += (section + Math.max(digit, 0)) * 10000 || 10000;
        section = 0, digit = -1;
      } else {
        section += (digit < 0 ? 1 : digit) * UNITS[c]!;
        digit = -1;
      }
    }
    return String(total + section + Math.max(digit, 0));
  });
}

export const normalize = (text: string) => kanjiToDigits(text.normalize("NFKC").toLowerCase()).replace(/[\s\p{P}]/gu, "");

type Op = "eq" | "sub" | "del" | "ins";

const substitutionCost = (a: string | undefined, b: string | undefined) => (a === b ? 0 : 1);

function distanceTable(r: readonly string[], h: readonly string[]): Uint32Array {
  const w = h.length + 1;
  const d = new Uint32Array((r.length + 1) * w);
  for (let j = 0; j <= h.length; j++) d[j] = j;
  for (let i = 1; i <= r.length; i++) {
    d[i * w] = i;
    for (let j = 1; j <= h.length; j++) {
      const diag = d[(i - 1) * w + j - 1]! + substitutionCost(r[i - 1], h[j - 1]);
      d[i * w + j] = Math.min(diag, d[(i - 1) * w + j]! + 1, d[i * w + j - 1]! + 1);
    }
  }
  return d;
}

function backtrace(d: Uint32Array, r: readonly string[], h: readonly string[]): Op[] {
  const w = h.length + 1;
  const ops: Op[] = [];
  let i = r.length;
  let j = h.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * w + j] === d[(i - 1) * w + j - 1]! + substitutionCost(r[i - 1], h[j - 1])) {
      ops.push(r[i - 1] === h[j - 1] ? "eq" : "sub");
      i--, j--;
    } else if (i > 0 && d[i * w + j] === d[(i - 1) * w + j]! + 1) {
      ops.push("del");
      i--;
    } else {
      ops.push("ins");
      j--;
    }
  }
  return ops.reverse();
}

export function align(ref: string, hyp: string): Op[] {
  const r = Array.from(ref);
  const h = Array.from(hyp);
  return backtrace(distanceTable(r, h), r, h);
}

export function chunk(lines: readonly TimedText[], remarks: readonly TimedText[], seconds: number): { ref: string; hyp: string }[] {
  const cuts: number[] = [];
  let from = lines[0]?.start ?? 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i]!.end - from < seconds) continue;
    const t = (lines[i]!.end + lines[i + 1]!.start) / 2;
    if (remarks.some((r) => r.start < t && t < r.end)) continue;
    cuts.push(t);
    from = lines[i + 1]!.start;
  }
  const index = (t: number) => cuts.filter((c) => c <= t).length;
  const chunks = Array.from({ length: cuts.length + 1 }, () => ({ ref: "", hyp: "" }));
  for (const l of lines) chunks[index((l.start + l.end) / 2)]!.ref += normalize(l.text);
  for (const r of [...remarks].sort((a, b) => a.start - b.start)) chunks[index((r.start + r.end) / 2)]!.hyp += normalize(r.text);
  return chunks;
}

export type TermScore = { term: string; total: number; correct: number; kanaOnly: number; misses: Map<string, number> };
export type AccuracyScore = {
  refChars: number;
  sub: number;
  del: number;
  ins: number;
  terms: TermScore[];
  confusions: Map<string, number>;
};

const toHiragana = (text: string) => text.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

const TERM_SLACK = 2;

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

type ErrorRun = { ref: string; hyp: string };

function closeError(confusions: Map<string, number>, run: ErrorRun): void {
  if (run.ref || run.hyp) bump(confusions, `${run.ref || "∅"}→${run.hyp || "∅"}`);
  run.ref = run.hyp = "";
}

function extendError(run: ErrorRun, op: "sub" | "del" | "ins", refChar: string | undefined, hypChar: string | undefined): void {
  if (op === "sub" || op === "del") run.ref += refChar;
  if (op === "sub" || op === "ins") run.hyp += hypChar;
}

function countErrors(result: AccuracyScore, ops: readonly Op[], r: readonly string[], h: readonly string[]): number[] {
  const cursor: number[] = [];
  const run: ErrorRun = { ref: "", hyp: "" };
  let ri = 0;
  let hi = 0;
  for (const op of ops) {
    if (op !== "ins") cursor[ri] = hi;
    if (op === "eq") closeError(result.confusions, run);
    else {
      result[op]++;
      extendError(run, op, r[ri], h[hi]);
    }
    if (op !== "ins") ri++;
    if (op !== "del") hi++;
  }
  closeError(result.confusions, run);
  cursor[r.length] = h.length;
  return cursor;
}

function countOccurrence(t: TermScore, key: string, h: readonly string[], from: number, to: number): void {
  t.total++;
  const said = h.slice(from, to).join("");
  const around = h.slice(Math.max(0, from - TERM_SLACK), to + TERM_SLACK).join("");
  if (around.includes(key)) {
    t.correct++;
    return;
  }
  if (toHiragana(around).includes(toHiragana(key))) t.kanaOnly++;
  bump(t.misses, said || "∅");
}

function countTerms(byTerm: Iterable<TermScore>, r: readonly string[], h: readonly string[], cursor: readonly number[]): void {
  for (const t of byTerm) {
    const key = normalize(t.term);
    const len = Array.from(key).length;
    for (let p = 0; p + len <= r.length; p++) {
      if (r.slice(p, p + len).join("") !== key) continue;
      countOccurrence(t, key, h, cursor[p]!, cursor[p + len]!);
    }
  }
}

export function score(lines: readonly TimedText[], remarks: readonly TimedText[], terms: readonly string[], seconds = 30): AccuracyScore {
  const result: AccuracyScore = { refChars: 0, sub: 0, del: 0, ins: 0, terms: [], confusions: new Map() };
  const byTerm = new Map<string, TermScore>(terms.map((term) => [term, { term, total: 0, correct: 0, kanaOnly: 0, misses: new Map<string, number>() }]));
  for (const { ref, hyp } of chunk(lines, remarks, seconds)) {
    const r = Array.from(ref);
    const h = Array.from(hyp);
    const cursor = countErrors(result, align(ref, hyp), r, h);
    result.refChars += r.length;
    countTerms(byTerm.values(), r, h, cursor);
  }
  result.terms = [...byTerm.values()];
  return result;
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${((n / d) * 100).toFixed(1)}%`);
const top = (map: Map<string, number>, n: number) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

export function summarize(s: AccuracyScore, confusions = 15): string {
  const out: string[] = [];
  const errors = s.sub + s.del + s.ins;
  out.push("| 台本の文字数 | CER | 置換 | 脱落 | 挿入 |", "| --- | --- | --- | --- | --- |");
  out.push(`| ${s.refChars} | ${pct(errors, s.refChars)} | ${s.sub} | ${s.del} | ${s.ins} |`);
  if (s.terms.length > 0) {
    const total = s.terms.reduce((a, t) => a + t.total, 0);
    const correct = s.terms.reduce((a, t) => a + t.correct, 0);
    const kanaOnly = s.terms.reduce((a, t) => a + t.kanaOnly, 0);
    out.push("", `固有名詞・略語の正解率: ${pct(correct, total)}（${correct}/${total}）。かなの違いだけのもの: ${kanaOnly}`, "", "| 語 | 正解 | かな違い | 出現 | 崩れ方（件数） |", "| --- | --- | --- | --- | --- |");
    for (const t of [...s.terms].filter((t) => t.total > 0).sort((a, b) => a.correct / a.total - b.correct / b.total || b.total - a.total)) {
      out.push(`| ${t.term} | ${t.correct} | ${t.kanaOnly} | ${t.total} | ${top(t.misses, 4).map(([k, n]) => `${k}（${n}）`).join("、")} |`);
    }
  }
  out.push("", `多い食い違い（台本→発言、上位 ${confusions}）:`, "");
  for (const [k, n] of top(s.confusions, confusions)) out.push(`- ${k}（${n}）`);
  return out.join("\n") + "\n";
}

export function settleResults(results: readonly SttResult[]): TimedText[] {
  const settler = createRemarkSettler();
  const out: TimedText[] = [];
  const keep = (rs: readonly TimedText[]) => out.push(...rs.map(({ start, end, text }) => ({ start, end, text })));
  for (const r of [...results].sort((a, b) => a.arrival - b.arrival)) {
    if (r.isFinal) keep(settler.final({ track: r.track, start: r.start, end: r.end, text: r.text }));
    else keep(settler.partial({ track: r.track, start: r.start, end: r.end, text: r.text, duplicate: false }));
  }
  keep(settler.drain());
  return out;
}

const readRemarks = Effect.fnUntraced(function* (path: string, settle: boolean) {
  const text = yield* readInputText(path);
  if (path.endsWith(".json")) {
    if (settle) return yield* Effect.fail(new InvalidInputFile({ path, reason: "--settle は stt-bench run の JSONL にだけ使えます" }));
    const file = yield* Schema.decodeEffect(Schema.fromJsonString(TranscriptFile))(text).pipe(Effect.mapError(inputFileError(path)));
    return file.transcript.segments.map((s) => ({ start: s.start_seconds, end: s.end_seconds, text: s.text }));
  }
  const results = yield* parseResults(text).pipe(Effect.mapError(inputFileError(path)));
  if (settle) return settleResults(results);
  return results.filter((r) => r.isFinal).map(({ start, end, text }) => ({ start, end, text }));
});

export const command = Command.make(
  "sttAccuracy",
  {
    timeline: Argument.String("timeline").pipe(Argument.withDescription("合成会議の timeline.tsv（台本の行と時刻。正解）")),
    remarks: Argument.String("remarks").pipe(Argument.withDescription("stt-bench run の出力（JSONL）か、kanary transcribe の JSON")),
    terms: Flag.File("terms").pipe(Flag.withDescription("固有名詞・略語の正しい表記を 1 行 1 語で並べたファイル"), Flag.optional),
    settle: Flag.Boolean("settle").pipe(Flag.withDescription("JSONL の途中結果と確定結果を、本番と同じ settle（関所つき）に通して出た発言で採点する"), Flag.withDefault(false)),
    window: Flag.Finite("window").pipe(Flag.withDescription("突き合わせる区切りの最短の秒数"), Flag.withDefault(30)),
  },
  Effect.fn("sttAccuracy")(function* ({ remarks, settle, terms, timeline, window }) {
    const lines = parseTimeline(yield* readInputText(timeline));
    const said = yield* readRemarks(remarks, settle);
    const words = Option.isNone(terms) ? [] : (yield* readInputText(terms.value)).split("\n").map((l) => l.trim()).filter(Boolean);
    yield* write(summarize(score(lines, said, words, window)));
  }),
).pipe(Command.withDescription("発言を合成会議の台本と突き合わせ、CER と固有名詞・略語の正解率、多い食い違いを出す"));

if (import.meta.main) {
  benchProgram(command).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
