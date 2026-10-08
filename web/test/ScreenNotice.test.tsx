import { describe, expect, it } from "vitest";
import { ScreenNotice } from "../src/ScreenNotice.tsx";
import { findAll, textOf } from "./tree.ts";

// Issue #280: 共有画面を使っていないことの一文（許可なし）。字幕・取り込みの一言とは別の部品。
// hooks を持たない部品として関数で直接呼ぶ（IntakeNotice.test.tsx と同じ手法）。
// 出す・消すの寿命（約 10 秒・セッションにつき 1 回）はサーバーが持つので、ここは渡された文を描くか描かないかだけを確かめる。
describe("ScreenNotice: 共有画面を使っていないことの一文", () => {
  it("出す文がなければ（null）何も描かない", () => {
    expect(ScreenNotice({ text: null })).toBeNull();
  });

  it("文があれば、その文をそのまま描く", () => {
    const text = "共有画面は使っていません（画面収録の許可がありません。システム設定で、起動したターミナルに許可を与え、ターミナルを開き直す）";
    expect(textOf(ScreenNotice({ text }))).toContain(text);
  });

  it("取り込みの一言（intake-notice）とは別のクラスで描く（重ならない位置を CSS で分けるため）", () => {
    const tree = ScreenNotice({ text: "共有画面は使っていません" });
    const classes = findAll(tree, "div").map((div) => String(div.props.className ?? ""));
    expect(classes.some((c) => c.split(/\s+/).includes("screen-notice"))).toBe(true);
    expect(classes.some((c) => c.includes("intake-notice"))).toBe(false);
  });

  it("バッジや影のための種別クラスを持たず、控えめな一文として描く", () => {
    const tree = ScreenNotice({ text: "共有画面は使っていません" });
    for (const div of findAll(tree, "div")) expect(String(div.props.className ?? "")).not.toMatch(/badge|shadow/i);
  });
});
