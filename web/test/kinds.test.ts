import { describe, expect, it } from "vitest";
import type { SnapshotNode } from "../../server/src/core/index.ts";
import { KIND_COLOR, markOf } from "../src/kinds.ts";

const n = (kind: SnapshotNode["kind"], extra: Partial<SnapshotNode> = {}): SnapshotNode => ({
  id: "x",
  parent: "root",
  kind,
  text: "t",
  evidence: ["r1"],
  ...extra,
});

describe("markOf: 印は 論点 ?、決定済みの論点と決定 ✓、TODO ☐ だけ", () => {
  it("未決の論点は ?", () => expect(markOf(n("論点", { pointStatus: "未決" }))).toBe("?"));
  it("決定済みの論点は ✓", () => expect(markOf(n("論点", { pointStatus: "決定済み" }))).toBe("✓"));
  it("決定は ✓", () => expect(markOf(n("決定"))).toBe("✓"));
  it("TODO は ☐", () => expect(markOf(n("TODO"))).toBe("☐"));
  it.each([
    n("議題"),
    n("課題"),
    n("要点"),
    n("案", { planStatus: "検討中" }),
    n("案", { planStatus: "却下" }),
    n("会議", { parent: null }),
  ])("$kind には印がない", (node) => expect(markOf(node)).toBeNull());
});

describe("KIND_COLOR: 種別ごとの色", () => {
  it("要点の色が決まっていて、会議を含むほかの種別のどの色とも違う", () => {
    expect(KIND_COLOR["要点"]).toBeTruthy();
    for (const k of ["会議", "議題", "論点", "課題", "案", "決定", "TODO"] as const) expect(KIND_COLOR[k]).not.toBe(KIND_COLOR["要点"]);
  });

  it("議題・論点・課題・案・決定・TODO の色がそれぞれ決まっていて、互いに違う", () => {
    const kinds = ["議題", "論点", "課題", "案", "決定", "TODO"] as const;
    const colors = kinds.map((k) => KIND_COLOR[k]);
    for (const c of colors) expect(c).toBeTruthy();
    expect(new Set(colors).size).toBe(kinds.length);
  });
});
