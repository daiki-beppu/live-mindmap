import { describe, expect, it } from "vitest";
import type { Remark, Snapshot } from "../../server/src/core/index.ts";
import { evidenceOf } from "../src/evidence.ts";

const remark = (id: string, start: number, text: string, track: Remark["track"] = "相手"): Remark => ({ id, track, start, end: start + 5, text });

const snapshot: Snapshot = {
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
    { id: "n1", parent: "root", kind: "論点", text: "面接は何回か", evidence: ["r3", "r1"], pointStatus: "未決" },
    { id: "n2", parent: "n1", kind: "案", text: "2 回", evidence: ["r2"], planStatus: "却下" },
  ],
  round: 1,
  changes: [],
  remarks: [remark("r1", 10, "一"), remark("r2", 20, "二", "自分"), remark("r3", 30, "三"), remark("r9", 40, "どのノードにも関係ない")],
};

describe("evidenceOf: 選んだノードの表示内容", () => {
  it("ノードと、その根拠の発言を開始時刻の昇順で返す（evidence の並びではなく）", () => {
    const e = evidenceOf(snapshot, "n1")!;
    expect(e.node).toMatchObject({ id: "n1", kind: "論点", text: "面接は何回か", pointStatus: "未決" });
    expect(e.remarks.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(e.remarks[0]).toMatchObject({ start: 10, end: 15, track: "相手", text: "一" });
  });

  it("案は状態（planStatus）を保ったまま返す。他のノードの根拠は混ざらない", () => {
    const e = evidenceOf(snapshot, "n2")!;
    expect(e.node.planStatus).toBe("却下");
    expect(e.remarks.map((r) => r.id)).toEqual(["r2"]);
  });

  it("ルートは根拠の発言なしで返す", () => {
    const e = evidenceOf(snapshot, "root")!;
    expect(e.node.kind).toBe("会議");
    expect(e.remarks).toEqual([]);
  });

  it("今のマップにないノードは null", () => {
    expect(evidenceOf(snapshot, "n99")).toBeNull();
  });

  it("スナップショットを書き換えない", () => {
    const before = JSON.stringify(snapshot);
    evidenceOf(snapshot, "n1");
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("同じ選択でも、新しいスナップショットでは最新の内容を返す（根拠が増え、本文が変わる）", () => {
    const next: Snapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((n) => (n.id === "n2" ? { ...n, text: "3 回", evidence: ["r2", "r9"] } : n)),
    };
    const e = evidenceOf(next, "n2")!;
    expect(e.node.text).toBe("3 回");
    expect(e.remarks.map((r) => r.id)).toEqual(["r2", "r9"]);
  });
});
