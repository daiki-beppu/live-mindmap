import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { foldView, keepTargetOf, refold, type FoldView, type Openness } from "../src/folding.ts";
import { foldingActions } from "./foldingActions.ts";

type Extra = Partial<Pick<SnapshotNode, "talkStatus" | "touchedAt" | "pointStatus">>;
const node = (id: string, parent: string | null, kind: Exclude<SnapshotNode["kind"], "補足"> = "議題", extra: Extra = {}): Exclude<SnapshotNode, { kind: "補足" }> => ({
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

const ids = (nodes: SnapshotNode[]) => nodes.map((n) => n.id);
const root = node("root", null, "会議");
const idsInState = (view: FoldView, state: Openness["state"]) => Object.keys(view.openness).filter((id) => view.openness[id]!.state === state);

describe("foldView: 親に添えた補足", () => {
  it("親を畳むと補足も隠れ、開くと同じ補足が戻る", () => {
    const supplement = { id: "s", parent: "A1", kind: "補足", text: "用語の説明", evidence: ["r1"], origin: "会議の外" } satisfies SnapshotNode;
    const snapshot = snap([root, node("A", "root"), node("A1", "A", "要点"), supplement, node("B", "root")], { currentTopic: "B" });
    const open = foldView(snapshot, undefined, null);
    expect(ids(open.nodes)).toContain("s");
    const folded = foldingActions(snapshot, [{ type: "toggle", id: "A" }]);
    expect(ids(folded.view.nodes)).toEqual(["root", "A", "B"]);
    expect(folded.view.shownAs.s).toBe("A");
    const reopened = foldingActions(snapshot, [{ type: "toggle", id: "A" }], folded.human);
    expect(reopened.view.nodes.find((n) => n.id === "s")).toEqual(supplement);
  });

  it("話し中の親に添えた補足は、時間だけが進んでも消えない", () => {
    const supplement = { id: "s", parent: "A1", kind: "補足", text: "会議での背景", evidence: ["r1"], origin: "会議の中", touchedAt: 0 } satisfies SnapshotNode;
    const snapshot = snap([root, node("A", "root"), node("A1", "A", "要点"), supplement], { currentTopic: "A", now: 0 });
    expect(foldView(snapshot, undefined, null).nodes.find((n) => n.id === "s")).toEqual(supplement);
    expect(foldView({ ...snapshot, now: 100_000 }, undefined, null).nodes.find((n) => n.id === "s")).toEqual(supplement);
  });
});

describe("foldView: 見せるノードごとの開閉", () => {
  it("表示 ID と開閉のキーが一致し、まとめ・畳み・開き・固定を返す。隠れた ID は返さない", () => {
    const nodes = [
      root,
      node("A", "root", "議題", done),
      node("A1", "A", "論点"),
      node("B", "root", "議題", done),
      node("C", "root"),
      node("P", "C", "論点", done),
      node("D", "P", "決定"),
      node("L", "C", "論点"),
      node("U", "C"),
      node("T", "C", "TODO"),
    ];
    const v = foldView(snap(nodes, { currentTopic: "C" }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "run:A", "C", "P", "L", "U", "T"]);
    expect(Object.keys(v.openness).sort()).toEqual(ids(v.nodes).sort());
    expect(v.openness).toEqual({
      root: { state: "fixed" },
      "run:A": { state: "bundle", hint: "A 〜 B", hidden: 3 },
      C: { state: "fixed" },
      P: { state: "folded", hint: "決定 1", hidden: 1 },
      L: { state: "open", byHuman: false },
      U: { state: "open", byHuman: false },
      T: { state: "fixed" },
    });
    expect(v.openness["gone"]).toBeUndefined();
  });
});

describe("foldView: 畳む集合", () => {
  it("済みの議題を畳む（子孫は見せない）。話し中の議題は畳まない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root"), node("B1", "B", "論点")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 100 }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "A", "B", "B1"]);
    expect(idsInState(v, "folded")).toEqual(["A"]);
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
    const v = foldView(snap(nodes, { currentTopic: "A", now: 5000 }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "A", "P1", "P2", "D2"]);
    expect(idsInState(v, "folded")).toEqual(["P1"]);
  });

  it("話し中の議題は、now − touchedAt が 900 秒で畳み、899 秒では畳まない", () => {
    const nodes = (): SnapshotNode[] => [root, node("A", "root", "議題", { touchedAt: 100 }), node("A1", "A", "論点"), node("B", "root")];
    const at900 = foldView(snap(nodes(), { currentTopic: "B", now: 1000 }), undefined, null);
    expect(ids(at900.nodes)).toEqual(["root", "A", "B"]);
    expect(idsInState(at900, "folded")).toEqual(["A"]);
    const at899 = foldView(snap(nodes(), { currentTopic: "B", now: 999 }), undefined, null);
    expect(ids(at899.nodes)).toEqual(["root", "A", "A1", "B"]);
    expect(idsInState(at899, "folded")).toEqual([]);
  });

  it("now が無い、または touchedAt が無いときは、時間では畳まない。済みなら畳む", () => {
    const noNow = foldView(snap([root, node("A", "root", "議題", { touchedAt: 0 }), node("B", "root")], { currentTopic: "B" }), undefined, null);
    expect(ids(noNow.nodes)).toEqual(["root", "A", "B"]);
    expect(idsInState(noNow, "folded")).toEqual([]);
    const noTouched = foldView(snap([root, node("A", "root"), node("A1", "A", "論点"), node("B", "root")], { currentTopic: "B", now: 99999 }), undefined, null);
    expect(ids(noTouched.nodes)).toEqual(["root", "A", "A1", "B"]);
    const doneNoTime = foldView(snap([root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")], { currentTopic: "B" }), undefined, null);
    expect(ids(doneNoTime.nodes)).toEqual(["root", "A", "B"]);
  });

  it("今の議題は、済みでも 900 秒以上でも畳まない", () => {
    const doneNow = foldView(snap([root, node("A", "root", "議題", done), node("A1", "A", "論点")], { currentTopic: "A", now: 10 }), undefined, null);
    expect(ids(doneNow.nodes)).toEqual(["root", "A", "A1"]);
    const staleNow = foldView(snap([root, node("A", "root", "議題", { touchedAt: 0 }), node("A1", "A", "論点")], { currentTopic: "A", now: 5000 }), undefined, null);
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
    const v = foldView(snap(nodes, { currentTopic: "A1", now: 10 }), undefined, null);
    expect(ids(v.nodes)).toContain("A");
    expect(v.openness["A"]).toEqual({ state: "fixed" });
    expect(v.openness["A1"]).toEqual({ state: "fixed" });
    expect(ids(v.nodes)).toContain("A1");
    expect(ids(v.nodes)).toContain("A1x");
    expect(idsInState(v, "folded")).toEqual(["A2", "S"]);
  });

  it("今の議題の中の済みの論点は畳む（今の議題自身は畳まない）", () => {
    const nodes = [root, node("A", "root"), node("P", "A", "論点", done), node("D", "P", "決定")];
    const v = foldView(snap(nodes, { currentTopic: "A", now: 10 }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "A", "P"]);
    expect(v.openness["P"]).toMatchObject({ state: "folded" });
  });

  it("開く上書きに入れたノードは畳まない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), foldingActions(snap(nodes, { currentTopic: "B", now: 10 }), [{ type: "point", id: "A" }]).human, null);
    expect(ids(v.nodes)).toEqual(["root", "A", "A1", "B"]);
    expect(idsInState(v, "folded")).toEqual([]);
    expect(v.openness["A"]).toEqual({ state: "open", byHuman: true });
    expect(v.openness["A1"]).toEqual({ state: "open", byHuman: false });
  });
});

describe("foldView: 子孫を見せない", () => {
  it("子が親より前に並んでいても（移動後）、畳んだ親の子孫は見せない", () => {
    const nodes = [root, node("A1", "A", "論点"), node("A", "root", "議題", done), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "A", "B"]);
    expect(v.shownAs["A1"]).toBe("A");
  });

  it("畳んだ議題の子・孫は nodes に入らない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("A1a", "A1", "決定"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), undefined, null);
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
    const v = foldView(snap(base(), { currentTopic: "C", now: 10 }), undefined, null);
    expect(ids(v.nodes)).toHaveLength(3);
    const run = v.nodes[1]!;
    expect(v.nodes[0]!.id).toBe("root");
    expect(v.nodes[2]!.id).toBe("C");
    expect(base().map((n) => n.id)).not.toContain(run.id);
    expect(run.kind).toBe("議題");
    expect(run.parent).toBe("root");
    expect(run.text).toBe("議題 2 件");
    expect(v.openness[run.id]).toEqual({ state: "bundle", hint: "A 〜 B", hidden: 4 });
    expect(v.openness["A"]).toBeUndefined();
    expect(v.openness["B"]).toBeUndefined();
  });

  it("まとめのノードは、最初の議題の位置に入る", () => {
    const nodes = [root, node("X", "root"), node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root", "議題", done), node("Y", "root")];
    const v = foldView(snap(nodes, { currentTopic: "X", now: 10 }), undefined, null);
    expect(v.nodes.map((n) => (n.id === "X" || n.id === "Y" || n.id === "root" ? n.id : "RUN"))).toEqual(["root", "X", "RUN", "Y"]);
  });

  it("まとめた議題とその子孫は見せない", () => {
    const v = foldView(snap(base(), { currentTopic: "C", now: 10 }), undefined, null);
    for (const id of ["A", "B", "A1", "B1"]) expect(ids(v.nodes)).not.toContain(id);
  });

  it("畳んだ議題が 1 つだけなら、まとめない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("C", "root")];
    const v = foldView(snap(nodes, { currentTopic: "C", now: 10 }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "A", "C"]);
    expect(idsInState(v, "bundle")).toEqual([]);
    expect(v.openness["A"]).toMatchObject({ state: "folded" });
  });

  it("間に畳んでいない兄弟があれば、まとめない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("M", "root"), node("B", "root", "議題", done), node("C", "root")];
    const v = foldView(snap(nodes, { currentTopic: "C", now: 10 }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "A", "M", "B", "C"]);
    expect(idsInState(v, "bundle")).toEqual([]);
  });

  it("親が違えば、まとめない", () => {
    const nodes = [root, node("P", "root"), node("Q", "root"), node("A", "P", "議題", done), node("B", "Q", "議題", done)];
    const v = foldView(snap(nodes, { currentTopic: "P", now: 10 }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "P", "Q", "A", "B"]);
    expect(idsInState(v, "bundle")).toEqual([]);
  });

  it("畳んだ論点はまとめない（2 つ続いても別々に畳む）", () => {
    const nodes = [root, node("A", "root"), node("P1", "A", "論点", done), node("P2", "A", "論点", done)];
    const v = foldView(snap(nodes, { currentTopic: "A", now: 10 }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "A", "P1", "P2"]);
    expect(idsInState(v, "bundle")).toEqual([]);
    expect(idsInState(v, "folded")).toEqual(["P1", "P2"]);
  });

  it("時間で畳んだ議題と済みの議題も、続いていればまとめる。3 つなら N は 3", () => {
    const nodes = [root, node("A", "root", "議題", done), node("B", "root", "議題", { touchedAt: 0 }), node("C", "root", "議題", done), node("D", "root")];
    const v = foldView(snap(nodes, { currentTopic: "D", now: 900 }), undefined, null);
    expect(v.nodes[1]!.text).toBe("議題 3 件");
    expect(v.openness[v.nodes[1]!.id]).toEqual({ state: "bundle", hint: "A 〜 C", hidden: 3 });
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
    const v = foldView(snap(deep(), { currentTopic: "Z", now: 10 }), undefined, null);
    expect(v.openness["A"]).toEqual({ state: "folded", hint: "決定 2・TODO 1・未決 1", hidden: 5 });
  });

  it("0 の項目は書かない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("T", "A", "TODO"), node("Z", "root")];
    const v = foldView(snap(nodes, { currentTopic: "Z", now: 10 }), undefined, null);
    expect(v.openness["A"]).toEqual({ state: "folded", hint: "TODO 1", hidden: 1 });
  });

  it("決定済みの論点は未決に数えない", () => {
    const nodes = [root, node("A", "root", "議題", done), node("P", "A", "論点", { pointStatus: "決定済み" }), node("Z", "root")];
    expect(foldView(snap(nodes, { currentTopic: "Z", now: 10 }), undefined, null).openness["A"]).toEqual({ state: "folded", hint: null, hidden: 1 });
  });

  it("3 つとも 0 なら hint は null。子が無ければ hidden は 0", () => {
    const nodes = [root, node("A", "root", "議題", done), node("Z", "root")];
    expect(foldView(snap(nodes, { currentTopic: "Z", now: 10 }), undefined, null).openness["A"]).toEqual({ state: "folded", hint: null, hidden: 0 });
  });

  it("畳んだ論点の手がかりも子孫から作る", () => {
    const nodes = [root, node("A", "root"), node("P", "A", "論点", done), node("D", "P", "決定"), node("T", "P", "TODO")];
    expect(foldView(snap(nodes, { currentTopic: "A", now: 10 }), undefined, null).openness["P"]).toEqual({ state: "folded", hint: "決定 1・TODO 1", hidden: 2 });
  });

  it("まとめのノードの hint は「最初 〜 最後」。hidden はまとめた議題とその子孫の総数", () => {
    const nodes = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("A1", "A", "論点"), node("B1", "B", "決定"), node("B2", "B", "TODO"), node("C", "root")];
    const v = foldView(snap(nodes, { currentTopic: "C", now: 10 }), undefined, null);
    const run = v.nodes[1]!;
    expect(v.openness[run.id]).toEqual({ state: "bundle", hint: "A 〜 B", hidden: 5 });
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
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, changed: [["C1", 5]] }), undefined, null);
    expect([...v.blink]).toEqual(["C1"]);
  });

  it("畳んだ議題の孫が今回変わると、その畳んだ議題が入る（孫は入らない）", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, changed: [["A1a", 5]] }), undefined, null);
    expect([...v.blink]).toEqual(["A"]);
  });

  it("まとめた議題の中が変わると、まとめのノードが入る", () => {
    const ns = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("B1", "B", "論点"), node("C", "root")];
    const v = foldView(snap(ns, { currentTopic: "C", now: 10, changed: [["B1", 5]] }), undefined, null);
    const run = v.nodes[1]!;
    expect([...v.blink]).toEqual([run.id]);
  });

  it("まとめた議題自身が変わっても、まとめのノードが入る", () => {
    const ns = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("C", "root")];
    const v = foldView(snap(ns, { currentTopic: "C", now: 10, changed: [["A", 5]] }), undefined, null);
    expect([...v.blink]).toEqual([v.nodes[1]!.id]);
  });

  it("前の round の変化は入らない", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, round: 5, changed: [["A1a", 4], ["C1", 4]] }), undefined, null);
    expect(v.blink.size).toBe(0);
  });

  it("畳んだ中と見せるノードの両方が変われば、両方入る", () => {
    const v = foldView(snap(nodes(), { currentTopic: "C", now: 10, changed: [["A1a", 5], ["C1", 5]] }), undefined, null);
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
    const v = foldView(snap(ns, { currentTopic: "C", now: 10 }), undefined, null);
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
    const none = foldView(snap(nodes, { currentTopic: "B", now: 10 }), undefined, null);
    expect(ids(none.nodes)).toEqual(["root", "A", "B"]);
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), undefined, "P");
    expect(ids(v.nodes)).toEqual(["root", "A", "P", "B"]);
    expect(idsInState(v, "folded")).toEqual(["P"]);
    expect(v.shownAs["D"]).toBe("P");
  });

  it("古い話し中の議題の下のノードを選ぶと、その議題は畳まれず、選んだノードが見える", () => {
    const nodes = [root, node("A", "root", "議題", { touchedAt: 0 }), node("A1", "A", "論点"), node("A1a", "A1", "決定"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 5000 }), undefined, "A1a");
    expect(ids(v.nodes)).toEqual(["root", "A", "A1", "A1a", "B"]);
    expect(idsInState(v, "folded")).toEqual([]);
  });

  it("選んだ議題自身は、畳む条件に当たれば畳まれる（畳んだノードとして見せるノードに入る）", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), undefined, "A");
    expect(ids(v.nodes)).toEqual(["root", "A", "B"]);
    expect(v.openness["A"]).toEqual({ state: "folded", hint: null, hidden: 1 });
  });

  it("選んだノードの兄弟や子孫は守らない。畳む条件に当たる兄弟は畳まれたまま", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点", done), node("A2", "A", "論点", done), node("B", "root")];
    const v = foldView(snap(nodes, { currentTopic: "B", now: 10 }), undefined, "A1");
    expect(ids(v.nodes)).toEqual(["root", "A", "A1", "A2", "B"]);
    expect(idsInState(v, "folded").sort()).toEqual(["A1", "A2"]);
  });

  it("選んでいない（null）ときと、ノードにない ID のときは、選択なしと同じ結果", () => {
    const nodes = [root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root", "議題", done), node("C", "root")];
    const base = foldView(snap(nodes, { currentTopic: "C", now: 10 }), undefined, null);
    expect(foldView(snap(nodes, { currentTopic: "C", now: 10 }), undefined, "nope")).toEqual(base);
    expect(foldView(snap(nodes, { currentTopic: "C", now: 10 }), undefined, "run:A")).toEqual(base);
  });

  it("入力のスナップショットを書き換えない", () => {
    const s = snap([root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("B", "root")], { currentTopic: "B", now: 10 });
    const before = JSON.stringify(s);
    foldView(s, undefined, "A1");
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
    const v = foldView(snap(five(), { currentTopic: "G", now: 10 }), undefined, null);
    expect(ids(v.nodes)).toEqual(["root", "run:A", "G"]);
    expect(v.nodes[1]!.text).toBe("議題 5 件");
  });

  it("真ん中の C を選ぶと、前の 2 件と後ろの 2 件が別のまとめになり、C は単独の畳んだ議題として残る", () => {
    const v = foldView(snap(five(), { currentTopic: "G", now: 10 }), undefined, "C");
    expect(ids(v.nodes)).toEqual(["root", "run:A", "C", "run:E", "G"]);
    expect(v.nodes[1]!.text).toBe("議題 2 件");
    expect(v.nodes[3]!.text).toBe("議題 2 件");
    expect(idsInState(v, "bundle").sort()).toEqual(["run:A", "run:E"]);
    expect(v.openness["C"]).toEqual({ state: "folded", hint: null, hidden: 0 });
    expect(v.shownAs["A"]).toBe("run:A");
    expect(v.shownAs["F"]).toBe("run:E");
  });

  it("C を選んで生じたまとめ run:E を選ぶと、C の選択が外れても run:E は E から始まるまとめとして残る", () => {
    const afterC = foldView(snap(five(), { currentTopic: "G", now: 10 }), undefined, "C");
    expect(afterC.openness["run:E"]).toMatchObject({ state: "bundle" });
    const v = foldView(snap(five(), { currentTopic: "G", now: 10 }), undefined, "run:E");
    expect(ids(v.nodes)).toEqual(["root", "run:A", "run:E", "G"]);
    expect(v.nodes[1]!.text).toBe("議題 3 件");
    expect(v.nodes[2]!.text).toBe("議題 2 件");
  });

  it("端の A を選ぶと、A は単独で、残りの 4 件が 1 つのまとめになる", () => {
    const v = foldView(snap(five(), { currentTopic: "G", now: 10 }), undefined, "A");
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
    const v = foldView(snap(nodes, { currentTopic: "G", now: 10 }), undefined, "run:A");
    expect(ids(v.nodes)).toEqual(["root", "P", "run:A", "C", "G"]);
    expect(v.openness["P"]).toEqual({ state: "open", byHuman: false });
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
    const v = foldView(snap(nodes, { currentTopic: "G", now: 10 }), undefined, "run:zzz");
    expect(ids(v.nodes)).toEqual(["root", "P", "G"]);
    expect(v.openness["P"]).toMatchObject({ state: "folded" });
  });

  it("3 件の真ん中を選ぶと、前後は 1 件ずつでまとめにならず、3 つとも単独の畳んだ議題になる", () => {
    const nodes = [root, node("A", "root", "議題", done), node("B", "root", "議題", done), node("C", "root", "議題", done), node("G", "root")];
    const v = foldView(snap(nodes, { currentTopic: "G", now: 10 }), undefined, "B");
    expect(ids(v.nodes)).toEqual(["root", "A", "B", "C", "G"]);
    expect(idsInState(v, "bundle")).toEqual([]);
    expect(idsInState(v, "folded").sort()).toEqual(["A", "B", "C"]);
  });
});

describe("refold: 人の操作列から見せる開閉を求める", () => {
  const nodes = () => [root, node("A", "root", "議題", done), node("A1", "A", "論点", done), node("D", "A1", "決定"), node("B", "root"), node("C", "root"), node("C1", "C", "論点"), node("T", "C1", "TODO")];
  const currentB = () => snap(nodes(), { currentTopic: "B", now: 10, changed: [["D", 5]] });

  it("畳んだ議題を開き、再び畳み、また開くと、毎回子孫と byHuman が切り替わる", () => {
    const s = currentB();
    const opened = foldingActions(s, [{ type: "toggle", id: "A" }]);
    expect(ids(opened.view.nodes)).toEqual(["root", "A", "A1", "B", "C", "C1", "T"]);
    expect(opened.view.openness["A"]).toEqual({ state: "open", byHuman: true });
    const closed = foldingActions(s, [{ type: "toggle", id: "A" }], opened.human);
    expect(ids(closed.view.nodes)).toEqual(["root", "A", "B", "C", "C1", "T"]);
    expect(closed.view.openness["A"]).toEqual({ state: "folded", hint: "決定 1", hidden: 2 });
    expect(closed.view.shownAs).toEqual({ A1: "A", D: "A" });
    expect([...closed.view.blink]).toEqual(["A"]);
    const reopened = foldingActions(s, [{ type: "toggle", id: "A" }], closed.human);
    expect(reopened.view.openness["A"]).toEqual({ state: "open", byHuman: true });
    expect(ids(reopened.view.nodes)).toEqual(ids(opened.view.nodes));
  });

  it("話し中の論点を畳むと TODO が隠れ、開き直すと見える", () => {
    const s = currentB();
    const closed = foldingActions(s, [{ type: "toggle", id: "C1" }]);
    expect(closed.view.openness["C1"]).toEqual({ state: "folded", hint: "TODO 1", hidden: 1 });
    expect(ids(closed.view.nodes)).not.toContain("T");
    const opened = foldingActions(s, [{ type: "toggle", id: "C1" }], closed.human);
    expect(ids(opened.view.nodes)).toContain("T");
    expect(opened.view.openness["C1"]).toEqual({ state: "open", byHuman: true });
  });

  it("別の議題の開閉を重ねても、先に開いた議題は開いたまま", () => {
    const { view } = foldingActions(currentB(), [{ type: "toggle", id: "A" }, { type: "toggle", id: "C" }]);
    expect(view.openness).toMatchObject({ A: { state: "open", byHuman: true }, C: { state: "folded", hidden: 2 } });
    expect(ids(view.nodes)).toEqual(["root", "A", "A1", "B", "C"]);
  });

  it("孫を選んで祖先を畳むと select は畳んだ議題になり、選択が隠れない", () => {
    const s = currentB();
    const out = refold(foldView(s, undefined, "T"), { type: "toggle", id: "C" });
    expect(out?.select).toBe("C");
    const view = foldView(s, out!.human, out!.select!);
    expect(ids(view.nodes)).toContain("C");
    expect(ids(view.nodes)).not.toContain("T");
  });

  it("自身・祖先・兄弟の選択と、開く向きの操作では select を返さない", () => {
    const s = currentB();
    for (const selectedId of [null, "C", "root", "B"]) {
      expect(refold(foldView(s, undefined, selectedId), { type: "toggle", id: "C" })?.select).toBeUndefined();
    }
    expect(refold(foldView(s, undefined, "C1"), { type: "toggle", id: "A" })?.select).toBeUndefined();
  });

  it("fixed と見えていない ID の toggle は null で、元の表示を変えない", () => {
    const s = currentB();
    const v = foldView(s, undefined, null);
    for (const id of ["root", "B", "T", "A1", "gone"]) expect(refold(v, { type: "toggle", id })).toBeNull();
    expect(v).toEqual(foldView(s, undefined, null));
    const nested = foldView({ ...s, currentTopic: "C1" }, undefined, null);
    expect(refold(nested, { type: "toggle", id: "C" })).toBeNull();
  });

  it("隠れた決定を point すると祖先が選択で開くが、人が開いた扱いにはならない", () => {
    const s = currentB();
    expect(ids(foldView(s, undefined, null).nodes)).not.toContain("D");
    const out = foldingActions(s, [{ type: "point", id: "D" }]);
    expect(out.selectedId).toBe("D");
    expect(ids(out.view.nodes)).toContain("D");
    expect(out.view.openness).toMatchObject({ A: { state: "open", byHuman: false }, A1: { state: "open", byHuman: false }, D: { state: "fixed" } });
    expect(out.human).toBeUndefined();
    expect(foldView(s, out.human, null).openness["A"]?.state).toBe("folded");
  });

  it("祖先の人の畳みを外し、なお畳まれる論点だけ point で開く", () => {
    const s = currentB();
    const folded = foldingActions(s, [{ type: "toggle", id: "A" }, { type: "toggle", id: "A" }, { type: "toggle", id: "C" }]);
    const out = foldingActions(s, [{ type: "point", id: "A1" }], folded.human);
    expect(ids(out.view.nodes)).toEqual(["root", "A", "A1", "D", "B", "C"]);
    expect(out.view.openness).toMatchObject({ A: { state: "open", byHuman: false }, A1: { state: "open", byHuman: true }, C: { state: "folded" } });
    expect(foldView(s, out.human, null).openness["A"]?.state).toBe("folded");
  });

  it("対象自身の人の畳みは point で外し、既定で開く議題を人が開いた扱いにしない", () => {
    const s = currentB();
    const folded = foldingActions(s, [{ type: "toggle", id: "C" }]);
    const out = foldingActions(s, [{ type: "point", id: "C" }], folded.human);
    expect(out.selectedId).toBe("C");
    expect(ids(out.view.nodes)).toContain("C1");
    expect(out.view.openness["C"]).toEqual({ state: "open", byHuman: false });
    expect(out.human).toBeUndefined();
  });

  it("point は既に人が開いた祖先を保ち、対象の論点だけを追加で開く", () => {
    const s = currentB();
    const opened = foldingActions(s, [{ type: "toggle", id: "A" }]);
    const out = foldingActions(s, [{ type: "point", id: "A1" }], opened.human);
    expect(out.selectedId).toBe("A1");
    expect(out.view.openness).toMatchObject({ A: { state: "open", byHuman: true }, A1: { state: "open", byHuman: true } });
    expect(ids(out.view.nodes)).toContain("D");
  });

  it("スナップショットに無い ID とまとめ ID の point は null", () => {
    const v = foldView(currentB(), undefined, null);
    for (const id of ["gone", "run:A"]) expect(refold(v, { type: "point", id })).toBeNull();
  });

  it("今の議題の人の畳みだけ reflect で解け、祖先の畳みは残る", () => {
    const s = snap([root, node("P", "root"), node("C", "P"), node("D", "C", "決定"), node("B", "root")], { currentTopic: "B" });
    const folded = foldingActions(s, [{ type: "toggle", id: "C" }, { type: "toggle", id: "P" }]);
    const nowC = { ...s, currentTopic: "C" };
    const reflected = foldingActions(nowC, [{ type: "reflect" }], folded.human);
    expect(reflected.view.openness["C"]).toEqual({ state: "fixed" });
    const away = foldView(s, reflected.human, null);
    expect(away.openness["P"]?.state).toBe("folded");
    const pointed = foldingActions(s, [{ type: "point", id: "D" }], reflected.human);
    expect(pointed.view.openness["C"]).toEqual({ state: "open", byHuman: false });
    expect(pointed.human).toBeUndefined();
  });

  it("最後の人の畳みを reflect で解くと human は undefined", () => {
    const s = currentB();
    const folded = foldingActions(s, [{ type: "toggle", id: "C" }]);
    const out = refold(foldView({ ...s, currentTopic: "C" }, folded.human, null), { type: "reflect" });
    expect(out).not.toBeNull();
    expect(out!.human).toBeUndefined();
    expect(out!.select).toBeUndefined();
    expect(foldView(s, out!.human, null).openness["C"]).toEqual({ state: "open", byHuman: false });
  });

  it("別の議題への反映・選択・時間の経過でも人の開閉は残り、human を外すと普段の表示に戻る", () => {
    const s = currentB();
    const changed = foldingActions(s, [{ type: "toggle", id: "A" }, { type: "toggle", id: "C" }]);
    const reflected = foldingActions({ ...s, currentTopic: "B", now: 5000 }, [{ type: "reflect" }], changed.human, "B");
    expect(reflected.view.openness).toMatchObject({ A: { state: "open", byHuman: true }, C: { state: "folded" } });
    const reset = foldView(s, undefined, null);
    expect(reset.openness).toMatchObject({ A: { state: "folded" }, C: { state: "open", byHuman: false } });
  });

  it("消えた ID の人の操作は統合先に付け替えず、再登場した元の ID にだけ効く", () => {
    const s = currentB();
    const folded = foldingActions(s, [{ type: "toggle", id: "C" }]);
    const merged: Snapshot = { ...s, currentTopic: "root", nodes: s.nodes.filter((n) => !["C", "C1", "T"].includes(n.id)), changes: [{ change: "統合", node: "B", kind: "議題", text: "B", from: ["C"], round: 5, at: 10 }] };
    const out = foldingActions(merged, [{ type: "reflect" }], folded.human);
    expect(out.view.openness["B"]).toEqual({ state: "open", byHuman: false });
    expect(foldView(s, out.human, null).openness["C"]?.state).toBe("folded");
  });

  it("refold は snapshot と既存の人の操作を変更しない", () => {
    const s = currentB();
    const opened = foldingActions(s, [{ type: "toggle", id: "A" }]);
    const before = structuredClone(s);
    const view = foldView(s, opened.human, "D");
    for (const action of [{ type: "toggle", id: "A" }, { type: "point", id: "C" }, { type: "reflect" }] as const) refold(view, action);
    expect(s).toEqual(before);
    expect(foldView(s, opened.human, "D")).toEqual(view);
  });
});

describe("refold: 一続きの議題のまとめ", () => {
  const pair = () => snap([root, node("A", "root", "議題", done), node("A1", "A", "論点"), node("D", "root", "議題", done), node("B", "root")], { currentTopic: "B" });

  it("まとめを解くと全員が元の順の畳んだ議題になり、選択は先頭へ移る", () => {
    const s = pair();
    const out = foldingActions(s, [{ type: "toggle", id: "run:A" }], undefined, "run:A");
    expect(out.selectedId).toBe("A");
    expect(ids(out.view.nodes)).toEqual(["root", "A", "D", "B"]);
    expect(out.view.openness).toMatchObject({ A: { state: "folded", hidden: 1 }, D: { state: "folded" } });
    expect(out.view.shownAs).toEqual({ A1: "A" });
    expect(keepTargetOf(out.view, "run:A")).toBe("A");
    const deselected = foldView(s, out.human, null);
    expect(ids(deselected.nodes)).toEqual(["root", "A", "D", "B"]);
    expect(idsInState(deselected, "bundle")).toEqual([]);
    const opened = foldingActions(s, [{ type: "toggle", id: "A" }], out.human);
    expect(ids(opened.view.nodes)).toContain("A1");
    const closed = foldingActions(s, [{ type: "toggle", id: "A" }], opened.human);
    expect(ids(closed.view.nodes)).toEqual(["root", "A", "D", "B"]);
  });

  it("まとめの中の議題を point すると、その議題が選ばれて開く", () => {
    const s = pair();
    expect(ids(foldView(s, undefined, null).nodes)).toContain("run:A");
    const out = foldingActions(s, [{ type: "point", id: "D" }]);
    expect(out.selectedId).toBe("D");
    expect(ids(out.view.nodes)).toEqual(["root", "A", "D", "B"]);
    expect(out.view.openness["D"]).toEqual({ state: "open", byHuman: true });
    expect(out.view.openness["A"]?.state).toBe("folded");
  });

  it("解いた議題は反映後も別々のままで、後から畳まれた議題だけが新しくまとまる", () => {
    const s = pair();
    const unbundled = foldingActions(s, [{ type: "toggle", id: "run:A" }]);
    const later = { ...s, nodes: [...s.nodes, node("E", "root", "議題", done), node("F", "root", "議題", done)] };
    const out = foldingActions(later, [{ type: "reflect" }], unbundled.human);
    expect(ids(out.view.nodes)).toEqual(["root", "A", "D", "B", "run:E"]);
    expect(out.view.openness["run:E"]).toEqual({ state: "bundle", hint: "E 〜 F", hidden: 2 });
    expect(ids(foldView(later, undefined, null).nodes)).toEqual(["root", "run:A", "B", "run:E"]);
  });

  it("選択が入れ子のまとめでも、祖先を畳むと snapshot 上の先頭議題で判定して選択を移す", () => {
    const s = snap([root, node("P", "root"), node("A", "P", "議題", done), node("D", "P", "議題", done), node("B", "root")], { currentTopic: "B" });
    const out = refold(foldView(s, undefined, "run:A"), { type: "toggle", id: "P" });
    expect(out?.select).toBe("P");
  });

  it("位置を保つ基準は、まとめの中の議題ならまとめ、見える ID と still ならそのまま", () => {
    const view = foldView(pair(), undefined, null);
    expect(keepTargetOf(view, "D")).toBe("run:A");
    expect(keepTargetOf(view, "B")).toBe("B");
    expect(keepTargetOf(null, "run:A")).toBe("run:A");
  });
});

describe("foldView: 人の操作と選択・今の議題の優先順位", () => {
  const s = () => snap([root, node("P", "root"), node("Q", "P", "論点"), node("D", "Q", "決定"), node("B", "root")], { currentTopic: "B" });

  it("人が畳んだ祖先は選択による保護より優先し、選んだ子孫を見せない", () => {
    const snapshot = s();
    const folded = foldingActions(snapshot, [{ type: "toggle", id: "P" }]);
    const v = foldView(snapshot, folded.human, "D");
    expect(ids(v.nodes)).toEqual(["root", "P", "B"]);
    expect(v.openness["P"]).toEqual({ state: "folded", hint: "決定 1", hidden: 2 });
    expect(v.shownAs).toEqual({ Q: "P", D: "P" });
  });

  it("人が畳んだノード自身を選んでも、中身は畳んだまま", () => {
    const snapshot = s();
    const folded = foldingActions(snapshot, [{ type: "toggle", id: "P" }]);
    expect(foldView(snapshot, folded.human, "P").openness["P"]?.state).toBe("folded");
  });

  it("今の議題とその祖先は、人が畳んでいても fixed で子孫を見せる", () => {
    const snapshot = s();
    const folded = foldingActions(snapshot, [{ type: "toggle", id: "Q" }, { type: "toggle", id: "P" }]);
    const v = foldView({ ...snapshot, currentTopic: "Q" }, folded.human, null);
    expect(ids(v.nodes)).toEqual(["root", "P", "Q", "D", "B"]);
    expect(v.openness).toMatchObject({ P: { state: "fixed" }, Q: { state: "fixed" }, D: { state: "fixed" } });
  });

  it("反映で人が開いた記録は消さず、今の議題から外れた後も開いたまま", () => {
    const snapshot = { ...s(), nodes: s().nodes.map((n) => n.id === "P" ? { ...n, talkStatus: "済み" as const } : n) };
    const opened = foldingActions(snapshot, [{ type: "toggle", id: "P" }]);
    const reflected = foldingActions({ ...snapshot, currentTopic: "P" }, [{ type: "reflect" }], opened.human);
    expect(foldView(snapshot, reflected.human, null).openness["P"]).toEqual({ state: "open", byHuman: true });
  });

  it("複数のまとめから解いたものだけが別々の議題になり、他のまとめは残る", () => {
    const snapshot = snap([root, node("A", "root", "議題", done), node("D", "root", "議題", done), node("B", "root"), node("E", "root", "議題", done), node("F", "root", "議題", done)], { currentTopic: "B" });
    const out = foldingActions(snapshot, [{ type: "toggle", id: "run:A" }]);
    expect(ids(out.view.nodes)).toEqual(["root", "A", "D", "B", "run:E"]);
    expect(out.view.openness["run:E"]).toEqual({ state: "bundle", hint: "E 〜 F", hidden: 2 });
  });
});

describe("refold: 人が畳んだ議題と解いた議題の並び", () => {
  it("話し中の議題を人が畳むと、隣の済みの議題とまとめになる", () => {
    const s = snap([root, node("A", "root", "議題", done), node("B", "root"), node("C", "root")], { currentTopic: "C" });
    expect(ids(foldView(s, undefined, null).nodes)).toEqual(["root", "A", "B", "C"]);
    const out = foldingActions(s, [{ type: "toggle", id: "B" }]);
    expect(ids(out.view.nodes)).toEqual(["root", "run:A", "C"]);
    expect(out.view.openness["run:A"]).toEqual({ state: "bundle", hint: "A 〜 B", hidden: 2 });
  });

  it("以前解いた議題だけが次の反映でも別々に残り、前後の新しい議題はまとめられる", () => {
    const before = snap([root, node("A", "root", "議題", done), node("X", "root", "議題", done), node("B", "root")], { currentTopic: "B" });
    const unbundled = foldingActions(before, [{ type: "toggle", id: "run:A" }]);
    const after = snap([root, node("D", "root", "議題", done), node("A", "root", "議題", done), node("E", "root", "議題", done), node("F", "root", "議題", done), node("B", "root")], { currentTopic: "B" });
    const out = foldingActions(after, [{ type: "reflect" }], unbundled.human);
    expect(ids(out.view.nodes)).toEqual(["root", "D", "A", "run:E", "B"]);
    expect(out.view.openness["run:E"]).toEqual({ state: "bundle", hint: "E 〜 F", hidden: 2 });
  });

  it("まとめを解いた人の値を次の操作へ渡しても、元の値から作る表示は変わらない", () => {
    const s = snap([root, node("A", "root", "議題", done), node("D", "root", "議題", done), node("B", "root"), node("E", "root", "議題", done), node("F", "root", "議題", done)], { currentTopic: "B" });
    const first = foldingActions(s, [{ type: "toggle", id: "run:A" }]);
    const next = foldingActions(s, [{ type: "toggle", id: "run:E" }, { type: "toggle", id: "A" }], first.human);
    expect(ids(next.view.nodes)).toEqual(["root", "A", "D", "B", "E", "F"]);
    expect(ids(foldView(s, first.human, null).nodes)).toEqual(["root", "A", "D", "B", "run:E"]);
  });
});
