import { describe, expect, it } from "vitest";
import { CAPTION_LINES, captionsOf, sentencesOf } from "../src/captions.ts";

describe("sentencesOf（文ごとに分ける）", () => {
  it("句点・疑問符・感嘆符の後ろで分け、区切りの後ろの空白は捨てる", () => {
    expect(sentencesOf("今日は採用です。 どうしますか？ はい！")).toEqual(["今日は採用です。", "どうしますか？", "はい！"]);
  });

  it("話している途中（区切りのない末尾）も 1 文として残す", () => {
    expect(sentencesOf("決めました。次は求人の")).toEqual(["決めました。", "次は求人の"]);
  });

  it("空の文字は文にならない", () => {
    expect(sentencesOf("")).toEqual([]);
    expect(sentencesOf("  ")).toEqual([]);
  });
});

describe("captionsOf（字幕）", () => {
  it("相手 → 自分の順に、文字のあるトラックだけを出す", () => {
    expect(captionsOf({ 相手: "", 自分: "" })).toEqual([]);
    expect(captionsOf({ 相手: "今日は。", 自分: "はい" })).toEqual([
      { track: "相手", lines: ["今日は。"] },
      { track: "自分", lines: ["はい"] },
    ]);
  });

  it("末尾の CAPTION_LINES 文だけを、文を割らずに出す（古い文は文ごと消える）", () => {
    const text = "一つ目です。二つ目です。三つ目の途中";
    const lines = captionsOf({ 相手: text, 自分: "" })[0]!.lines;
    expect(lines).toHaveLength(CAPTION_LINES);
    expect(lines.at(-1)).toBe("三つ目の途中");
    for (const line of lines) expect(sentencesOf(text)).toContain(line);
  });
});
