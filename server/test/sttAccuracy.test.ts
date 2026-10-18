import { describe, expect, it } from "@effect/vitest";
import { align, chunk, kanjiToDigits, normalize, parseTimeline, score, type TimedText } from "../bench/sttAccuracy.ts";

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

  it("同じ距離の手順が複数あるときは、後ろから見て斜め（一致・置換）→ 脱落 → 挿入の順に選ぶ", () => {
    expect(align("ab", "ba")).toEqual(["sub", "sub"]);
    expect(align("abcd", "cdab")).toEqual(["sub", "sub", "sub", "sub"]);
    expect(align("abc", "bca")).toEqual(["del", "eq", "eq", "ins"]);
    expect(align("aab", "ab")).toEqual(["del", "eq", "eq"]);
    expect(align("ab", "aab")).toEqual(["ins", "eq", "eq"]);
    expect(align("kitten", "sitting")).toEqual(["sub", "eq", "eq", "eq", "sub", "eq", "ins"]);
  });

  it("片方が空なら、もう片方の全文字が脱落（台本のみ）か挿入（発言のみ）になる", () => {
    expect(align("", "abc")).toEqual(["ins", "ins", "ins"]);
    expect(align("abc", "")).toEqual(["del", "del", "del"]);
    expect(align("", "")).toEqual([]);
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

  it("複数の区切りにまたがっても、内訳・語の出現・崩れ方を区切りの順、文字の順に数え、食い違いの並びは出会った順になる", () => {
    const lines = [line(0, 10, "OJTとKPIを決める"), line(11, 20, "OJTの進め方"), line(100, 110, "Notionに書く"), line(111, 120, "来週のOJT")];
    const remarks = [line(0, 10, "OTとKPIを決めた"), line(11, 20, "OJTの進め"), line(100, 110, "ノーションに書く"), line(111, 120, "来週のOJTです")];
    const s = score(lines, remarks, ["OJT", "KPI", "Notion"], 30);
    expect({ refChars: s.refChars, sub: s.sub, del: s.del, ins: s.ins }).toEqual({ refChars: 33, sub: 6, del: 3, ins: 2 });
    expect([...s.confusions]).toEqual([["j→∅", 1], ["る→た", 1], ["方notion→ノーション", 1], ["∅→です", 1]]);
    expect(s.terms.map((t) => [t.term, t.total, t.correct, t.kanaOnly, [...t.misses]])).toEqual([
      ["OJT", 3, 2, 0, [["ot", 1]]],
      ["KPI", 1, 1, 0, []],
      ["Notion", 1, 0, 0, [["ノーション", 1]]],
    ]);
  });

  it("ひらがな・カタカナの違いだけのものは、正解に入れずに別に数える", () => {
    const s = score([line(0, 5, "ユズさんです。")], [line(0, 5, "ゆずさんです")], ["ユズ"]);
    expect(s.terms.map((t) => [t.correct, t.kanaOnly])).toEqual([[0, 1]]);
  });

  it("timeline.tsv の #MARK の行は台本に入れない", () => {
    expect(parseTimeline("#MARK\tslide:a\t2.00\n大河内\t2.00\t5.88\tはい。\n")).toEqual([{ speaker: "大河内", ...line(2, 5.88, "はい。") }]);
  });

  it("timeline.tsv の各行は、話者（列 0）を捨てずに返す", () => {
    expect(parseTimeline("森川\t0.00\t2.00\tあ\n田中\t3.00\t4.50\tい\n").map((l) => [l.speaker, l.start, l.end])).toEqual([["森川", 0, 2], ["田中", 3, 4.5]]);
  });
});
