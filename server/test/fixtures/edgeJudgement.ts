import type { LogEvent, Op } from "../../src/core/index.ts";

export const TITLE = "SYNTHETIC_TITLE_SECRET";
export const PARENT_TEXT = "SYNTHETIC_PARENT_SECRET";
export const REMARK_TEXT = "SYNTHETIC_REMARK_SECRET";
export const childText = (index: number) => `SYNTHETIC_CHILD_SECRET_${index}`;

export function edgeEvents(count: number): LogEvent[] {
  const ops: Op[] = [
    { op: "add", ref: "topic", parent: "root", kind: "議題", text: PARENT_TEXT, evidence: ["r1"] },
    ...Array.from({ length: count }, (_, i): Op => ({
      op: "add", ref: `child${i}`, parent: "topic", kind: "論点", text: childText(i), evidence: ["r1"],
    })),
  ];
  return [
    { type: "start", title: TITLE },
    { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 1, text: REMARK_TEXT } },
    { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops, dropped: [] },
  ];
}
