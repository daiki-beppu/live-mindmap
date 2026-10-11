import { describe, expect, it } from "vitest";
import { TapNotice } from "../src/TapNotice.tsx";
import { findAll, textOf } from "./tree.ts";

// Issue #863: 相手の音声が届いていないことの一文。共有画面の一文・取り込みの一言とは別の部品。
// hooks を持たない部品として関数で直接呼ぶ（ScreenNotice.test.tsx と同じ手法）。
// 出す・消す寿命は server のフレームが決めるので、ここは渡された文を描くか描かないかだけを確かめる。
describe("TapNotice: 相手の音声が届いていないことの一文", () => {
  it("出す文がなければ（null）何も描かない", () => {
    expect(TapNotice({ text: null })).toBeNull();
  });

  it("文があれば、その文をそのまま描く", () => {
    const text = "相手の音声が届いていません（出力の機器を切り替えた後に起きることがあります。cli stop の後、cli start で始め直してください）";
    expect(textOf(TapNotice({ text }))).toContain(text);
  });

  it("tap-notice クラスで描き、取り込みの一言（intake-notice）・共有画面の一文（screen-notice）のクラスは使わない", () => {
    const tree = TapNotice({ text: "相手の音声が届いていません" });
    const classes = findAll(tree, "div").map((div) => String(div.props.className ?? ""));
    expect(classes.some((c) => c.split(/\s+/).includes("tap-notice"))).toBe(true);
    expect(classes.some((c) => c.includes("intake-notice") || c.includes("screen-notice"))).toBe(false);
  });

  it("バッジや影のための種別クラスを持たず、控えめな一文として描く", () => {
    const tree = TapNotice({ text: "相手の音声が届いていません" });
    for (const div of findAll(tree, "div")) expect(String(div.props.className ?? "")).not.toMatch(/badge|shadow/i);
  });
});
