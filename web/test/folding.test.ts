import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { foldView, keepTargetOf, pointedNode } from "../src/folding.ts";

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
    const v = foldView(snap(nodes, { currentTopic: "B", now: 100 }), NONE, null, NONE, NONE);
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
    const v = foldView(snap(nodes, { currentTopic: "A", now: 5000 }), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "P1", "P2", "D2"]);
    expect(Object.keys(v.folds)).toEqual(["P1"]);
  });

  it("話し中の議題は、now − touchedAt が 900 秒で畳み、899 秒では畳まない", () => {
    const nodes = (): SnapshotNode[] => [root, node("A", "root", "議題", { touchedAt: 100 }), node("A1", "A", "論点"), node("B", "root")];
    const at900 = foldView(snap(nodes(), { currentTopic: "B", now: 1000 }), NONE, null, NONE, NONE);
    expect(ids(at900.nodes)).toEqual(["root", "A", "B"]);
    expect(Object.keys(at900.folds)).toEqual(["A"]);
    const at899 = foldView(snap(nodes(), { currentTopic: "B", now: 999 }), NONE, null, NONE, NONE);
    expect(ids(at899.nodes)).toEqual(["root", "A", "A1", "B"]);
    expect(at899.folds).toEqual({});
  });

  it("now が無い、または touchedAt が無いときは、時間では畳まない。済みなら畳む", () => {
    const noNow = foldView(snap([root, node("A", "root", "議題", { touchedAt: 0 }), node("B", "root")], { currentTopic: "B" }), NONE, null, NONE, NONE);
    expect(ids(noNow.nodes)).toEqual(["root", "A", "B"]);
    expect(noNow.folds).toEqual({});
    const noTouched = foldView(snap([root, node("A", "root"), node("A1", "A", "論点"), node("B", "root")], { currentTopic: "B", now: 99999 }), NONE, null, NONE, NONE);
    expect(ids(noTouched.nodes)).toEqual(["root", "A", "A1", "B"]);
    const doneNoTime = foldView(snap([root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")], { currentTopic: "B" }), NONE, null, NONE, NONE);
    expect(ids(doneNoTime.nodes)).toEqual(["root", "A", "B"]);
  });

  it("今の議題は、済みでも 900 秒以上でも畳まない", () => {
    const doneNow = foldView(snap([root, node("A", "root", "議題", done), node("A1", "A", "論点")], { currentTopic: "A", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(doneNow.nodes)).toEqual(["root", "A", "A1"]);
    const staleNow = foldView(snap([root, node("A", "root", "議題", { touchedAt: 0 }), node("A1", "A", "論点")], { currentTopic: "A", now: 5000 }), NONE, null, NONE, NONE);
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
    const v = foldView(snap(nodes, { currentTopic: "A1", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toContain("A");
    expect(v.folds["A"]).toBeUndefined();
    expect(ids(v.nodes)).toContain("A1");
    expect(ids(v.nodes)).toContain("A1x");
    expect(Object.keys(v.folds)).toEqual(["A2", "S"]);
  });

  it("今の議題の中の済みの論点は畳む（今の議題自身は畳まない）", () => {
    const nodes = [root, node("A", "root"), node("P", "A", "論点", done), node("D", "P", "決定")];
    const v = foldView(snap(nodes, { currentTopic: "A", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "P"]);
    expect(v.folds["P"]).toBeDefined();
  });

  it("開く上書きに入れたノードは畳まない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), new Set(["A"]), null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "A1", "B"]);
    expect(v.folds).toEqual({});
  });
});

describe("foldView: 子孫を見せない", () => {
  it("子が親より前に並んでいても（移動後）、畳んだ親の子孫は見せない", () => {
    const nodes = [root, node("A1", "A", "論点"), node("A", "root", "議題", done), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "B"]);
    expect(v.shownAs["A1"]).toBe("A");
  });

  it("畳んだ議題の子・孫は nodes に入らない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("A1a", "A1", "決定"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, null, NONE, NONE);
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
    const v = foldView(snap(base(), { currentTopic: "C", now: 10 }), NONE, null, NONE, NONE);
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
    const v = foldView(snap(nodes, { currentTopic: "X", now: 10 }), NONE, null, NONE, NONE);
    expect(v.nodes.map((n) => (n.id === "X" || n.id === "Y" || n.id === "root" ? n.id : "RUN"))).toEqual(["root", "X", "RUN", "Y"]);
  });

  it("まとめた議題とその子孫は見せない", () => {
    const v = foldView(snap(base(), { currentTopic: "C", now: 10 }), NONE, null, NONE, NONE);
    for (const id of ["A", "B", "A1", "B1"]) expect(ids(v.nodes)).not.toContain(id);
  });

  it("畳んだ議題が 1 つだけなら、まとめない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("C", "root")];
    const v = foldView(snap(nodes, { currentTopic: "C", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "C"]);
    expect(v.summaries.size).toBe(0);
    expect(v.folds["A"]).toBeDefined();
  });

  it("間に畳んでいない兄弟があれば、まとめない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("M", "root"), node("B", "root", "議題", done), node("C", "root")];
    const v = foldView(snap(nodes, { currentTopic: "C", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "M", "B", "C"]);
    expect(v.summaries.size).toBe(0);
  });

  it("親が違えば、まとめない", () => {
    const nodes = [root, node("P", "root"), node("Q", "root"), node("A", "P", "議題", done), node("B", "Q", "議題", done)];
    const v = foldView(snap(nodes, { currentTopic: "P", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "P", "Q", "A", "B"]);
    expect(v.summaries.size).toBe(0);
  });

  it("畳んだ論点はまとめない（2 つ続いても別々に畳む）", () => {
    const nodes = [root, node("A", "root"), node("P1", "A", "論点", done), node("P2", "A", "論点", done)];
    const v = foldView(snap(nodes, { currentTopic: "A", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "P1", "P2"]);
    expect(v.summaries.size).toBe(0);
    expect(Object.keys(v.folds)).toEqual(["P1", "P2"]);
  });

  it("時間で畳んだ議題と済みの議題も、続いていればまとめる。3 つなら N は 3", () => {
    const nodes = [root, node("A", "root", "議題", done), node("B", "root", "議題", { touchedAt: 0 }), node("C", "root", "議題", done), node("D", "root")];
    const v = foldView(snap(nodes, { currentTopic: "D", now: 900 }), NONE, null, NONE, NONE);
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
    const v = foldView(snap(deep(), { currentTopic: "Z", now: 10 }), NONE, null, NONE, NONE);
    expect(v.folds["A"]).toEqual({ hint: "決定 2・TODO 1・未決 1", hidden: 5 });
  });

  it("0 の項目は書かない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("T", "A", "TODO"), node("Z", "root")];
    const v = foldView(snap(nodes, { currentTopic: "Z", now: 10 }), NONE, null, NONE, NONE);
    expect(v.folds["A"]).toEqual({ hint: "TODO 1", hidden: 1 });
  });

  it("決定済みの論点は未決に数えない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("P", "A", "論点", { pointStatus: "決定済み" }), node("Z", "root")];
    expect(foldView(snap(nodes, { currentTopic: "Z", now: 10 }), NONE, null, NONE, NONE).folds["A"]).toEqual({ hint: null, hidden: 1 });
  });

  it("3 つとも 0 なら hint は null。子が無ければ hidden は 0", () => {
    const nodes = [root, node("A", "root", "議題", done), node("Z", "root")];
    expect(foldView(snap(nodes, { currentTopic: "Z", now: 10 }), NONE, null, NONE, NONE).folds["A"]).toEqual({ hint: null, hidden: 0 });
  });

  it("畳んだ論点の手がかりも子孫から作る", () => {
    const nodes = [root, node("A", "root"), node("P", "A", "論点", done), node("D", "P", "決定"), node("T", "P", "TODO")];
    expect(foldView(snap(nodes, { currentTopic: "A", now: 10 }), NONE, null, NONE, NONE).folds["P"]).toEqual({ hint: "決定 1・TODO 1", hidden: 2 });
  });

  it("まとめのノードの hint は「最初 〜 最後」。hidden はまとめた議題とその子孫の総数", () => {
    const nodes = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("A1", "A", "論点"), node("B1", "B", "決定"), node("B2", "B", "TODO"), node("C", "root")];
    const v = foldView(snap(nodes, { currentTopic: "C", now: 10 }), NONE, null, NONE, NONE);
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
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, changed: [["C1", 5]] }), NONE, null, NONE, NONE);
    expect([...v.blink]).toEqual(["C1"]);
  });

  it("畳んだ議題の孫が今回変わると、その畳んだ議題が入る（孫は入らない）", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, changed: [["A1a", 5]] }), NONE, null, NONE, NONE);
    expect([...v.blink]).toEqual(["A"]);
  });

  it("まとめた議題の中が変わると、まとめのノードが入る", () => {
    const ns = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("B1", "B", "論点"), node("C", "root")];
    const v = foldView(snap(ns, { currentTopic: "C", now: 10, changed: [["B1", 5]] }), NONE, null, NONE, NONE);
    const run = v.nodes[1]!;
    expect([...v.blink]).toEqual([run.id]);
  });

  it("まとめた議題自身が変わっても、まとめのノードが入る", () => {
    const ns = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("C", "root")];
    const v = foldView(snap(ns, { currentTopic: "C", now: 10, changed: [["A", 5]] }), NONE, null, NONE, NONE);
    expect([...v.blink]).toEqual([v.nodes[1]!.id]);
  });

  it("前の round の変化は入らない", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, round: 5, changed: [["A1a", 4], ["C1", 4]] }), NONE, null, NONE, NONE);
    expect(v.blink.size).toBe(0);
  });

  it("畳んだ中と見せるノードの両方が変われば、両方入る", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, changed: [["A1a", 5], ["C1", 5]] }), NONE, null, NONE, NONE);
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
    const v = foldView(snap(ns, { currentTopic: "C", now: 10 }), NONE, null, NONE, NONE);
    const run = v.nodes[1]!.id;
    expect(v.shownAs["A"]).toBe(run);
    expect(v.shownAs["B"]).toBe(run);
    expect(v.shownAs["A1"]).toBe(run);
    expect(v.shownAs["A1a"]).toBe(run);
    expect(v.shownAs["Pd"]).toBe("P");
    expect(v.shownAs["C"]).toBeUndefined();
  });
});

describe("foldView: 選んだノードの祖先は畳まない（選んだノード自身は畳まれうる）", () => {
  it("済みの議題の下の済みの論点を選ぶと、祖先の議題は畳まれず、選んだ論点は畳んだノードとして見える", () => {
    const nodes = [root, node("A", "root", "議題", done), node("P", "A", "論点", done), node("D", "P", "決定"), node("B", "root")];
    const none = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(none.nodes)).toEqual(["root", "A", "B"]);
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, "P", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "P", "B"]);
    expect(Object.keys(v.folds)).toEqual(["P"]);
    expect(v.shownAs["D"]).toBe("P");
  });

  it("古い話し中の議題の下のノードを選ぶと、その議題は畳まれず、選んだノードが見える", () => {
    const nodes = [root, node("A", "root", "議題", { touchedAt: 0 }), node("A1", "A", "論点"), node("A1a", "A1", "決定"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 5000 }), NONE, "A1a", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "A1", "A1a", "B"]);
    expect(v.folds).toEqual({});
  });

  it("選んだ議題自身は、畳む条件に当たれば畳まれる（畳んだノードとして見せるノードに入る）", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, "A", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "B"]);
    expect(v.folds["A"]).toEqual({ hint: null, hidden: 1 });
  });

  it("選んだノードの兄弟や子孫は守らない。畳む条件に当たる兄弟は畳まれたまま", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点", done), node("A2", "A", "論点", done), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, "A1", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "A1", "A2", "B"]);
    expect(Object.keys(v.folds).sort()).toEqual(["A1", "A2"]);
  });

  it("選んでいない（null）ときと、ノードにない ID のときは、選択なしと同じ結果", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root", "議題", done), node("C", "root")];
    const base = foldView(snap(nodes, { currentTopic: "C", now: 10 }), NONE, null, NONE, NONE);
    expect(foldView(snap(nodes, { currentTopic: "C", now: 10 }), NONE, "nope", NONE, NONE)).toEqual(base);
    expect(foldView(snap(nodes, { currentTopic: "C", now: 10 }), NONE, "run:A", NONE, NONE)).toEqual(base);
  });

  it("入力のスナップショットを書き換えない", () => {
    const s = snap([root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")], { currentTopic: "B", now: 10 });
    const before = JSON.stringify(s);
    foldView(s, NONE, "A1", NONE, NONE);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("foldView: 選んだ畳んだ議題は「議題 N 件」に入れず、まとめはその前後で分かれる", () => {
  const five = () => [
    root,
    node("A", "root", "議題", done),
    node("B", "root", "議題", done),
    node("C", "root", "議題", done),
    node("E", "root", "議題", done),
    node("F", "root", "議題", done),
    node("G", "root"),
  ];

  it("選んでいなければ 5 件が 1 つにまとまる", () => {
    const v = foldView(snap(five(), { currentTopic: "G", now: 10 }), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "run:A", "G"]);
    expect(v.nodes[1]!.text).toBe("議題 5 件");
  });

  it("真ん中の C を選ぶと、前の 2 件と後ろの 2 件が別のまとめになり、C は単独の畳んだ議題として残る", () => {
    const v = foldView(snap(five(), { currentTopic: "G", now: 10 }), NONE, "C", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "run:A", "C", "run:E", "G"]);
    expect(v.nodes[1]!.text).toBe("議題 2 件");
    expect(v.nodes[3]!.text).toBe("議題 2 件");
    expect([...v.summaries].sort()).toEqual(["run:A", "run:E"]);
    expect(v.folds["C"]).toEqual({ hint: null, hidden: 0 });
    expect(v.shownAs["A"]).toBe("run:A");
    expect(v.shownAs["F"]).toBe("run:E");
  });

  it("C を選んで生じたまとめ run:E を選ぶと、C の選択が外れても run:E は E から始まるまとめとして残る", () => {
    const afterC = foldView(snap(five(), { currentTopic: "G", now: 10 }), NONE, "C", NONE, NONE);
    expect(afterC.summaries.has("run:E")).toBe(true);
    const v = foldView(snap(five(), { currentTopic: "G", now: 10 }), NONE, "run:E", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "run:A", "run:E", "G"]);
    expect(v.nodes[1]!.text).toBe("議題 3 件");
    expect(v.nodes[2]!.text).toBe("議題 2 件");
  });

  it("端の A を選ぶと、A は単独で、残りの 4 件が 1 つのまとめになる", () => {
    const v = foldView(snap(five(), { currentTopic: "G", now: 10 }), NONE, "A", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "run:B", "G"]);
    expect(v.nodes[2]!.text).toBe("議題 4 件");
  });

  it("入れ子のまとめ run:A を選んでも、親の済み議題 P は畳まれず、まとめは見えたまま残る", () => {
    const nodes = [
      root,
      node("P", "root", "議題", done),
      node("A", "P", "議題", done),
      node("B", "P", "議題", done),
      node("C", "P", "論点"),
      node("G", "root"),
    ];
    const v = foldView(snap(nodes, { currentTopic: "G", now: 10 }), NONE, "run:A", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "P", "run:A", "C", "G"]);
    expect(v.folds["P"]).toBeUndefined();
    expect(v.shownAs["A"]).toBe("run:A");
    expect(v.shownAs["B"]).toBe("run:A");
  });

  it("スナップショットに無い先頭議題を指す run: の ID は、何も保護しない", () => {
    const nodes = [
      root,
      node("P", "root", "議題", done),
      node("A", "P", "議題", done),
      node("B", "P", "議題", done),
      node("C", "P", "論点"),
      node("G", "root"),
    ];
    const v = foldView(snap(nodes, { currentTopic: "G", now: 10 }), NONE, "run:zzz", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "P", "G"]);
    expect(v.folds["P"]).toBeDefined();
  });

  it("3 件の真ん中を選ぶと、前後は 1 件ずつでまとめにならず、3 つとも単独の畳んだ議題になる", () => {
    const nodes = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("C", "root", "議題", done), node("G", "root")];
    const v = foldView(snap(nodes, { currentTopic: "G", now: 10 }), NONE, "B", NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "B", "C", "G"]);
    expect(v.summaries.size).toBe(0);
    expect(Object.keys(v.folds).sort()).toEqual(["A", "B", "C"]);
  });
});

describe("foldView: 人が畳んだもの（第 4 引数）", () => {
  const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);

  it("話し中の議題でも、人が畳んだものは畳む（子孫は見せず、畳んだノードの隠れた数に数える）。畳んでいなければ開いたまま", () => {
    const nodes = [root, node("A", "root"), node("A1", "A", "論点"), node("A2", "A", "論点"), node("B", "root")];
    const s = snap(nodes, { currentTopic: "B", now: 10 });
    expect(ids(foldView(s, NONE, null, NONE, NONE).nodes)).toEqual(["root", "A", "A1", "A2", "B"]);
    const v = foldView(s, NONE, null, set("A"), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "B"]);
    expect(v.folds["A"]).toMatchObject({ hidden: 2 });
    expect(v.shownAs).toEqual({ A1: "A", A2: "A" });
  });

  it("話し中の論点も、人が畳んだら畳む", () => {
    const nodes = [root, node("A", "root"), node("P", "A", "論点"), node("D", "P", "決定")];
    const v = foldView(snap(nodes, { currentTopic: "A", now: 10 }), NONE, null, set("P"), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "P"]);
    expect(v.folds["P"]).toMatchObject({ hidden: 1 });
  });

  it("人が開いたものは、同じ ID を人が畳んだ集合にも持っていても畳まない（開いた方が引かれる）", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")];
    const s = snap(nodes, { currentTopic: "B", now: 10 });
    expect(ids(foldView(s, set("A"), null, set("A"), NONE).nodes)).toEqual(["root", "A", "A1", "B"]);
    expect(ids(foldView(s, NONE, null, set("A"), NONE).nodes)).toEqual(["root", "A", "B"]);
  });

  it("人が畳んだものは、選んだノードの祖先でも畳む（選択の保護より優先）。選んだノードは隠れる", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")];
    const s = snap(nodes, { currentTopic: "B", now: 10 });
    // 対照: 人が畳んでいなければ、選んだ A1 の祖先 A は畳まれず A1 が見える
    expect(ids(foldView(s, NONE, "A1", NONE, NONE).nodes)).toEqual(["root", "A", "A1", "B"]);
    const v = foldView(s, NONE, "A1", set("A"), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "B"]);
    expect(v.folds["A"]).toMatchObject({ hidden: 1 });
  });

  it("人が畳んだものが話し中の祖先でも、選んだ子孫より優先して畳む", () => {
    const nodes = [root, node("A", "root"), node("A1", "A", "論点"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, "A1", set("A"), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "B"]);
  });

  it("選んだノード自身を人が畳んだら畳む（選んだ畳んだ議題は残るが、中は見せない）", () => {
    const nodes = [root, node("A", "root"), node("A1", "A", "論点"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, "A", set("A"), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "B"]);
    expect(Object.keys(v.folds)).toEqual(["A"]);
  });

  it("今の議題とその祖先は、人が畳んだ集合に入っていても畳まない", () => {
    const nodes = [root, node("A", "root"), node("P", "A", "論点"), node("P1", "P", "決定"), node("B", "root")];
    const s = snap(nodes, { currentTopic: "A", now: 10 });
    const v = foldView(s, NONE, null, set("root", "A"), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "P", "P1", "B"]);
    expect(v.folds).toEqual({});
    // 今の議題が論点でも、その祖先の議題を畳まない
    const v2 = foldView(snap(nodes, { currentTopic: "P", now: 10 }), NONE, null, set("A", "P"), NONE);
    expect(ids(v2.nodes)).toEqual(["root", "A", "P", "P1", "B"]);
  });

  it("議題・論点でないノード（決定・会議のルート）は、人が畳む集合に入れても畳まない", () => {
    const nodes = [root, node("A", "root"), node("D", "A", "決定"), node("D1", "D", "TODO")];
    const v = foldView(snap(nodes, { currentTopic: "A", now: 10 }), NONE, null, set("D", "root"), NONE);
    expect(ids(v.nodes)).toEqual(["root", "A", "D", "D1"]);
    expect(v.folds).toEqual({});
  });

  it("人が畳んだ議題は、隣の畳んだ議題と「議題 N 件」にまとまる", () => {
    const nodes = [root, node("A", "root", "議題", done), node("B", "root"), node("C", "root")];
    const s = snap(nodes, { currentTopic: "C", now: 10 });
    expect(Object.keys(foldView(s, NONE, null, NONE, NONE).folds)).toEqual(["A"]);
    const v = foldView(s, NONE, null, set("B"), NONE);
    expect(ids(v.nodes)).toEqual(["root", "run:A", "C"]);
    expect(v.folds["run:A"]).toMatchObject({ hidden: 2 });
  });

  it("入力のスナップショットも、渡した集合も書き換えない", () => {
    const nodes = [root, node("A", "root"), node("A1", "A", "論点"), node("B", "root")];
    const s = snap(nodes, { currentTopic: "B", now: 10 });
    const before = JSON.stringify(s);
    const opened = set("B");
    const folded = set("A");
    foldView(s, opened, "A1", folded, NONE);
    expect(JSON.stringify(s)).toBe(before);
    expect([...opened]).toEqual(["B"]);
    expect([...folded]).toEqual(["A"]);
  });
});

describe("foldView: 「議題 N 件」を解いた議題（第 5 引数）と runs", () => {
  const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);
  // 畳んだ議題 A・D が並び、話し中の B が続く。A の下には論点 A1
  const pair = () => [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("D", "root", "議題", done), node("B", "root")];
  const pairSnap = () => snap(pair(), { currentTopic: "B", now: 10 });

  it("対照: 解いていなければ run:A にまとまり、runs に入っている議題の ID が並び順で入る", () => {
    const v = foldView(pairSnap(), NONE, null, NONE, NONE);
    expect(ids(v.nodes)).toEqual(["root", "run:A", "B"]);
    expect(v.runs).toEqual({ "run:A": ["A", "D"] });
  });

  it("解いた議題 A・D はまとめに入らず、それぞれ畳んだ議題として並ぶ（中身は畳んだまま、まとめは無く、runs も空）", () => {
    const v = foldView(pairSnap(), NONE, null, NONE, set("A", "D"));
    expect(ids(v.nodes)).toEqual(["root", "A", "D", "B"]);
    expect(Object.keys(v.folds).sort()).toEqual(["A", "D"]);
    expect(v.folds["A"]).toMatchObject({ hidden: 1 });
    expect(v.summaries.size).toBe(0);
    expect(v.shownAs).toEqual({ A1: "A" });
    expect(v.runs).toEqual({});
  });

  it("人が開いた議題は、解いた集合に入っていても開いたまま（解いても中身は開かない。開くのは人が開いた集合だけ）", () => {
    const opened = foldView(pairSnap(), set("A"), null, NONE, set("A", "D"));
    expect(ids(opened.nodes)).toEqual(["root", "A", "A1", "D", "B"]);
    expect(Object.keys(opened.folds)).toEqual(["D"]);
  });

  it("集合に入れた議題だけが外れる: D・A・E・F の並びで A だけ解くと、D と A は単独で並び、E・F は run:E にまとまる", () => {
    const nodes = [root, node("D", "root", "議題", done), node("A", "root", "議題", done), node("E", "root", "議題", done), node("F", "root", "議題", done), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, null, NONE, set("A"));
    expect(ids(v.nodes)).toEqual(["root", "D", "A", "run:E", "B"]);
    expect(v.runs).toEqual({ "run:E": ["E", "F"] });
  });

  it("後から畳まれた議題は、解いた集合に入っていなければ新しくまとまる（run: の ID ではなく、議題の ID の集合で覚える）", () => {
    // 最初は A・D だけが畳まれて並ぶ。解いた後の反映で、続く E・F も畳まれた
    const nodes = [root, node("A", "root", "議題", done), node("D", "root", "議題", done), node("E", "root", "議題", done), node("F", "root", "議題", done), node("B", "root")];
    const s = snap(nodes, { currentTopic: "B", now: 10 });
    const v = foldView(s, NONE, null, NONE, set("A", "D"));
    expect(ids(v.nodes)).toEqual(["root", "A", "D", "run:E", "B"]);
    expect(v.runs).toEqual({ "run:E": ["E", "F"] });
  });

  it("畳まれていない・存在しない ID が入っていても、何も起きない", () => {
    const withGhost = foldView(pairSnap(), NONE, null, NONE, set("B", "zzz"));
    expect(withGhost).toEqual(foldView(pairSnap(), NONE, null, NONE, NONE));
  });

  it("複数のまとめがあれば、runs にまとめごとの議題の並びが入る", () => {
    const nodes = [root, node("A", "root", "議題", done), node("D", "root", "議題", done), node("B", "root"), node("E", "root", "議題", done), node("F", "root", "議題", done), node("G", "root", "議題", done)];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), NONE, null, NONE, NONE);
    expect(v.runs).toEqual({ "run:A": ["A", "D"], "run:E": ["E", "F", "G"] });
  });

  it("渡した集合を書き換えない", () => {
    const unbundled = set("A", "D");
    foldView(pairSnap(), NONE, null, NONE, unbundled);
    expect([...unbundled]).toEqual(["A", "D"]);
  });
});

describe("pointedNode: 「変わったこと」から指したノードの祖先と、人が開いた集合に足すか", () => {
  const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);
  // A（済み）の下に A1（済みの論点）と決定 A1a。B が話し中。C は話し中の議題
  const nodes = [
    root,
    node("A", "root", "議題", done),
    node("A1", "A", "論点", done),
    node("A1a", "A1", "決定"),
    node("B", "root"),
    node("B1", "B", "論点"),
    node("C", "root"),
  ];
  const s = snap(nodes, { currentTopic: "B", now: 10 });
  const sorted = (xs: readonly string[]) => [...xs].sort();

  it("畳んだ議題 A を指すと、祖先は root で、A は畳む条件に当たるので開く", () => {
    const r = pointedNode(s, "A", NONE, NONE, NONE)!;
    expect(sorted(r.ancestors)).toEqual(["root"]);
    expect(r.open).toBe(true);
  });

  it("畳んだ議題の中に隠れた決定 A1a を指すと、祖先は root・A・A1。決定は畳まないので開かない", () => {
    const r = pointedNode(s, "A1a", NONE, NONE, NONE)!;
    expect(sorted(r.ancestors)).toEqual(["A", "A1", "root"]);
    expect(r.open).toBe(false);
  });

  it("畳んだ議題の中に隠れた、畳む条件に当たる論点 A1 を指すと、祖先は root・A で、A1 は開く", () => {
    const r = pointedNode(s, "A1", NONE, NONE, NONE)!;
    expect(sorted(r.ancestors)).toEqual(["A", "root"]);
    expect(r.open).toBe(true);
  });

  it("畳んでいないノード（話し中の C・今の議題 B・B の論点）を指しても開かない", () => {
    for (const id of ["C", "B", "B1"]) expect(pointedNode(s, id, NONE, NONE, NONE)!.open).toBe(false);
  });

  it("祖先 A を人が畳んでいても、結果は変わらない（祖先の人の畳みを外した上で判定する）", () => {
    const r = pointedNode(s, "A1", NONE, set("A"), NONE)!;
    expect(sorted(r.ancestors)).toEqual(["A", "root"]);
    expect(r.open).toBe(true);
  });

  it("指したノード自身を人が畳んでいれば、開く（話し中の議題 C でも）", () => {
    expect(pointedNode(s, "C", NONE, set("C"), NONE)!.open).toBe(true);
  });

  it("スナップショットに無い ID（まとめの run:A や消えたノード）は null", () => {
    expect(pointedNode(s, "run:A", NONE, NONE, NONE)).toBeNull();
    expect(pointedNode(s, "gone", NONE, NONE, NONE)).toBeNull();
  });

  it("まとめの中の畳んだ議題 D を指すと、D は開く（選んだ議題はまとめに入れない）", () => {
    const run = snap([root, node("A", "root", "議題", done), node("D", "root", "議題", done), node("B", "root")], { currentTopic: "B", now: 10 });
    const r = pointedNode(run, "D", NONE, NONE, NONE)!;
    expect(sorted(r.ancestors)).toEqual(["root"]);
    expect(r.open).toBe(true);
  });

  it("入力のスナップショットも、渡した集合も書き換えない", () => {
    const before = JSON.stringify(s);
    const opened = set("B");
    const folded = set("A");
    const unbundled = set("C");
    pointedNode(s, "A1", opened, folded, unbundled);
    expect(JSON.stringify(s)).toBe(before);
    expect([[...opened], [...folded], [...unbundled]]).toEqual([["B"], ["A"], ["C"]]);
  });
});

describe("keepTargetOf: 位置を保つ基準のノード（開閉の前の ID を、いま見えている側に置き換える）", () => {
  const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);
  const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("D", "root", "議題", done), node("B", "root")];
  const s = snap(nodes, { currentTopic: "B", now: 10 });

  it("解いて無くなったまとめ run:A は、見えている最初の議題 A になる（対照: まだ解く前は run:A のまま）", () => {
    expect(keepTargetOf(foldView(s, NONE, null, NONE, NONE), "run:A")).toBe("run:A");
    expect(keepTargetOf(foldView(s, NONE, null, NONE, set("A", "D")), "run:A")).toBe("A");
  });

  it("まとめに隠れた議題は、まとめのノードになる。見えているノードと、still（view なし）はそのまま", () => {
    const view = foldView(s, NONE, null, NONE, NONE);
    expect(keepTargetOf(view, "D")).toBe("run:A");
    expect(keepTargetOf(view, "B")).toBe("B");
    expect(keepTargetOf(null, "run:A")).toBe("run:A");
  });
});
