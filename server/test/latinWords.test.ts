import { describe, expect, it } from "vitest";
import { isAbbreviation, katakanaTable, wordsForKatakana } from "../src/core/index.ts";

// Issue #642: 英字の語（略語でないもの）をモデルにカタカナの読みで聞くための、I/O を持たない部品。
// 略語は大文字（A–Z）だけで 5 字以下の語。NFKC で正規化してから判定する。

describe("isAbbreviation", () => {
  it.each([
    ["OJT", true],
    ["KPI", true],
    ["A", true],
    ["ABCDE", true], // 5 字ちょうどは略語
    ["ＯＪＴ", true], // 全角は NFKC で半角にそろえてから判定する
    ["ABCDEF", false], // 6 字は略語ではない
    ["Notion", false],
    ["notion", false],
    ["Ojt", false], // 大文字だけではない
    ["1on1", false],
    ["B2B", false], // 数字を含む
    ["港南店", false],
    ["ノーション", false],
    ["", false],
  ])("%s → %s", (surface, expected) => {
    expect(isAbbreviation(surface)).toBe(expected);
  });
});

describe("wordsForKatakana", () => {
  it("英字の略語でない語だけを、入力の順で返す", () => {
    expect(wordsForKatakana(["Notion", "OJT", "港南店", "Figma", "KPI", "ノーション", "Amplitude"])).toEqual(["Notion", "Figma", "Amplitude"]);
  });

  it.each([
    ["小文字だけの語", ["notion"], ["notion"]],
    ["英字と数字の語", ["1on1"], ["1on1"]],
    ["6 字の大文字だけの語", ["ABCDEF"], ["ABCDEF"]],
    ["全角の略語は聞かない", ["ＯＪＴ"], []],
    ["数字だけの語は英字の語ではない", ["2024"], []],
    ["空白を含む語は英字の語に含めない", ["Google Meet"], []],
    ["記号を含む語は英字の語に含めない", ["Node.js"], []],
    ["漢字・カタカナだけの語は聞かない", ["港南店", "ノーション"], []],
    ["略語だけなら空", ["OJT", "KPI"], []],
    ["空の入力", [], []],
  ] as const)("%s", (_name, surfaces, expected) => {
    expect(wordsForKatakana(surfaces)).toEqual(expected);
  });

  it("全角の英字の語は NFKC にそろえて判定するが、返すのは元の表記", () => {
    expect(wordsForKatakana(["Ｎｏｔｉｏｎ"])).toEqual(["Ｎｏｔｉｏｎ"]);
  });
});

describe("katakanaTable（モデルの返り値の正規化）", () => {
  const entries = (table: ReadonlyMap<string, string>) => [...table.entries()];

  it("聞いた語のカタカナの読みを、語 → 読みの表にする", () => {
    expect(entries(katakanaTable(["Notion", "Figma"], [{ surface: "Notion", katakana: "ノーション" }, { surface: "Figma", katakana: "フィグマ" }]))).toEqual([
      ["Notion", "ノーション"],
      ["Figma", "フィグマ"],
    ]);
  });

  it("聞いていない語の答えは落とす", () => {
    expect(entries(katakanaTable(["Notion"], [{ surface: "Slack", katakana: "スラック" }, { surface: "Notion", katakana: "ノーション" }]))).toEqual([["Notion", "ノーション"]]);
  });

  it("1 語に 2 つ以上の答えがあれば、最初の 1 つだけを採る（読みは 1 語に 1 つ）", () => {
    expect(entries(katakanaTable(["Notion"], [{ surface: "Notion", katakana: "ノーション" }, { surface: "Notion", katakana: "ノーティオン" }]))).toEqual([["Notion", "ノーション"]]);
  });

  it("最初の答えが不正なら、その語は読みなし（2 つ目以降の答えで補わない）", () => {
    expect(entries(katakanaTable(["Notion"], [{ surface: "Notion", katakana: "" }, { surface: "Notion", katakana: "ノーション" }]))).toEqual([]);
  });

  it.each([
    ["空の値", ""],
    ["ひらがな", "のーしょん"],
    ["英字", "notion"],
    ["漢字", "概念"],
    ["カタカナに英字が混ざる", "ノーションA"],
    ["空白を含む", "ノー ション"],
  ])("カタカナの読みでない値（%s）は、読みが返らない語として落とす", (_name, katakana) => {
    expect(entries(katakanaTable(["Notion"], [{ surface: "Notion", katakana }]))).toEqual([]);
  });

  it.each([
    ["長音を含む", "ノーション"],
    ["中黒を含む", "ビー・ツー・ビー"],
    ["小さいカナを含む", "フィグマ"],
  ])("カタカナ・長音「ー」・中黒「・」だけの値（%s）は受け付ける", (_name, katakana) => {
    expect(entries(katakanaTable(["X"], [{ surface: "X", katakana }]))).toEqual([["X", katakana]]);
  });

  it("答えが空なら表も空", () => {
    expect(entries(katakanaTable(["Notion"], []))).toEqual([]);
  });
});
