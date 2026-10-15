import { describe, expect, it } from "vitest";
import { emptyMap, type Remark } from "../src/core/index.ts";
import { classificationRequest, splitSentences } from "../src/localPrompt.ts";

// Issue #1021: ローカルのモデルへのプロンプトも、直前の発言と新しい発言の文の行を、クラウドと同じ書式（話者つき）で出す。

const remark = (fields: Partial<Remark> & Pick<Remark, "id" | "start">): Remark => ({ track: "相手", end: fields.start + 1, text: "本文", ...fields });
const lineOf = (prompt: string, section: string) => prompt.split(`## ${section}`)[1]!.split("\n\n## ")[0]!.split("\n").filter(Boolean);

describe("classificationRequest: 発言の行に話者が出る", () => {
  it("直前の発言の行は mm:ss と話者つき（今までの秒の生の値ではない）。自分・話者なし・ラベルあり", () => {
    const recent = [
      remark({ id: "r1", start: 194.9, text: "前の発言", speaker: "相手 A" }),
      remark({ id: "r2", start: 200, track: "自分", text: "うん", speaker: "自分" }),
      remark({ id: "r3", start: 201, text: "話者なし" }),
    ];

    const { prompt } = classificationRequest(emptyMap("定例"), recent, []);

    expect(lineOf(prompt, "直前の発言（処理済み・文脈用）")).toEqual([
      "r1 [03:14] 相手 A: 前の発言",
      "r2 [03:20] 自分: うん",
      "r3 [03:21] 相手: 話者なし",
    ]);
  });

  it("新しい発言の文の行は、番号の後に直前の発言と同じ形（ID [mm:ss] 話者: 文）。同じ発言の文は同じ話者", () => {
    const r4 = remark({ id: "r4", start: 194, text: "先に進めます。次に移ります。", speaker: "相手 B" });
    const r5 = remark({ id: "r5", start: 230, text: "お願いします", track: "自分", speaker: "自分" });

    const { prompt } = classificationRequest(emptyMap("定例"), [], [...splitSentences(r4), ...splitSentences(r5)]);

    expect(lineOf(prompt, "新しい発言（3 文）")).toEqual([
      "1. r4 [03:14] 相手 B: 先に進めます。",
      "2. r4 [03:14] 相手 B: 次に移ります。",
      "3. r5 [03:50] 自分: お願いします",
    ]);
  });

  it("文は、元の発言（ID・話者・時刻）を持ち、文の本文だけが違う", () => {
    const original = remark({ id: "r7", start: 10, text: "一文目。二文目。", speaker: "相手 A" });

    const sentences = splitSentences(original);

    expect(sentences.map((s) => [s.remark, s.text])).toEqual([[original, "一文目。"], [original, "二文目。"]]);
  });
});
