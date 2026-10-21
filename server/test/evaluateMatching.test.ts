import { describe, expect, it } from "vitest";
import { matchTruth, recall } from "../src/core/evaluate.ts";
import type { ExportNode, JsonExport } from "../src/core/export.ts";

describe("正解とノードの最終割り当て", () => {
  it("先の正解を別ノードへ移し、拡張項目を保持した一対一の最終組を返す", () => {
    const node = (id: string, text: string): ExportNode => ({
      id, kind: "TODO", text, children: [],
      evidence: [{ id: "r1", track: "相手", start: 0, end: 1, text: "根拠" }],
    });
    const both = node("n1", "予算の上限");
    const onlyBudget = node("n2", "予算");
    const exp: JsonExport = { root: { id: "root", kind: "会議", text: "会議", evidence: [], children: [both, onlyBudget] } };
    const budget = { from: 0, to: 1, keywords: ["予算"], 担当: "甲" };
    const limit = { from: 0, to: 1, keywords: ["上限"], 担当: "乙" };
    const items = [budget, limit];
    const pairs = matchTruth(exp, "TODO", items);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(expect.arrayContaining([
      { truth: budget, node: onlyBudget },
      { truth: limit, node: both },
    ]));
    expect(recall(exp, { 決定: [], TODO: items }).TODO).toEqual({ hit: 2, total: 2 });
  });
});
