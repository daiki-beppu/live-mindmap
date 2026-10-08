import { describe, expect, it } from "vitest";
import type { Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
import { foldView } from "../src/folding.ts";
import { relocations } from "../src/relocation.ts";
import type { VisibleTree } from "../src/viewing.ts";

const node = (id: string, parent: string | null, kind: SnapshotNode["kind"], evidence: string[], extra: Partial<SnapshotNode> = {}): SnapshotNode => ({
  id,
  parent,
  kind,
  text: id,
  evidence,
  ...extra,
});
const root = node("root", null, "会議", []);
const snap = (nodes: SnapshotNode[], round: number, currentTopic?: string): Snapshot => ({
  nodes,
  round,
  changes: [],
  remarks: [],
  ...(currentTopic !== undefined ? { currentTopic } : {}),
});
const NONE: ReadonlySet<string> = new Set();

// 本番と同じく、畳む見せ方の結果から見えている木を組み立てる（位置は使わない）
const stateOf = (snapshot: Snapshot, selectedId: string | null = null) => {
  const shown = foldView(snapshot, NONE, selectedId).nodes;
  const tree: VisibleTree = {
    ids: shown.map((n) => n.id),
    targets: Object.fromEntries(shown.map((n, i) => [n.id, { x: 0, y: i * 50 }])),
    parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])),
    currentTopic: snapshot.currentTopic,
  };
  return { tree, snapshot };
};

describe("relocations: 見えている木から消えたノードの移り先", () => {
  const before = () =>
    snap(
      [
        root,
        node("A", "root", "議題", ["r1"]),
        node("P1", "A", "論点", ["r1"]),
        node("P2", "A", "論点", ["r2"]),
        node("X", "P2", "案", ["r2"]),
      ],
      4,
      "A",
    );

  it("何も消えていなければ空", () => {
    expect(relocations(stateOf(before()), stateOf(snap(before().nodes, 5, "A")))).toEqual({});
  });

  it("統合: 消えたノードの根拠をすべて持ち、新しく得た同じ種別のノードへ移る。子を引き取っただけでも統合", () => {
    const after = snap(
      [root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1", "r2"]), node("X", "P1", "案", ["r2"])],
      5,
      "A",
    );
    expect(relocations(stateOf(before()), stateOf(after))).toEqual({ P2: "P1" });
  });

  it("統合: 根拠を得ていなくても子を引き取っていれば統合先になる", () => {
    const b = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1", "r2"]), node("P2", "A", "論点", ["r2"]), node("X", "P2", "案", ["r2"])], 4, "A");
    const after = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1", "r2"]), node("X", "P1", "案", ["r2"])], 5, "A");
    expect(relocations(stateOf(b), stateOf(after))).toEqual({ P2: "P1" });
  });

  it("統合: 種別が違う・根拠が足りないノードは統合先にならない（削除として親へ）", () => {
    const wrongKind = snap([root, node("A", "root", "議題", ["r1", "r2"]), node("P1", "A", "論点", ["r1"])], 5, "A");
    expect(relocations(stateOf(before()), stateOf(wrongKind))).toMatchObject({ P2: "A" });
    const shortEvidence = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1"])], 5, "A");
    expect(relocations(stateOf(before()), stateOf(shortEvidence))).toMatchObject({ P2: "A" });
  });

  it("統合: 統合先が複数あれば、反映後のマップの並びで最初のもの", () => {
    const b = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1"]), node("P3", "A", "論点", ["r1"]), node("P2", "A", "論点", ["r2"])], 4, "A");
    const after = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1", "r2"]), node("P3", "A", "論点", ["r1", "r2"])], 5, "A");
    expect(relocations(stateOf(b), stateOf(after))).toEqual({ P2: "P1" });
    const reordered = snap([root, node("A", "root", "議題", ["r1"]), node("P3", "A", "論点", ["r1", "r2"]), node("P1", "A", "論点", ["r1", "r2"])], 5, "A");
    expect(relocations(stateOf(b), stateOf(reordered))).toEqual({ P2: "P3" });
  });

  it("削除: 消えたノードは親へ。子もまとめて消えたら、残っているいちばん近い祖先へ", () => {
    const after = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1"])], 5, "A");
    expect(relocations(stateOf(before()), stateOf(after))).toEqual({ P2: "A", X: "A" });
  });

  it("削除: 祖先が何段も消えたら、残っている最初の祖先（ルートまで）", () => {
    const b = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1"]), node("D", "P1", "決定", ["r1"])], 4, "A");
    const after = snap([root], 5);
    expect(relocations(stateOf(b), stateOf(after))).toEqual({ A: "root", P1: "root", D: "root" });
  });

  it("畳まれて見えなくなっただけのノード（スナップショットには残る）は移さない", () => {
    const b = snap([root, node("A", "root", "議題", ["r1"]), node("A1", "A", "論点", ["r1"]), node("B", "root", "議題", ["r1"])], 4, "B");
    const after = snap([root, node("A", "root", "議題", ["r1"], { talkStatus: "済み" }), node("A1", "A", "論点", ["r1"]), node("B", "root", "議題", ["r1"])], 5, "B");
    const a = stateOf(after);
    expect(a.tree.ids).not.toContain("A1");
    expect(relocations(stateOf(b), a)).toEqual({});
  });

  it("移り先が畳んだ中にあっても、スナップショットにあれば移り先になる", () => {
    const b = snap([root, node("A", "root", "議題", ["r1"]), node("A1", "A", "論点", ["r1"]), node("A2", "A", "論点", ["r2"])], 4, "root");
    const after = snap([root, node("A", "root", "議題", ["r1"], { talkStatus: "済み" }), node("A1", "A", "論点", ["r1", "r2"])], 5, "root");
    const a = stateOf(after);
    expect(a.tree.ids).not.toContain("A1");
    expect(relocations(stateOf(b), a)).toEqual({ A2: "A1" });
  });

  it("「議題 N 件」のまとめが無くなったら、親へ移る", () => {
    const done = { talkStatus: "済み" } as const;
    const b = snap([root, node("A", "root", "議題", ["r1"], done), node("B", "root", "議題", ["r1"], done), node("C", "root", "議題", ["r1"])], 4, "C");
    const sb = stateOf(b);
    expect(sb.tree.ids).toContain("run:A");
    const after = snap([root, node("A", "root", "議題", ["r1"], done), node("B", "root", "議題", ["r1"]), node("C", "root", "議題", ["r1"])], 5, "C");
    expect(relocations(sb, stateOf(after))).toEqual({ "run:A": "root" });
  });

  it("見返しで時刻を戻して、まだ無い時点になったノードは、統合に見える並びでも、その時点にあるいちばん近い祖先へ移る", () => {
    // 前（round 5）の P3 は、戻った先（round 3）の P1 が根拠 r3 を持っていても、統合ではなく「まだ無い」だけ
    const later = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1"]), node("P3", "A", "論点", ["r3"]), node("Y", "P3", "案", ["r3"])], 5, "A");
    const earlier = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1", "r3"])], 3, "A");
    expect(relocations(stateOf(later), stateOf(earlier))).toEqual({ P3: "A", Y: "A" });
  });

  it("入力のスナップショットと木を書き換えない", () => {
    const b = stateOf(before());
    const a = stateOf(snap([root, node("A", "root", "議題", ["r1"])], 5, "A"));
    const frozen = JSON.stringify([b, a]);
    relocations(b, a);
    expect(JSON.stringify([b, a])).toBe(frozen);
  });
});
