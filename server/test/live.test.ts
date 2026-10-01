import { describe, expect, it } from "vitest";
import { remarkFromHelper } from "../src/core/index.ts";

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
    expect(remarkFromHelper({ type: "partial", track: "相手", text: "こんに" }, "r1")).toBeNull();
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
