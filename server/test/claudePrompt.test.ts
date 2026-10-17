import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyOps, emptyMap } from "../src/core/index.ts";

const sdkLoad = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  sdkLoad();
  throw new Error("Agent SDK is unavailable in this test");
});

beforeEach(() => {
  vi.resetModules();
  sdkLoad.mockClear();
});

describe("Agent SDK を読み込めない環境でのプロンプト生成", () => {
  it("新モジュールの文・スキーマと buildPrompt を SDK なしで利用できる", async () => {
    const { buildPrompt, OUTPUT_SCHEMA } = await import("../src/claudePrompt.ts");

    const prompt = buildPrompt({
      map: emptyMap("定例"),
      recent: [],
      fresh: [{ id: "r1", track: "相手", start: 65.9, end: 67, text: "来週に開催します" }],
    });

    expect(prompt.split("\n").filter((line) => line.startsWith("- root "))).toEqual(["- root 会議: 定例"]);
    expect(prompt.split("\n").filter((line) => line.startsWith("r1 "))).toEqual(["r1 [01:05] 相手: 来週に開催します"]);
    expect(OUTPUT_SCHEMA).toMatchObject({ type: "object", properties: { ops: { type: "array" } } });
    expect(sdkLoad).not.toHaveBeenCalled();
  });

  // Issue #1021: 新しい発言も直前の発言も、1 行は「ID [mm:ss] 話者: 本文」。話者は 相手 A / 相手 / 自分
  it("新しい発言と直前の発言の行に話者が出る（ラベルあり・話者なし・自分。トラック名だけの古い自分の発言も 自分:）", async () => {
    const { buildPrompt } = await import("../src/claudePrompt.ts");
    const lines = (prompt: string, section: string) => {
      const body = prompt.split(`## ${section}`)[1]!.split("\n\n## ")[0]!;
      return body.split("\n").filter((line) => /^r\d+ /.test(line));
    };

    const prompt = buildPrompt({
      map: emptyMap("定例"),
      recent: [
        { id: "r10", track: "相手", start: 194, end: 196, text: "前の発言", speaker: "相手 A" },
        { id: "r11", track: "自分", start: 197, end: 198, text: "うん", speaker: "自分" },
        { id: "r12", track: "自分", start: 199, end: 200, text: "古いログの自分" },
      ],
      fresh: [
        { id: "r13", track: "相手", start: 194.9, end: 196, text: "ラベルあり", speaker: "相手 B" },
        { id: "r14", track: "相手", start: 200, end: 201, text: "話者なし" },
        { id: "r15", track: "自分", start: 202, end: 203, text: "自分です", speaker: "自分" },
      ],
    });

    expect(lines(prompt, "直前の発言（処理済み・文脈用）")).toEqual([
      "r10 [03:14] 相手 A: 前の発言",
      "r11 [03:17] 自分: うん",
      "r12 [03:19] 自分: 古いログの自分",
    ]);
    expect(lines(prompt, "新しい発言")).toEqual([
      "r13 [03:14] 相手 B: ラベルあり",
      "r14 [03:20] 相手: 話者なし",
      "r15 [03:22] 自分: 自分です",
    ]);
  });

  // Issue #1026: 名前が付いたラベルの相手の発言は「相手 B（田中）: 本文」。新しい発言も直前の発言も同じ。ラベルは変えず、名前を添えるだけ
  it("speakerNames があれば、ラベルのある相手の発言の行が 相手 B（田中） になる。新しい発言と直前の発言の両方。名前の無いラベル・話者なし・自分は今の形のまま", async () => {
    const { buildPrompt } = await import("../src/claudePrompt.ts");
    const lines = (prompt: string, section: string) => {
      const body = prompt.split(`## ${section}`)[1]!.split("\n\n## ")[0]!;
      return body.split("\n").filter((line) => /^r\d+ /.test(line));
    };

    const prompt = buildPrompt({
      map: emptyMap("定例"),
      recent: [
        { id: "r10", track: "相手", start: 194, end: 196, text: "前の発言", speaker: "相手 A" },
        { id: "r11", track: "相手", start: 197, end: 198, text: "名前つき", speaker: "相手 B" },
        { id: "r12", track: "自分", start: 199, end: 200, text: "うん", speaker: "自分" },
      ],
      fresh: [
        { id: "r13", track: "相手", start: 194.9, end: 196, text: "名前つき", speaker: "相手 B" },
        { id: "r14", track: "相手", start: 200, end: 201, text: "話者なし" },
        { id: "r15", track: "自分", start: 202, end: 203, text: "自分です", speaker: "自分" },
      ],
      speakerNames: new Map([["相手 B", "田中"]]),
    });

    expect(lines(prompt, "直前の発言（処理済み・文脈用）")).toEqual([
      "r10 [03:14] 相手 A: 前の発言",
      "r11 [03:17] 相手 B（田中）: 名前つき",
      "r12 [03:19] 自分: うん",
    ]);
    expect(lines(prompt, "新しい発言")).toEqual([
      "r13 [03:14] 相手 B（田中）: 名前つき",
      "r14 [03:20] 相手: 話者なし",
      "r15 [03:22] 自分: 自分です",
    ]);
  });

  it("同じ名前を 2 つのラベルに付けても、行はラベルごとに別（相手 A（田中） と 相手 B（田中））", async () => {
    const { buildPrompt } = await import("../src/claudePrompt.ts");

    const prompt = buildPrompt({
      map: emptyMap("定例"),
      recent: [],
      fresh: [
        { id: "r1", track: "相手", start: 0, end: 1, text: "あ", speaker: "相手 A" },
        { id: "r2", track: "相手", start: 1, end: 2, text: "い", speaker: "相手 B" },
      ],
      speakerNames: new Map([["相手 A", "田中"], ["相手 B", "田中"]]),
    });

    expect(prompt.split("\n").filter((line) => /^r\d+ /.test(line))).toEqual(["r1 [00:00] 相手 A（田中）: あ", "r2 [00:01] 相手 B（田中）: い"]);
  });

  it("論点の配下を件数から除いても、その下の議題を全体・変更メッセージの一覧に残す", async () => {
    const { buildPrompt } = await import("../src/claudePrompt.ts");
    const previous = emptyMap("合成会議");
    const { map, dropped } = applyOps(previous, [
      { op: "add", ref: "t", parent: "root", kind: "議題", text: "親の議題", evidence: ["r1"] },
      { op: "add", ref: "p", parent: "t", kind: "論点", text: "論点", evidence: ["r1"] },
      { op: "add", ref: "a", parent: "p", kind: "案", text: "案", evidence: ["r1"] },
      { op: "add", ref: "child", parent: "p", kind: "議題", text: "子の議題", evidence: ["r1"] },
      { op: "add", ref: "k", parent: "child", kind: "要点", text: "子の中身", evidence: ["r1"] },
    ], new Set(["r1"]), { round: 1, at: 600 }, new Map());
    expect(dropped).toEqual([]);

    for (const sent of [undefined, previous]) {
      const prompt = buildPrompt({ map, recent: [], fresh: [] }, sent);
      const list = prompt.split("\n\n")[0]!;
      const rows = list.split("\n").filter((line) => /^ *- n\d+ /.test(line));
      expect(rows.map((line) => line.match(/^( *)- (n\d+) /)!.slice(1, 3))).toEqual([["", "n1"], ["  ", "n4"]]);
      expect(rows.map((line) => Number(line.match(/話し中 (\d+) ノード/)?.[1]))).toEqual([1, 1]);
      expect(rows[0]).toMatch(/子の議題 話し中 1・済み 0/);
    }
    expect(sdkLoad).not.toHaveBeenCalled();
  });

});
