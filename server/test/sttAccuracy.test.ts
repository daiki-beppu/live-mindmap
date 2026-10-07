import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { align, chunk, command, kanjiToDigits, normalize, parseTimeline, score, type TimedText } from "../bench/sttAccuracy.ts";
import { runCommand, taggedFailure, temporaryDirectory } from "./benchRun.ts";

const line = (start: number, end: number, text: string): TimedText => ({ start, end, text });

describe("比べる前の正規化", () => {
  it("漢数字の並びを算用数字にする", () => {
    expect(["九十日", "二百枚", "三十時間", "第三四半期", "四千八百二十万円", "十"].map(kanjiToDigits)).toEqual(["90日", "200枚", "30時間", "第34半期", "48200000円", "10"]);
  });

  it("全角・大文字・句読点・空白の違いを消す", () => {
    expect(normalize("ＯＪＴの KPI は、九十日。")).toBe(normalize("ojtのkpiは90日"));
  });
});

describe("突き合わせ", () => {
  it("編集距離の手順を置換・脱落・挿入に分ける", () => {
    expect(align("ojt", "ot")).toEqual(["eq", "del", "eq"]);
    expect(align("ab", "axb")).toEqual(["eq", "ins", "eq"]);
    expect(align("ab", "ac")).toEqual(["eq", "sub"]);
  });

  it("区切りは発言の区間をまたがない行の間に置き、発言は区間の中央で区切りに入れる", () => {
    const lines = [line(0, 10, "あ"), line(11, 20, "い"), line(21, 40, "う"), line(41, 50, "え")];
    // 20〜21 秒の間は発言がまたぐので切れず、40〜41 秒の間で切れる
    const remarks = [line(0, 25, "あい"), line(26, 40, "う"), line(41, 50, "え")];
    expect(chunk(lines, remarks, 15)).toEqual([{ ref: "あいう", hyp: "あいう" }, { ref: "え", hyp: "え" }]);
  });
});

describe("採点", () => {
  it("CER の内訳と、語ごとの正解・崩れ方を数える", () => {
    const lines = [line(0, 5, "OJT の KPI です。"), line(6, 10, "OJT は大事。")];
    const remarks = [line(0, 5, "OT の KPI です"), line(6, 10, "OJTは大事")];
    const s = score(lines, remarks, ["OJT", "KPI", "Notion"]);
    expect({ refChars: s.refChars, sub: s.sub, del: s.del, ins: s.ins }).toEqual({ refChars: 15, sub: 0, del: 1, ins: 0 });
    const byTerm = Object.fromEntries(s.terms.map((t) => [t.term, { total: t.total, correct: t.correct, kanaOnly: t.kanaOnly, misses: [...t.misses] }]));
    expect(byTerm).toEqual({
      OJT: { total: 2, correct: 1, kanaOnly: 0, misses: [["ot", 1]] },
      KPI: { total: 1, correct: 1, kanaOnly: 0, misses: [] },
      Notion: { total: 0, correct: 0, kanaOnly: 0, misses: [] },
    });
    expect([...s.confusions]).toEqual([["j→∅", 1]]);
  });

  it("ひらがな・カタカナの違いだけのものは、正解に入れずに別に数える", () => {
    const s = score([line(0, 5, "ユズさんです。")], [line(0, 5, "ゆずさんです")], ["ユズ"]);
    expect(s.terms.map((t) => [t.correct, t.kanaOnly])).toEqual([[0, 1]]);
  });

  it("timeline.tsv の #MARK の行は台本に入れない", () => {
    expect(parseTimeline("#MARK\tslide:a\t2.00\n大河内\t2.00\t5.88\tはい。\n")).toEqual([line(2, 5.88, "はい。")]);
  });
});

describe("sttAccuracy の Command", () => {
  it.effect("stt-bench の JSONL は確定結果だけを、kanary の JSON は segments を発言として採点する", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    const terms = join(dir, "terms.txt");
    const jsonl = join(dir, "results.jsonl");
    const kanary = join(dir, "meeting.transcript.json");
    writeFileSync(timeline, "真壁\t0.00\t3.00\tOJT です。\n");
    writeFileSync(terms, "OJT\n");
    writeFileSync(jsonl, [
      { track: "相手", arrival: 1, isFinal: false, start: 0, end: 2, text: "OT" },
      { track: "相手", arrival: 4, isFinal: true, start: 0, end: 3, text: "OJTです。" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(kanary, JSON.stringify({ transcript: { segments: [{ track: "speaker", start_seconds: 0, end_seconds: 3, text: "OTです" }] } }));

    const fromBench = yield* runCommand(command, [timeline, jsonl, "--terms", terms]);
    expect(fromBench.result._tag).toBe("Success");
    expect(fromBench.stdout).toContain("| 5 | 0.0% | 0 | 0 | 0 |");
    expect(fromBench.stdout).toContain("固有名詞・略語の正解率: 100.0%（1/1）。かなの違いだけのもの: 0");

    const fromKanary = yield* runCommand(command, [timeline, kanary, "--terms", terms]);
    expect(fromKanary.stdout).toContain("| 5 | 20.0% | 0 | 1 | 0 |");
    expect(fromKanary.stdout).toContain("| OJT | 0 | 0 | 1 | ot（1） |");
  }).pipe(Effect.scoped));

  it.effect("発言のファイルの形が違えば、パス付きのタグ付きの失敗にする", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    const broken = join(dir, "broken.jsonl");
    writeFileSync(timeline, "真壁\t0.00\t3.00\tOJT です。\n");
    writeFileSync(broken, "{\"text\": 1}\n");
    const { result } = yield* runCommand(command, [timeline, broken]);
    expect(taggedFailure(result)).toMatchObject({ _tag: "InvalidInputFile", path: broken });
  }).pipe(Effect.scoped));
});
