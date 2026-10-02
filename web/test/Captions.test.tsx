import { describe, expect, it } from "vitest";
import { Captions } from "../src/Captions.tsx";
import { findAll, textOf } from "./tree.ts";

describe("Captions: 字幕", () => {
  it("話している文字がなければ何も描かない", () => {
    expect(Captions({ speaking: { 相手: "", 自分: "" } })).toBeNull();
  });

  it("文ごとに 1 行で描く。新しい文は次の行になる", () => {
    const tree = Captions({ speaking: { 相手: "議題は採用です。まず面接の", 自分: "はい" } });
    expect(findAll(tree, "p").map((l) => textOf(l))).toEqual(["議題は採用です。", "まず面接の", "はい"]);
    expect(findAll(tree, "span").map((s) => textOf(s))).toEqual(["相手", "自分"]);
  });
});
