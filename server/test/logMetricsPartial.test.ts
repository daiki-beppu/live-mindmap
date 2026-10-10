import { expect, it } from "vitest";
import { logMetrics, type LogEvent } from "../src/core/index.ts";

it("invConservation: 再適用でも未消費の発言を根拠にした操作は指標へ含めない", () => {
  const events: LogEvent[] = [
    { type: "start", title: "定例" },
    { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 10, text: "採用について" } },
    { type: "remark", remark: { id: "r2", track: "相手", start: 10, end: 20, text: "未反映の修正" } },
    {
      type: "diff", input: { recent: [], fresh: ["r1", "r2"], nodeCount: 0 },
      ops: [
        { op: "add", ref: "topic", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
        { op: "update", node: "topic", text: "まだ反映しない修正", evidence: ["r2"] },
      ], dropped: [], ...{ processedRemarks: 1 },
    },
  ];
  expect(logMetrics(events).rewrites).toBe(0);
  // input.fresh 全体の発言参照を検査する既存契約は、部分反映でも維持する。
  expect(() => logMetrics([events[0]!, events[1]!, events[3]!])).toThrow("ログに発言がありません: r2");
  expect(logMetrics([...events, {
    type: "diff", input: { recent: ["r1"], fresh: ["r2"], nodeCount: 1 },
    ops: [{ op: "update", node: "n1", text: "反映した修正", evidence: ["r2"] }], dropped: [], ...{ processedRemarks: 1 },
  }]).rewrites).toBe(1);
});
