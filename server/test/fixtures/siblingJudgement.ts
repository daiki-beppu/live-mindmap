import type { Kind, LogEvent, Op } from "../../src/core/index.ts";

export const TITLE = "SYNTHETIC_TITLE_SECRET";
export const REMARK_TEXT = "SYNTHETIC_REMARK_SECRET";
export const parentText = (ref: string) => `SYNTHETIC_PARENT_SECRET_${ref}`;
export const childText = (ref: string) => `SYNTHETIC_CHILD_SECRET_${ref}`;

export type Spec = { ref: string; parent: string; kind: Kind };

export type Built = { events: LogEvent[]; id: (ref: string) => string };

export function build(specs: readonly Spec[], closes: readonly string[] = []): Built {
  const ids = new Map(specs.map((spec, i) => [spec.ref, `n${i + 1}`]));
  const text = (spec: Spec) => (spec.kind === "議題" || spec.kind === "論点" ? parentText(spec.ref) : childText(spec.ref));
  const ops: Op[] = specs.map((spec) => ({
    op: "add", ref: spec.ref, parent: spec.parent, kind: spec.kind, text: text(spec), evidence: ["r1"],
  }));
  const events: LogEvent[] = [
    { type: "start", title: TITLE },
    { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 60, text: REMARK_TEXT } },
    { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops, dropped: [] },
  ];
  if (closes.length > 0) {
    events.push(
      { type: "remark", remark: { id: "r2", track: "相手", start: 60, end: 120, text: REMARK_TEXT } },
      { type: "diff", input: { recent: [], fresh: ["r2"], nodeCount: specs.length }, ops: [], dropped: [] },
      { type: "diff", input: { recent: [], fresh: [], nodeCount: specs.length }, ops: closes.map((ref): Op => ({ op: "close", node: ids.get(ref)! })), dropped: [] },
    );
  }
  return { events, id: (ref) => ids.get(ref)! };
}

export const kids = (parent: string, kind: Kind, count: number, prefix = parent): Spec[] =>
  Array.from({ length: count }, (_, i) => ({ ref: `${prefix}_${i}`, parent, kind }));

export function bigGroup(options: { cases: number; withPoints: number }): Spec[] {
  const specs: Spec[] = [{ ref: "T", parent: "root", kind: "議題" }, { ref: "P", parent: "T", kind: "論点" }];
  specs.push(...kids("P", "案", options.cases));
  for (let i = 0; i < options.withPoints; i++) specs.push(...kids(`P_${i}`, "要点", 4));
  return specs;
}
