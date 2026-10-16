import { describe, expect, it } from "vitest";
import { formatRecordedPosition, formatRecordedProgress } from "../src/core/index.ts";

// 録画からのセッションで進んだ位置の表示。諦めたときの終わりの知らせ（どこまで組めたか）と、進み具合の行が同じ書き方を使う

describe("formatRecordedPosition（進んだ位置 / 全体の長さ）", () => {
  it("1 時間未満は m:ss、1 時間以上は h:mm:ss で、位置と全体の長さを ` / ` でつなぐ", () => {
    expect(formatRecordedPosition(2832, 7200)).toBe("47:12 / 2:00:00");
    expect(formatRecordedPosition(660, 3484)).toBe("11:00 / 58:04");
  });

  it("全体の長さがまだ届いていない（null）なら、長さは --:--", () => {
    expect(formatRecordedPosition(660, null)).toBe("11:00 / --:--");
  });

  it("進み具合の行は、同じ位置の表記の後ろにマップの更新回数が付く", () => {
    expect(formatRecordedProgress({ type: "progress", position: 2832, duration: 7200, rounds: 3 })).toBe(`${formatRecordedPosition(2832, 7200)}  マップの更新 3 回`);
  });
});
