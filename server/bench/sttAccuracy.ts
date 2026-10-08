// 字幕の精度の計測（Issue #390）。発言（確定した文字起こし）を、合成会議の台本（timeline.tsv）と突き合わせ、
// 文字誤り率（CER）と、固有名詞・略語の正解率を出す。
// 発言は `stt-bench run` の出力（1 行 1 結果の JSONL。確定結果だけを使う）か、kanary transcribe の JSON（拡張子 .json）。
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { TranscriptFile } from "../src/core/index.ts";
import { BENCH_VERSION, inputFileError, readInputText, reportFailure, write } from "./entry.ts";
import { parseResults } from "./sttLatency.ts";

// 台本の 1 行（話者・開始秒・終了秒・文）。発言は区間と本文だけを見る
export type TimedText = { start: number; end: number; text: string };

// timeline.tsv（synth.mjs の出力）。#MARK の行は時刻だけなので飛ばす
export function parseTimeline(text: string): TimedText[] {
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length === 4 && !cols[0]!.startsWith("#"))
    .map(([, start, end, body]) => ({ start: Number(start), end: Number(end), text: body! }));
}

const DIGITS = "〇一二三四五六七八九";
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

// 漢数字の並びを算用数字にする（「九十日」→「90日」、「三四半期」→「34半期」）。台本は漢数字、確定結果は算用数字で書くことが多く、
// この違いを誤りに数えると CER が表記の違いで埋まる。両側に同じ変換をかけるので、「一緒」→「1緒」のような語の中の漢字もそろう
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

// 比べる前に、全角・半角と大文字・小文字、漢数字をそろえ、句読点・記号の括弧・空白を外す（確定結果は句読点の付け方が台本と違う）
export const normalize = (text: string) => kanjiToDigits(text.normalize("NFKC").toLowerCase()).replace(/[\s\p{P}]/gu, "");

type Op = "eq" | "sub" | "del" | "ins";

// 編集距離の最短の手順。ref の各文字が eq・sub・del のどれか 1 つ、hyp の余りが ins になる
export function align(ref: string, hyp: string): Op[] {
  const r = Array.from(ref);
  const h = Array.from(hyp);
  const w = h.length + 1;
  const d = new Uint32Array((r.length + 1) * w);
  for (let j = 0; j <= h.length; j++) d[j] = j;
  for (let i = 1; i <= r.length; i++) {
    d[i * w] = i;
    for (let j = 1; j <= h.length; j++) {
      const diag = d[(i - 1) * w + j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1);
      d[i * w + j] = Math.min(diag, d[(i - 1) * w + j]! + 1, d[i * w + j - 1]! + 1);
    }
  }
  const ops: Op[] = [];
  let i = r.length;
  let j = h.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * w + j] === d[(i - 1) * w + j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1)) {
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

// 長い会議を 1 回で突き合わせると表が大きすぎるので、区切りで分けてから突き合わせる。
// 区切りは台本の行の間（前の行の終わりと次の行の始まりの中点）で、どの発言の区間もまたがない所だけにする。
// 発言は区間の中央が入る区切りに入れる
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

// kanaOnly は、正しい表記ではないが、ひらがな・カタカナの違いだけのもの（「ユズ」→「ゆず」）。correct には入れない
export type TermScore = { term: string; total: number; correct: number; kanaOnly: number; misses: Map<string, number> };
export type AccuracyScore = {
  refChars: number;
  sub: number;
  del: number;
  ins: number;
  terms: TermScore[];
  confusions: Map<string, number>; // 「台本の文字列→発言の文字列」の食い違いの件数
};

// カタカナをひらがなにそろえる（長音はそのまま）
const toHiragana = (text: string) => text.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// 語の前後にこれだけの文字のずれを許して、正しい表記が発言に出たかを見る（近くの誤りで並びが 1〜2 文字ずれるため）
const TERM_SLACK = 2;

export function score(lines: readonly TimedText[], remarks: readonly TimedText[], terms: readonly string[], seconds = 30): AccuracyScore {
  const result: AccuracyScore = { refChars: 0, sub: 0, del: 0, ins: 0, terms: [], confusions: new Map() };
  const byTerm = new Map(terms.map((term) => [term, { term, total: 0, correct: 0, kanaOnly: 0, misses: new Map<string, number>() }]));
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const { ref, hyp } of chunk(lines, remarks, seconds)) {
    const r = Array.from(ref);
    const h = Array.from(hyp);
    const ops = align(ref, hyp);
    // cursor[p] は、台本の p 文字目を見る直前までに使った発言の文字数（p = r.length は末尾）
    const cursor: number[] = [];
    let ri = 0;
    let hi = 0;
    let errRef = "";
    let errHyp = "";
    const closeError = () => {
      if (errRef || errHyp) bump(result.confusions, `${errRef || "∅"}→${errHyp || "∅"}`);
      errRef = errHyp = "";
    };
    for (const op of ops) {
      if (op !== "ins") cursor[ri] = hi;
      if (op === "eq") closeError();
      else result[op]++;
      if (op === "sub" || op === "del") errRef += r[ri];
      if (op === "sub" || op === "ins") errHyp += h[hi];
      if (op !== "ins") ri++;
      if (op !== "del") hi++;
    }
    closeError();
    cursor[r.length] = h.length;
    result.refChars += r.length;
    const chars = (s: string) => Array.from(s);
    for (const t of byTerm.values()) {
      const key = normalize(t.term);
      const len = chars(key).length;
      for (let p = 0; p + len <= r.length; p++) {
        if (r.slice(p, p + len).join("") !== key) continue;
        t.total++;
        const said = h.slice(cursor[p], cursor[p + len]).join("");
        const around = h.slice(Math.max(0, cursor[p]! - TERM_SLACK), cursor[p + len]! + TERM_SLACK).join("");
        if (around.includes(key)) {
          t.correct++;
          continue;
        }
        if (toHiragana(around).includes(toHiragana(key))) t.kanaOnly++;
        bump(t.misses, said || "∅");
      }
    }
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

// 発言のファイル。.json なら kanary transcribe の出力、それ以外は stt-bench run の JSONL の確定結果
const readRemarks = (path: string) =>
  Effect.gen(function* () {
    const text = yield* readInputText(path);
    if (path.endsWith(".json")) {
      const file = yield* Schema.decodeEffect(Schema.fromJsonString(TranscriptFile))(text).pipe(Effect.mapError(inputFileError(path)));
      return file.transcript.segments.map((s) => ({ start: s.start_seconds, end: s.end_seconds, text: s.text }));
    }
    const results = yield* parseResults(text).pipe(Effect.mapError(inputFileError(path)));
    return results.filter((r) => r.isFinal).map(({ start, end, text }) => ({ start, end, text }));
  });

export const command = Command.make(
  "sttAccuracy",
  {
    timeline: Argument.String("timeline").pipe(Argument.withDescription("合成会議の timeline.tsv（台本の行と時刻。正解）")),
    remarks: Argument.String("remarks").pipe(Argument.withDescription("stt-bench run の出力（JSONL）か、kanary transcribe の JSON")),
    terms: Flag.File("terms").pipe(Flag.withDescription("固有名詞・略語の正しい表記を 1 行 1 語で並べたファイル"), Flag.optional),
    window: Flag.Finite("window").pipe(Flag.withDescription("突き合わせる区切りの最短の秒数"), Flag.withDefault(30)),
  },
  Effect.fn("sttAccuracy")(function* ({ remarks, terms, timeline, window }) {
    const lines = parseTimeline(yield* readInputText(timeline));
    const said = yield* readRemarks(remarks);
    const words = Option.isNone(terms) ? [] : (yield* readInputText(terms.value)).split("\n").map((l) => l.trim()).filter(Boolean);
    yield* write(summarize(score(lines, said, words, window)));
  }),
).pipe(Command.withDescription("発言を合成会議の台本と突き合わせ、CER と固有名詞・略語の正解率、多い食い違いを出す"));

if (import.meta.main) {
  Command.run(command, { version: BENCH_VERSION }).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
