import { describe, expect, it } from "vitest";
import type { SnapshotNode } from "../../server/src/core/index.ts";
import { layout } from "../src/layout.ts";

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"] = "議題"): SnapshotNode => ({
  id,
  parent,
  kind,
  text: id,
  evidence: parent ? ["r1"] : [],
});

// 作られた順（snapshot().nodes の並び）
const tree = (): SnapshotNode[] => [
  node("root", null, "会議"),
  node("A", "root"),
  node("B", "root"),
  node("A1", "A", "論点"),
  node("B1", "B", "論点"),
  node("A2", "A", "論点"), // B・B1 より後に作られた A の子
];

const H = 40;
const heights = (ids: string[], h = H) => Object.fromEntries(ids.map((id) => [id, h]));
const ids = (nodes: SnapshotNode[]) => nodes.map((n) => n.id);

describe("layout: 左 → 右の木", () => {
  it("深さが増えるほど右に置く。同じ深さは同じ x", () => {
    const pos = layout(tree(), heights(ids(tree())));
    expect(pos.root!.x).toBeLessThan(pos.A!.x);
    expect(pos.A!.x).toBe(pos.B!.x);
    expect(pos.A!.x).toBeLessThan(pos.A1!.x);
    expect(pos.A1!.x).toBe(pos.B1!.x);
    expect(pos.A1!.x).toBe(pos.A2!.x);
  });

  it("x は高さの実寸に左右されない（ノードの幅は固定）", () => {
    const a = layout(tree(), heights(ids(tree()), 40));
    const b = layout(tree(), { ...heights(ids(tree()), 40), A1: 300 });
    for (const id of ids(tree())) expect(b[id]!.x).toBe(a[id]!.x);
  });

  it("兄弟は作られた順に上から積む（後から作られた子は、先に作られた別の親の子より後ではなく、同じ親の兄弟の下に来る）", () => {
    const pos = layout(tree(), heights(ids(tree())));
    expect(pos.A!.y).toBeLessThan(pos.B!.y);
    expect(pos.A1!.y).toBeLessThan(pos.A2!.y); // A の子は作られた順
    expect(pos.A2!.y).toBeLessThan(pos.B1!.y); // A の部分木の下に B の部分木が続く
  });

  it("兄弟は重ならない（測った高さを使う）", () => {
    const h = { ...heights(ids(tree())), A1: 120 };
    const pos = layout(tree(), h);
    expect(pos.A2!.y).toBeGreaterThanOrEqual(pos.A1!.y + 120);
  });

  it("親は子の範囲の上下中央に置く", () => {
    const h = { ...heights(ids(tree())), A1: 100, A2: 60, A: 30 };
    const pos = layout(tree(), h);
    const top = pos.A1!.y;
    const bottom = pos.A2!.y + 60;
    expect(pos.A!.y + 30 / 2).toBeCloseTo((top + bottom) / 2);
  });

  it("子が 1 つの親は、その子と中心の高さが揃う", () => {
    const h = { ...heights(ids(tree())), B: 30, B1: 90 };
    const pos = layout(tree(), h);
    expect(pos.B!.y + 15).toBeCloseTo(pos.B1!.y + 45);
  });

  it("測る前（heights にない）のノードも位置が決まる", () => {
    const pos = layout(tree(), {});
    for (const id of ids(tree())) {
      expect(Number.isFinite(pos[id]!.x)).toBe(true);
      expect(Number.isFinite(pos[id]!.y)).toBe(true);
    }
    expect(pos.A!.y).toBeLessThan(pos.B!.y);
  });
});

describe("layout: 追加で動くのは追加位置より下のノードだけ", () => {
  const base = (): SnapshotNode[] => [
    node("root", null, "会議"),
    node("A", "root"),
    node("A1", "A", "論点"),
    node("B", "root"),
    node("B1", "B", "論点"),
  ];

  it("A の子を足すと、上にある A1 は動かず、下の B・B1 だけが下がる（祖先 root・A は中央に置き直される）", () => {
    const before = layout(base(), heights(ids(base())));
    const added = [...base(), node("A2", "A", "論点")];
    const after = layout(added, heights(ids(added)));
    expect(after.A1).toEqual(before.A1);
    expect(after.B!.y).toBeGreaterThan(before.B!.y);
    expect(after.B1!.y).toBeGreaterThan(before.B1!.y);
    for (const id of ["root", "A", "A1", "B", "B1"]) expect(after[id]!.x).toBe(before[id]!.x);
  });

  it("B の子を足すと、上にある A・A1 は動かない", () => {
    const before = layout(base(), heights(ids(base())));
    const added = [...base(), node("B2", "B", "論点")];
    const after = layout(added, heights(ids(added)));
    expect(after.A).toEqual(before.A);
    expect(after.A1).toEqual(before.A1);
    expect(after.B1).toEqual(before.B1); // 追加位置より上の兄弟
  });

  it("末尾の葉（B1）の下に子を足しても、A の部分木は動かない", () => {
    const before = layout(base(), heights(ids(base())));
    const added = [...base(), node("B1a", "B1", "案")];
    const after = layout(added, heights(ids(added)));
    expect(after.A).toEqual(before.A);
    expect(after.A1).toEqual(before.A1);
  });

  it("根が最初の子より高くても、末尾に子を足して既存の子が動かない。根は子の範囲の中央にある", () => {
    const start = [node("root", null, "会議"), node("A", "root")];
    const h = { root: 200, A: 40, B: 40 };
    const before = layout(start, h);
    const added = [...start, node("B", "root")];
    const after = layout(added, h);
    expect(after.A).toEqual(before.A);
    expect(after.root!.y + 200 / 2).toBeCloseTo((after.A!.y + (after.B!.y + 40)) / 2);
  });

  it("根以外の親が最初の子より高くても、末尾に子を足して既存のノードが動かない。親は子の範囲の中央にある", () => {
    const start = [
      node("root", null, "会議"),
      node("A", "root"),
      node("A1", "A", "論点"),
      node("B", "root"),
      node("B1", "B", "論点"),
    ];
    const h = { root: 40, A: 40, A1: 40, B: 200, B1: 40, B2: 40 };
    const before = layout(start, h);
    const added = [...start, node("B2", "B", "論点")];
    const after = layout(added, h);
    for (const id of ["A", "A1", "B1"]) expect(after[id]).toEqual(before[id]);
    expect(after.B!.y + 200 / 2).toBeCloseTo((after.B1!.y + (after.B2!.y + 40)) / 2);
  });
});
