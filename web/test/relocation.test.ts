import { describe, expect, it } from "vitest";
import type { ChangeEntry, Snapshot, SnapshotNode } from "../../server/src/core/index.ts";
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
const snap = (nodes: SnapshotNode[], round: number, currentTopic?: string, changes: ChangeEntry[] = []): Snapshot => ({
  nodes,
  round,
  changes,
  remarks: [],
  ...(currentTopic !== undefined ? { currentTopic } : {}),
});
const combined = (round: number, into: SnapshotNode, from: string[]): ChangeEntry => ({ change: "統合", node: into.id, kind: into.kind, text: into.text, from, round, at: round });
const NONE: ReadonlySet<string> = new Set();

// 本番と同じく、畳む見せ方の結果から見えている木を組み立てる（位置は使わない）
const stateOf = (snapshot: Snapshot, selectedId: string | null = null) => {
  const shown = foldView(snapshot, NONE, selectedId, NONE, NONE).nodes;
  const tree: VisibleTree = {
    ids: shown.map((n) => n.id),
    targets: Object.fromEntries(shown.map((n, i) => [n.id, { x: 0, y: i * 50 }])),
    parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])),
    fold: null,
    changed: [],
    currentTopic: snapshot.currentTopic,
  };
  return { tree, snapshot, selectedId };
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

  it("統合: 反映の統合の記録にある統合先へ移る。子は統合先の下に残る", () => {
    const P1 = node("P1", "A", "論点", ["r1", "r2"]);
    const after = snap([root, node("A", "root", "議題", ["r1"]), P1, node("X", "P1", "案", ["r2"])], 5, "A", [combined(5, P1, ["P2"])]);
    expect(relocations(stateOf(before()), stateOf(after))).toEqual({ P2: "P1" });
  });

  it("統合: 統合の記録が無ければ、消えたノードの根拠を持つノードがあっても祖先へ移る", () => {
    const after = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1", "r2"])], 5, "A");
    expect(relocations(stateOf(before()), stateOf(after))).toEqual({ P2: "A", X: "A" });
  });

  it("統合: 何 round か飛んだら、間の統合の記録を round 順にたどる（A → B が round 3、B → C が round 5 なら A は C へ）", () => {
    const b = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1"]), node("P2", "A", "論点", ["r2"]), node("P3", "A", "論点", ["r3"])], 2, "A");
    const P1 = node("P1", "A", "論点", ["r1", "r2", "r3"]);
    const P3 = node("P3", "A", "論点", ["r2", "r3"]);
    const after = snap([root, node("A", "root", "議題", ["r1"]), P1], 5, "A", [combined(3, P3, ["P2"]), combined(5, P1, ["P3"])]);
    expect(relocations(stateOf(b), stateOf(after))).toEqual({ P2: "P1", P3: "P1" });
  });

  it("統合: 前の時点までの統合の記録は使わない", () => {
    const P1 = node("P1", "A", "論点", ["r1", "r2"]);
    const after = snap([root, node("A", "root", "議題", ["r1"]), P1], 5, "A", [combined(4, P1, ["P2"])]);
    expect(relocations(stateOf(before()), stateOf(after))).toEqual({ P2: "A", X: "A" });
  });

  it("統合: 統合先が反映の後に無ければ、いちばん近い現存の祖先へ移る", () => {
    const P1 = node("P1", "A", "論点", ["r1", "r2"]);
    const after = snap([root, node("A", "root", "議題", ["r1"])], 6, "A", [combined(5, P1, ["P2"])]);
    expect(relocations(stateOf(before()), stateOf(after))).toEqual({ P1: "A", P2: "A", X: "A" });
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
    const A1 = node("A1", "A", "論点", ["r1", "r2"]);
    const after = snap([root, node("A", "root", "議題", ["r1"], { talkStatus: "済み" }), A1], 5, "root", [combined(5, A1, ["A2"])]);
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

  it("見返しで時刻を戻して、まだ無い時点になったノードは、統合の記録があっても、その時点にあるいちばん近い祖先へ移る", () => {
    // 前（round 5）の P3 は、戻った先（round 3）に P1 への統合の記録があっても、統合ではなく「まだ無い」だけ
    const later = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1"]), node("P3", "A", "論点", ["r3"]), node("Y", "P3", "案", ["r3"])], 5, "A");
    const P1 = node("P1", "A", "論点", ["r1", "r3"]);
    const earlier = snap([root, node("A", "root", "議題", ["r1"]), P1], 3, "A", [combined(3, P1, ["P3"])]);
    expect(relocations(stateOf(later), stateOf(earlier))).toEqual({ P3: "A", Y: "A" });
  });

  it("前の木から人の畳みで隠れていた選択ノードも、消えたら移る。選択が無ければ移らない", () => {
    const folded: ReadonlySet<string> = new Set(["A"]);
    const b = snap([...before().nodes, node("B", "root", "議題", ["r3"])], 4, "B");
    const shown = foldView(b, NONE, "P2", folded, NONE).nodes;
    const hiddenTree: VisibleTree = {
      ids: shown.map((n) => n.id),
      targets: Object.fromEntries(shown.map((n, i) => [n.id, { x: 0, y: i * 50 }])),
      parents: Object.fromEntries(shown.map((n) => [n.id, n.parent])),
      fold: null,
      changed: [],
      currentTopic: b.currentTopic,
    };
    expect(hiddenTree.ids).not.toContain("P2");
    const after = snap([root, node("A", "root", "議題", ["r1"]), node("P1", "A", "論点", ["r1"]), node("B", "root", "議題", ["r3"])], 5, "B");
    expect(relocations({ tree: hiddenTree, snapshot: b, selectedId: "P2" }, stateOf(after))).toEqual({ P2: "A" });
    expect(relocations({ tree: hiddenTree, snapshot: b, selectedId: null }, stateOf(after))).toEqual({});
  });

  it("入力のスナップショットと木を書き換えない", () => {
    const b = stateOf(before());
    const a = stateOf(snap([root, node("A", "root", "議題", ["r1"])], 5, "A"));
    const frozen = JSON.stringify([b, a]);
    relocations(b, a);
    expect(JSON.stringify([b, a])).toBe(frozen);
  });
});
