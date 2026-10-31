import { describe, expect, it } from "vitest";
import type { Remark, Snapshot } from "../../server/src/core/index.ts";
import { evidenceOf } from "../src/evidence.ts";
import { foldingActions } from "./foldingActions.ts";

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
  it.each(["会議の中", "会議の外"] as const)("%s の補足を選ぶと、参照した発言だけを返す", (origin) => {
    const supplement = { id: "s", parent: "n2", kind: "補足", text: "回数の背景", evidence: ["r2"], origin } satisfies Snapshot["nodes"][number];
    const current: Snapshot = { ...snapshot, nodes: [...snapshot.nodes, supplement] };
    const evidence = evidenceOf(current, "s", undefined)!;
    expect(evidence.node).toEqual(supplement);
    expect(evidence.remarks).toEqual([snapshot.remarks[1]]);
  });

  it("ノードと、その根拠の発言を開始時刻の昇順で返す（evidence の並びではなく）", () => {
    const e = evidenceOf(snapshot, "n1", undefined)!;
    expect(e.node).toMatchObject({ id: "n1", kind: "論点", text: "面接は何回か", pointStatus: "未決" });
    expect(e.remarks.map((r) => r.id)).toEqual(["r1", "r3"]);
    expect(e.remarks[0]).toMatchObject({ start: 10, end: 15, track: "相手", text: "一" });
  });

  it("案は状態（planStatus）を保ったまま返す。他のノードの根拠は混ざらない", () => {
    const e = evidenceOf(snapshot, "n2", undefined)!;
    expect(e.node.planStatus).toBe("却下");
    expect(e.remarks.map((r) => r.id)).toEqual(["r2"]);
  });

  it("ルートは根拠の発言なしで返す", () => {
    const e = evidenceOf(snapshot, "root", undefined)!;
    expect(e.node.kind).toBe("会議");
    expect(e.remarks).toEqual([]);
  });

  it("今のマップにないノードは null", () => {
    expect(evidenceOf(snapshot, "n99", undefined)).toBeNull();
  });

  it("スナップショットを書き換えない", () => {
    const before = JSON.stringify(snapshot);
    evidenceOf(snapshot, "n1", undefined);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("同じ選択でも、新しいスナップショットでは最新の内容を返す（根拠が増え、本文が変わる）", () => {
    const next: Snapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((n) => (n.id === "n2" ? { ...n, text: "3 回", evidence: ["r2", "r9"] } : n)),
    };
    const e = evidenceOf(next, "n2", undefined)!;
    expect(e.node.text).toBe("3 回");
    expect(e.remarks.map((r) => r.id)).toEqual(["r2", "r9"]);
  });
});

describe("evidenceOf: 「議題 N 件」（まとめのノード）", () => {
  const done = { talkStatus: "済み" } as const;
  const folded: Snapshot = {
    nodes: [
      { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
      { id: "A", parent: "root", kind: "議題", text: "A", evidence: ["r1"], ...done },
      { id: "B", parent: "root", kind: "議題", text: "B", evidence: ["r1"], ...done },
      { id: "C", parent: "root", kind: "議題", text: "C", evidence: ["r1"] },
    ],
    round: 1,
    changes: [],
    remarks: [remark("r1", 10, "一")],
    currentTopic: "C",
    now: 10,
  };

  it("畳んで並んだ議題のまとめの ID（run:最初の議題）は、その文「議題 2 件」を根拠の発言なしで返す", () => {
    const e = evidenceOf(folded, "run:A", undefined)!;
    expect(e).not.toBeNull();
    expect(e.node).toMatchObject({ id: "run:A", kind: "議題", text: "議題 2 件" });
    expect(e.remarks).toEqual([]);
  });

  it("まとめが無い ID の run: は null（1 件だけ畳んだときは、まとめにならない）", () => {
    expect(evidenceOf(folded, "run:B", undefined)).toBeNull();
    expect(evidenceOf(folded, "run:zzz", undefined)).toBeNull();
    const single: Snapshot = { ...folded, nodes: folded.nodes.map((n) => { if (n.id !== "B") return n; const { talkStatus: _t, ...rest } = n; return rest; }) };
    expect(evidenceOf(single, "run:A", undefined)).toBeNull();
  });

  it("選択によって分かれた後のまとめ（run:E）も、マップと同じ折り畳みから引いて返す", () => {
    const five: Snapshot = {
      ...folded,
      nodes: [
        folded.nodes[0]!,
        ...["A", "B", "C", "E", "F"].map((id) => ({ id, parent: "root", kind: "議題" as const, text: id, evidence: [], ...done })),
        { id: "G", parent: "root", kind: "議題", text: "G", evidence: [] },
      ],
      currentTopic: "G",
    };
    const e = evidenceOf(five, "run:E", undefined)!;
    expect(e).not.toBeNull();
    expect(e.node).toMatchObject({ id: "run:E", kind: "議題", text: "議題 2 件" });
    expect(e.remarks).toEqual([]);
  });

  it("中身の議題 A は今までどおり返す", () => {
    expect(evidenceOf(folded, "A", undefined)!.node.id).toBe("A");
  });
});

describe("evidenceOf: 人が開いた・畳んだノードも、マップと同じ入力で「議題 N 件」に数える", () => {
  const done = { talkStatus: "済み" } as const;
  const topic = (id: string, extra: Partial<Exclude<Snapshot["nodes"][number], { kind: "補足" }>> = {}) => ({ id, parent: "root", kind: "議題" as const, text: id, evidence: ["r1"], ...extra });
  const snapshotOf = (...topics: Snapshot["nodes"]): Snapshot => ({
    nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }, ...topics],
    round: 1,
    changes: [],
    remarks: [remark("r1", 10, "一")],
    currentTopic: "D",
    now: 10,
  });

  it("人が畳んだ話し中の議題 B が A の隣でまとめに入り、「議題 2 件」になる（畳んでいなければまとめは無い）", () => {
    const s = snapshotOf(topic("A", done), topic("B"), topic("D"));
    expect(evidenceOf(s, "run:A", undefined)).toBeNull();
    const e = evidenceOf(s, "run:A", foldingActions(s, [{ type: "toggle", id: "B" }]).human)!;
    expect(e).not.toBeNull();
    expect(e.node).toMatchObject({ id: "run:A", text: "議題 2 件" });
  });

  it("人が開いた A は畳まれず、まとめは B から始まる「議題 2 件」になる（開いていなければ run:A は 3 件）", () => {
    const s = snapshotOf(topic("A", done), topic("B", done), topic("C", done), topic("D"));
    expect(evidenceOf(s, "run:A", undefined)!.node.text).toBe("議題 3 件");
    expect(evidenceOf(s, "run:A", foldingActions(s, [{ type: "point", id: "A" }]).human)).toBeNull();
    expect(evidenceOf(s, "run:B", foldingActions(s, [{ type: "point", id: "A" }]).human)!.node.text).toBe("議題 2 件");
  });
});

describe("evidenceOf: 解いた「議題 N 件」も、マップと同じ人の操作で引く", () => {
  const done = { talkStatus: "済み" } as const;
  const topic = (id: string, extra: Partial<Exclude<Snapshot["nodes"][number], { kind: "補足" }>> = {}) => ({ id, parent: "root", kind: "議題" as const, text: id, evidence: ["r1"], ...extra });
  const s: Snapshot = {
    nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }, topic("A", done), topic("B", done), topic("C")],
    round: 1,
    changes: [],
    remarks: [remark("r1", 10, "一")],
    currentTopic: "C",
    now: 10,
  };

  it("解いていなければ run:A は「議題 2 件」。A・B を解くとまとめが無いので null になり、A は今までどおり返る", () => {
    expect(evidenceOf(s, "run:A", undefined)!.node.text).toBe("議題 2 件");
    const human = foldingActions(s, [{ type: "toggle", id: "run:A" }]).human;
    expect(evidenceOf(s, "run:A", human)).toBeNull();
    expect(evidenceOf(s, "A", human)!.node.id).toBe("A");
  });
});
