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
    expect(prompt.split("\n").filter((line) => line.startsWith("r1 "))).toEqual(["r1 [01:05] 来週に開催します"]);
    expect(OUTPUT_SCHEMA).toMatchObject({ type: "object", properties: { ops: { type: "array" } } });
    expect(sdkLoad).not.toHaveBeenCalled();
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
    ], new Set(["r1"]), { round: 1, at: 600 });
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
