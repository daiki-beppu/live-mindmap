import { describe, expect, it } from "vitest";
import { timelineReplay } from "../bench/timelineReplay.ts";

describe("台本から正しい話者つきの再生入力を作る", () => {
  it("自分には話者を付けず、相手は初出順のラベルを同じ人に再利用する", () => {
    const result = timelineReplay("司会\t0\t1\t開始\n乙\t1\t2\t提案\n甲\t2\t3\t確認\n乙\t3\t4\t補足", "司会");
    expect(result).toEqual([
      { id: "r1", track: "自分", start: 0, end: 1, at: 1, text: "開始" },
      { id: "r2", track: "相手", speaker: "相手 A", start: 1, end: 2, at: 2, text: "提案" },
      { id: "r3", track: "相手", speaker: "相手 B", start: 2, end: 3, at: 3, text: "確認" },
      { id: "r4", track: "相手", speaker: "相手 A", start: 3, end: 4, at: 4, text: "補足" },
    ]);
  });

  it("三列のマーカーと四列のコメントを発言にも相手の採番にも含めない", () => {
    const result = timelineReplay("#MARK\tslide:a\t2.50\n#乙\t0\t1\tコメント\n司会\t0\t1\t開始\n乙\t1\t2\t提案", "司会");
    expect(result).toEqual([
      { id: "r1", track: "自分", start: 0, end: 1, at: 1, text: "開始" },
      { id: "r2", track: "相手", speaker: "相手 A", start: 1, end: 2, at: 2, text: "提案" },
    ]);
  });

  it("本文の識別子に似た文字列を保持し、発言の識別子は連番にする", () => {
    const result = timelineReplay("司会\t0\t1\tr1\n甲\t1\t2\tr2\n乙\t2\t3\tr1", "司会");
    expect(result.map(({ id, text }) => [id, text])).toEqual([["r1", "r1"], ["r2", "r2"], ["r3", "r1"]]);
  });

  it("途中にコメントがあっても発言の識別子に欠番や重複を作らない", () => {
    const result = timelineReplay("#注記\t0\t1\tr1\n司会\t1\t2\t開始\n#注記\t2\t3\tr2\n乙\t3\t4\t確認", "司会");
    expect(result.map(({ id, text }) => [id, text])).toEqual([["r1", "開始"], ["r2", "確認"]]);
  });

  it("相手が26人を超えてもラベルを重複させない", () => {
    const text = Array.from({ length: 28 }, (_, i) => `人${i}\t${i}\t${i + 0.5}\t発言`).join("\n");
    const labels = timelineReplay(text, "司会").map((r) => r.speaker);
    expect(labels.slice(25)).toEqual(["相手 Z", "相手 AA", "相手 AB"]);
    expect(new Set(labels).size).toBe(28);
  });
});
