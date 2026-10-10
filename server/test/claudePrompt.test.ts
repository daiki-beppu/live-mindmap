import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyMap } from "../src/core/index.ts";

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
    const { buildPrompt, NOOP_SCOPE, SYSTEM, OUTPUT_SCHEMA } = await import("../src/claudePrompt.ts");

    const prompt = buildPrompt({
      map: emptyMap("定例"),
      recent: [],
      fresh: [{ id: "r1", track: "相手", start: 65.9, end: 67, text: "来週に開催します" }],
    });

    expect(prompt).toBe([
      "## 議題の一覧（話し中 0・済み 0。済みと、済みの議題の下は省略）",
      "（なし）",
      "目安: 1 つの議題の話し中の部分は 15〜20 ノード。1 つの親の下の話し中の兄弟は種別によらず 5 つまで（ルート直下も含む。済みは数えない）",
      "",
      "## 現在のマップ（ルートの ID: root）",
      "- root 会議: 定例",
      "",
      "## 直前の発言（処理済み・文脈用）",
      "（なし）",
      "",
      "## 新しい発言",
      "r1 [01:05] 来週に開催します",
    ].join("\n"));
    expect(NOOP_SCOPE).not.toBe("");
    expect(SYSTEM).toContain(NOOP_SCOPE);
    expect(OUTPUT_SCHEMA).toMatchObject({ type: "object", properties: { ops: { type: "array" } } });
    expect(sdkLoad).not.toHaveBeenCalled();
  });

  it("運び手を読み込むと SDK の読み込みで失敗するため、検査が機能している", async () => {
    await expect(import("../src/claude.ts")).rejects.toThrow();
    expect(sdkLoad).toHaveBeenCalledOnce();
  });
});
