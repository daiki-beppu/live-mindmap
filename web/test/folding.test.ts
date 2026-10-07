import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { foldView } from "../src/folding.ts";

type Extra = Partial<Pick<SnapshotNode, "talkStatus" | "touchedAt" | "pointStatus">>;
const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題", extra: Extra = {}): SnapshotNode => ({
  id,
  parent,
  kind,
  text: id,
  evidence: parent ? ["r1"] : [],
  ...extra,
});
const done: Extra = { talkStatus: "済み" };

const snap = (nodes: SnapshotNode[], extra: { currentTopic?: string; now?: number; round?: number; changed?: Array<[string, number]> } = {}): Snapshot => {
  const round = extra.round ?? 5;
  return {
    nodes,
    round,
    changes: (extra.changed ?? []).map(([n, r]) => ({ change: "更新", node: n, kind: "議題", text: n, round: r, at: 0 }) as Snapshot["changes"][number]),
    remarks: [],
    ...(extra.currentTopic !== undefined ? { currentTopic: extra.currentTopic } : {}),
    ...(extra.now !== undefined ? { now: extra.now } : {}),
  };
};
const NONE: ReadonlySet<string> = new Set();
const ids = (nodes: SnapshotNode[]) => nodes.map((n) => n.id);
const root = node("root", null, "会議");

describe("foldView: 畳む集合", () => {
  it("済みの議題を畳む（子孫は見せない）。話し中の議題は畳まない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root"), node("B1", "B", "論点")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 100 }), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "B", "B1"]);
    expect(Object.keys(v.folds)).toEqual(["A"]);
  });

  it("済みの論点を畳む。話し中の論点は 900 秒たっていても畳まない", () => {
    const nodes = [
      root,
      node("A", "root"),
      node("P1", "A", "論点", done),
      node("D1", "P1", "決定"),
      node("P2", "A", "論点", { touchedAt: 0 }),
      node("D2", "P2", "決定"),
    ];
    const v = foldView(snap(nodes, { currentTopic: "A", now: 5000 }), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "P1", "P2", "D2"]);
    expect(Object.keys(v.folds)).toEqual(["P1"]);
  });

  it("話し中の議題は、now − touchedAt が 900 秒で畳み、899 秒では畳まない", () => {
    const nodes = (): SnapshotNode[] => [root, node("A", "root", "議題", { touchedAt: 100 }), node("A1", "A", "論点"), node("B", "root")];
    const at900 = foldView(snap(nodes(), { currentTopic: "B", now: 1000 }), NONE);
    expect(ids(at900.nodes)).toEqual(["root", "A", "B"]);
    expect(Object.keys(at900.folds)).toEqual(["A"]);
    const at899 = foldView(snap(nodes(), { currentTopic: "B", now: 999 }), NONE);
    expect(ids(at899.nodes)).toEqual(["root", "A", "A1", "B"]);
    expect(at899.folds).toEqual({});
  });

  it("now が無い、または touchedAt が無いときは、時間では畳まない。済みなら畳む", () => {
    const noNow = foldView(snap([root, node("A", "root", "議題", { touchedAt: 0 }), node("B", "root")], { currentTopic: "B" }), NONE);
    expect(ids(noNow.nodes)).toEqual(["root", "A", "B"]);
    expect(noNow.folds).toEqual({});
    const noTouched = foldView(snap([root, node("A", "root"), node("A1", "A", "論点"), node("B", "root")], { currentTopic: "B", now: 99999 }), NONE);
    expect(ids(noTouched.nodes)).toEqual(["root", "A", "A1", "B"]);
    const doneNoTime = foldView(snap([root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")], { currentTopic: "B" }), NONE);
    expect(ids(doneNoTime.nodes)).toEqual(["root", "A", "B"]);
  });

  it("今の議題は、済みでも 900 秒以上でも畳まない", () => {
    const doneNow = foldView(snap([root, node("A", "root", "議題", done), node("A1", "A", "論点")], { currentTopic: "A", now: 10 }), NONE);
    expect(ids(doneNow.nodes)).toEqual(["root", "A", "A1"]);
    const staleNow = foldView(snap([root, node("A", "root", "議題", { touchedAt: 0 }), node("A1", "A", "論点")], { currentTopic: "A", now: 5000 }), NONE);
    expect(ids(staleNow.nodes)).toEqual(["root", "A", "A1"]);
  });

  it("今の議題の祖先は、済みでも畳まない。祖先でない済みの兄弟は畳む", () => {
    const nodes = [
      root,
      node("A", "root", "議題", done),
      node("A1", "A", "議題", done),
      node("A2", "A", "議題", done),
      node("A1x", "A1", "論点"),
      node("S", "root", "議題", done),
    ];
    const v = foldView(snap(nodes, { currentTopic: "A1", now: 10 }), NONE);
    expect(ids(v.nodes)).toContain("A");
    expect(v.folds["A"]).toBeUndefined();
    expect(ids(v.nodes)).toContain("A1");
    expect(ids(v.nodes)).toContain("A1x");
    expect(Object.keys(v.folds)).toEqual(["A2", "S"]);
  });

  it("今の議題の中の済みの論点は畳む（今の議題自身は畳まない）", () => {
    const nodes = [root, node("A", "root"), node("P", "A", "論点", done), node("D", "P", "決定")];
    const v = foldView(snap(nodes, { currentTopic: "A", now: 10 }), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "P"]);
    expect(v.folds["P"]).toBeDefined();
  });

  it("開く上書きに入れたノードは畳まない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), new Set(["A"]));
    expect(ids(v.nodes)).toEqual(["root", "A", "A1", "B"]);
    expect(v.folds).toEqual({});
  });
});

describe("foldView: 子孫を見せない", () => {
  it("子が親より前に並んでいても（移動後）、畳んだ親の子孫は見せない", () => {
    const nodes = [root, node("A1", "A", "論点"), node("A", "root", "議題", done), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "B"]);
    expect(v.shownAs["A1"]).toBe("A");
  });

  it("畳んだ議題の子・孫は nodes に入らない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("A1a", "A1", "決定"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE);
    expect(ids(v.nodes)).not.toContain("A1");
    expect(ids(v.nodes)).not.toContain("A1a");
  });
});

describe("foldView: 畳んだ議題のまとめ", () => {
  const base = (): SnapshotNode[] => [
    root,
    node("A", "root", "議題", done),
    node("B", "root", "議題", done),
    node("A1", "A", "論点"),
    node("B1", "B", "決定"),
    node("C", "root"),
  ];

  it("同じ親の下で畳んだ議題が 2 つ続くと、1 つのまとめのノードにする", () => {
    const v = foldView(snap(base(), { currentTopic: "C", now: 10 }), NONE);
    expect(ids(v.nodes)).toHaveLength(3);
    const run = v.nodes[1]!;
    expect(v.nodes[0]!.id).toBe("root");
    expect(v.nodes[2]!.id).toBe("C");
    expect(base().map((n) => n.id)).not.toContain(run.id);
    expect(run.kind).toBe("議題");
    expect(run.parent).toBe("root");
    expect(run.text).toBe("議題 2 件");
    expect(v.folds[run.id]!.hint).toBe("A 〜 B");
    expect(v.summaries.has(run.id)).toBe(true);
    expect(v.folds["A"]).toBeUndefined();
    expect(v.folds["B"]).toBeUndefined();
  });

  it("まとめのノードは、最初の議題の位置に入る", () => {
    const nodes = [root, node("X", "root"), node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root", "議題", done), node("Y", "root")];
    const v = foldView(snap(nodes, { currentTopic: "X", now: 10 }), NONE);
    expect(v.nodes.map((n) => (n.id === "X" || n.id === "Y" || n.id === "root" ? n.id : "RUN"))).toEqual(["root", "X", "RUN", "Y"]);
  });

  it("まとめた議題とその子孫は見せない", () => {
    const v = foldView(snap(base(), { currentTopic: "C", now: 10 }), NONE);
    for (const id of ["A", "B", "A1", "B1"]) expect(ids(v.nodes)).not.toContain(id);
  });

  it("畳んだ議題が 1 つだけなら、まとめない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("C", "root")];
    const v = foldView(snap(nodes, { currentTopic: "C", now: 10 }), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "C"]);
    expect(v.summaries.size).toBe(0);
    expect(v.folds["A"]).toBeDefined();
  });

  it("間に畳んでいない兄弟があれば、まとめない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("M", "root"), node("B", "root", "議題", done), node("C", "root")];
    const v = foldView(snap(nodes, { currentTopic: "C", now: 10 }), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "M", "B", "C"]);
    expect(v.summaries.size).toBe(0);
  });

  it("親が違えば、まとめない", () => {
    const nodes = [root, node("P", "root"), node("Q", "root"), node("A", "P", "議題", done), node("B", "Q", "議題", done)];
    const v = foldView(snap(nodes, { currentTopic: "P", now: 10 }), NONE);
    expect(ids(v.nodes)).toEqual(["root", "P", "Q", "A", "B"]);
    expect(v.summaries.size).toBe(0);
  });

  it("畳んだ論点はまとめない（2 つ続いても別々に畳む）", () => {
    const nodes = [root, node("A", "root"), node("P1", "A", "論点", done), node("P2", "A", "論点", done)];
    const v = foldView(snap(nodes, { currentTopic: "A", now: 10 }), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "P1", "P2"]);
    expect(v.summaries.size).toBe(0);
    expect(Object.keys(v.folds)).toEqual(["P1", "P2"]);
  });

  it("時間で畳んだ議題と済みの議題も、続いていればまとめる。3 つなら N は 3", () => {
    const nodes = [root, node("A", "root", "議題", done), node("B", "root", "議題", { touchedAt: 0 }), node("C", "root", "議題", done), node("D", "root")];
    const v = foldView(snap(nodes, { currentTopic: "D", now: 900 }), NONE);
    expect(v.nodes[1]!.text).toBe("議題 3 件");
    expect(v.folds[v.nodes[1]!.id]!.hint).toBe("A 〜 C");
  });
});

describe("foldView: 手がかりの文字と隠れた数", () => {
  const deep = (): SnapshotNode[] => [
    root,
    node("A", "root", "議題", done),
    node("P1", "A", "論点", { pointStatus: "未決" }),
    node("P2", "A", "論点", { pointStatus: "決定済み" }),
    node("D1", "P2", "決定"),
    node("D2", "P2", "決定"),
    node("T1", "P2", "TODO"),
    node("Z", "root"),
  ];

  it("子孫すべて（孫まで）を数えて「決定 2・TODO 1・未決 1」と書き、隠れた数は子孫の数（自分は数えない）", () => {
    const v = foldView(snap(deep(), { currentTopic: "Z", now: 10 }), NONE);
    expect(v.folds["A"]).toEqual({ hint: "決定 2・TODO 1・未決 1", hidden: 5 });
  });

  it("0 の項目は書かない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("T", "A", "TODO"), node("Z", "root")];
    const v = foldView(snap(nodes, { currentTopic: "Z", now: 10 }), NONE);
    expect(v.folds["A"]).toEqual({ hint: "TODO 1", hidden: 1 });
  });

  it("決定済みの論点は未決に数えない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("P", "A", "論点", { pointStatus: "決定済み" }), node("Z", "root")];
    expect(foldView(snap(nodes, { currentTopic: "Z", now: 10 }), NONE).folds["A"]).toEqual({ hint: null, hidden: 1 });
  });

  it("3 つとも 0 なら hint は null。子が無ければ hidden は 0", () => {
    const nodes = [root, node("A", "root", "議題", done), node("Z", "root")];
    expect(foldView(snap(nodes, { currentTopic: "Z", now: 10 }), NONE).folds["A"]).toEqual({ hint: null, hidden: 0 });
  });

  it("畳んだ論点の手がかりも子孫から作る", () => {
    const nodes = [root, node("A", "root"), node("P", "A", "論点", done), node("D", "P", "決定"), node("T", "P", "TODO")];
    expect(foldView(snap(nodes, { currentTopic: "A", now: 10 }), NONE).folds["P"]).toEqual({ hint: "決定 1・TODO 1", hidden: 2 });
  });

  it("まとめのノードの hint は「最初 〜 最後」。hidden はまとめた議題とその子孫の総数", () => {
    const nodes = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("A1", "A", "論点"), node("B1", "B", "決定"), node("B2", "B", "TODO"), node("C", "root")];
    const v = foldView(snap(nodes, { currentTopic: "C", now: 10 }), NONE);
    const run = v.nodes[1]!;
    expect(v.folds[run.id]).toEqual({ hint: "A 〜 B", hidden: 5 });
  });
});

describe("foldView: 点滅させるノード", () => {
  const nodes = (): SnapshotNode[] => [
    root,
    node("A", "root", "議題", done),
    node("A1", "A", "論点"),
    node("A1a", "A1", "決定"),
    node("C", "root"),
    node("C1", "C", "論点"),
  ];

  it("見せるノードで今回変わったものが入る", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, changed: [["C1", 5]] }), NONE);
    expect([...v.blink]).toEqual(["C1"]);
  });

  it("畳んだ議題の孫が今回変わると、その畳んだ議題が入る（孫は入らない）", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, changed: [["A1a", 5]] }), NONE);
    expect([...v.blink]).toEqual(["A"]);
  });

  it("まとめた議題の中が変わると、まとめのノードが入る", () => {
    const ns = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("B1", "B", "論点"), node("C", "root")];
    const v = foldView(snap(ns, { currentTopic: "C", now: 10, changed: [["B1", 5]] }), NONE);
    const run = v.nodes[1]!;
    expect([...v.blink]).toEqual([run.id]);
  });

  it("まとめた議題自身が変わっても、まとめのノードが入る", () => {
    const ns = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("C", "root")];
    const v = foldView(snap(ns, { currentTopic: "C", now: 10, changed: [["A", 5]] }), NONE);
    expect([...v.blink]).toEqual([v.nodes[1]!.id]);
  });

  it("前の round の変化は入らない", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, round: 5, changed: [["A1a", 4], ["C1", 4]] }), NONE);
    expect(v.blink.size).toBe(0);
  });

  it("畳んだ中と見せるノードの両方が変われば、両方入る", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, changed: [["A1a", 5], ["C1", 5]] }), NONE);
    expect(new Set(v.blink)).toEqual(new Set(["A", "C1"]));
  });
});

describe("foldView: 隠れたノードの置き換え先", () => {
  it("隠れたノードは畳んだノードに、まとめた議題とその子孫はまとめのノードに対応する", () => {
    const ns = [
      root,
      node("A", "root", "議題", done),
      node("B", "root", "議題", done),
      node("A1", "A", "論点"),
      node("A1a", "A1", "決定"),
      node("C", "root"),
      node("P", "C", "論点", done),
      node("Pd", "P", "決定"),
    ];
    const v = foldView(snap(ns, { currentTopic: "C", now: 10 }), NONE);
    const run = v.nodes[1]!.id;
    expect(v.shownAs["A"]).toBe(run);
    expect(v.shownAs["B"]).toBe(run);
    expect(v.shownAs["A1"]).toBe(run);
    expect(v.shownAs["A1a"]).toBe(run);
    expect(v.shownAs["Pd"]).toBe("P");
    expect(v.shownAs["C"]).toBeUndefined();
  });
});
