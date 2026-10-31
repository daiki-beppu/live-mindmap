import { describe, expect, it } from "vitest";
import { buildPrompt, DIFF_SYSTEM } from "../src/claudePrompt.ts";
import { emptyMap, type MeetingMap } from "../src/core/map.ts";

function mapWithSupplement(): MeetingMap {
  return {
    nodes: {
      ...emptyMap("運用").nodes,
      n1: { id: "n1", parent: "root", kind: "議題", text: "サービス水準", evidence: ["r1"] },
      n2: { id: "n2", parent: "n1", kind: "要点", text: "SLA の確認", evidence: ["r1"] },
      n3: { id: "n3", parent: "n2", kind: "補足", text: "サービス水準の合意", evidence: ["r1"], origin: "会議の外" },
    }, order: ["root", "n1", "n2", "n3"], nextId: 4,
  };
}

describe("差分更新がモデルへ渡す補足", () => {
  it.each([{ criteria: undefined }, { criteria: ["運用負荷"] }])("通常入力と継続入力で補足の ID・本文・親を提示する（判断軸 $criteria）", ({ criteria }) => {
    const map = mapWithSupplement();
    const previous = { ...map, nodes: { ...map.nodes }, order: map.order.filter((id) => id !== "n3") };
    delete previous.nodes.n3;
    for (const sent of [undefined, previous]) {
      const prompt = buildPrompt({ map, recent: [], fresh: [], ...(criteria === undefined ? {} : { criteria }) }, sent);
      expect(prompt).toContain("n3 補足: サービス水準の合意");
      expect(prompt).toContain("n2");
      if (sent === undefined) expect(prompt).toContain("SLA の確認");
    }
  });

  it("操作出力に誤りの指摘時だけの削除と、子・根拠の追加禁止を伝える", () => {
    // 指示が送信されることだけを検査する。モデルによる意味判断は eval で測る。
    const rules = DIFF_SYSTEM.split(/\n/).filter((line) => line.includes("補足")).join("\n");
    expect(rules).toMatch(/会議[^\n]*誤り[^\n]*ときだけ[^\n]*(消|削除)/);
    expect(rules).toMatch(/子[^\n]*(付けない|追加しない|作らない)/);
    expect(rules).toMatch(/根拠[^\n]*(足さない|追加しない|付けない)/);
  });
});
