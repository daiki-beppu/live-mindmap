import { describe, expect, it } from "vitest";
import type { Remark } from "../src/core/index.ts";
import { fmtTime, remarkLine } from "../src/remarkLine.ts";

// Issue #1021: 発言を 1 行にする書式は 1 つの関数が持つ。クラウドのプロンプトもローカルのプロンプトも、この関数を通す。
// 形は「ID [mm:ss] 話者: 本文」。話者は 相手 A / 相手 / 自分。名前（後の sub-issue）が付くと「相手 B（田中）」になる。

const remark = (fields: Partial<Remark>): Remark => ({ id: "r12", track: "相手", start: 194.9, end: 196, text: "本文", ...fields });

describe("remarkLine: 発言を 1 行にする", () => {
  it("相手のラベルあり: r12 [03:14] 相手 A: 本文（分:秒は start の切り捨て）", () => {
    expect(remarkLine(remark({ speaker: "相手 A" }))).toBe("r12 [03:14] 相手 A: 本文");
  });

  it("相手の話者なし: 相手: 本文", () => {
    expect(remarkLine(remark({}))).toBe("r12 [03:14] 相手: 本文");
  });

  it("自分: 自分: 本文（話者を持つ発言も、トラックだけの古い発言も同じ形）", () => {
    expect(remarkLine(remark({ track: "自分", speaker: "自分" }))).toBe("r12 [03:14] 自分: 本文");
    expect(remarkLine(remark({ track: "自分" }))).toBe("r12 [03:14] 自分: 本文");
  });

  it("名前を受け取れる。相手のラベルに名前が付くと 相手 B（田中）: 本文", () => {
    expect(remarkLine(remark({ speaker: "相手 B" }), { name: "田中" })).toBe("r12 [03:14] 相手 B（田中）: 本文");
  });

  it("本文を差し替えられる（ローカルの文ごとの行は、発言の本文ではなく文を載せる）", () => {
    expect(remarkLine(remark({ speaker: "相手 A", text: "全文。二文目。" }), { text: "二文目。" })).toBe("r12 [03:14] 相手 A: 二文目。");
  });

  it("秒の端数は切り捨て、分は 60 を超えても時間に繰り上げない", () => {
    expect(fmtTime(65.9)).toBe("01:05");
    expect(fmtTime(0)).toBe("00:00");
    expect(fmtTime(3725)).toBe("62:05");
  });
});
