import { describe, expect, it } from "vitest";
import { partialFromHelper, remarkFromHelper } from "../src/core/index.ts";

// ヘルパーのイベントの形は helper/README.md「イベントの形」が正本
describe("remarkFromHelper（ヘルパーのイベント → 発言）", () => {
  it("remark は、渡された ID を付けた発言になる。両トラックとも同じ形で変換される", () => {
    const base = { type: "remark", start: 1.5, end: 3.25, text: "こんにちは", duplicate: false };

    expect(remarkFromHelper({ ...base, track: "相手" }, "r1")).toMatchObject({
      id: "r1",
      track: "相手",
      start: 1.5,
      end: 3.25,
      text: "こんにちは",
    });
    expect(remarkFromHelper({ ...base, track: "自分" }, "r2")).toMatchObject({ id: "r2", track: "自分" });
  });

  it("partial（途中結果）は発言にならない", () => {
    expect(remarkFromHelper({ type: "partial", track: "相手", start: 0, end: 1, text: "こんに" }, "r1")).toBeNull();
  });

  it("知らない type は読み飛ばす", () => {
    expect(remarkFromHelper({ type: "heartbeat" }, "r1")).toBeNull();
  });

  it.each([
    ["不正なトラック", { type: "remark", track: "司会", start: 0, end: 1, text: "あ" }],
    ["本文の欠落", { type: "remark", track: "相手", start: 0, end: 1 }],
    ["秒数の型違い", { type: "remark", track: "相手", start: "0", end: 1, text: "あ" }],
  ])("remark の必須項目が壊れていたら、読み飛ばさずに例外にする（%s）", (_name, data) => {
    expect(() => remarkFromHelper(data, "r1")).toThrow();
  });
});

describe("partialFromHelper（ヘルパーのイベント → いま話している文字）", () => {
  it("partial は、トラック・開始・終了・本文を持つ。両トラックとも同じ形で変換される", () => {
    expect(partialFromHelper({ type: "partial", track: "相手", start: 1.5, end: 3.25, text: "こんに" })).toMatchObject({
      track: "相手",
      start: 1.5,
      end: 3.25,
      text: "こんに",
    });
    expect(partialFromHelper({ type: "partial", track: "自分", start: 0, end: 1, text: "はい" })).toMatchObject({ track: "自分", start: 0, end: 1, text: "はい" });
  });

  it("duplicate は、true のときだけ重複の印になる。項目がなければ（#36 より前の partial は）印なし", () => {
    expect(partialFromHelper({ type: "partial", track: "自分", start: 0, end: 1, text: "あ", duplicate: true })!.duplicate).toBe(true);
    expect(partialFromHelper({ type: "partial", track: "自分", start: 0, end: 1, text: "あ", duplicate: false })!.duplicate).toBe(false);
    expect(partialFromHelper({ type: "partial", track: "自分", start: 0, end: 1, text: "あ" })!.duplicate).toBe(false);
  });

  it("remark や知らない type は途中結果ではないので null", () => {
    expect(partialFromHelper({ type: "remark", track: "相手", start: 0, end: 1, text: "あ" })).toBeNull();
    expect(partialFromHelper({ type: "heartbeat" })).toBeNull();
  });

  it.each([
    ["不正なトラック", { type: "partial", track: "司会", start: 0, end: 1, text: "あ" }],
    ["本文の欠落", { type: "partial", track: "相手", start: 0, end: 1 }],
    ["本文の型違い", { type: "partial", track: "相手", start: 0, end: 1, text: 1 }],
    ["start の欠落（start / end を持たない旧形式）", { type: "partial", track: "相手", text: "あ" }],
    ["end の欠落", { type: "partial", track: "相手", start: 0, text: "あ" }],
    ["start の型違い", { type: "partial", track: "相手", start: "0", end: 1, text: "あ" }],
    ["end の型違い", { type: "partial", track: "相手", start: 0, end: "1", text: "あ" }],
  ])("partial の必須項目が壊れていたら、読み飛ばさずに例外にする（%s）", (_name, data) => {
    expect(() => partialFromHelper(data)).toThrow();
  });
});
