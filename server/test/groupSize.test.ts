import { describe, expect, it } from "vitest";
import { childrenByParent, groupSize, ROOT_ID, type MapNode } from "../src/core/index.ts";

type Node = Pick<MapNode, "id" | "parent" | "kind" | "talkStatus">;
const node = (id: string, parent: string | null, kind: Node["kind"]): Node => ({ id, parent, kind });
const root = (): Node => node(ROOT_ID, null, "会議");

describe("まとまりの大きさと一番近い祖先の議題", () => {
  it("議題は論点を 1 と数え、論点の配下と子の議題自身・配下を除く", () => {
    const nodes = [root(), node("t", ROOT_ID, "議題"),
      node("p", "t", "論点"), node("a", "p", "案"),
      node("k", "t", "要点"), node("kk", "k", "要点"),
      node("child", "k", "議題"), node("hidden", "child", "要点")];

    expect(groupSize(nodes, "t")).toEqual({ size: 3, topicId: ROOT_ID });
    expect(groupSize(nodes, "child")).toEqual({ size: 1, topicId: "t" });
  });

  it("論点は配下を数え、派生の論点自身は 1、派生の論点の配下と子の議題は除く", () => {
    const nodes = [root(), node("t", ROOT_ID, "議題"), node("p", "t", "論点"),
      node("a", "p", "案"), node("k", "a", "要点"),
      node("derived", "p", "論点"), node("hidden", "derived", "案"),
      node("child", "a", "議題"), node("underTopic", "child", "要点")];

    expect(groupSize(nodes, "p")).toEqual({ size: 3, topicId: "t" });
    expect(groupSize(nodes, "derived")).toEqual({ size: 1, topicId: "t" });
  });

  it("済みの論点は自分の配下を数えない。話し中の論点の別の枝は数える", () => {
    const nodes = [root(), node("t", ROOT_ID, "議題"), node("p", "t", "論点"),
      node("open", "p", "案"),
      { ...node("closed", "p", "論点"), talkStatus: "済み" as const },
      node("hidden", "closed", "要点")];

    expect(groupSize(nodes, "p")).toEqual({ size: 2, topicId: "t" });
    expect(groupSize(nodes, "closed")).toEqual({ size: 0, topicId: "t" });
  });

  it("決定済みでも話し中の論点なら決定と案の配下を数える", () => {
    const nodes = [root(), node("p", ROOT_ID, "論点"),
      node("d", "p", "決定"), node("a", "p", "案"), node("k", "a", "要点")];

    expect(groupSize(nodes, "p")).toEqual({ size: 3, topicId: ROOT_ID });
  });

  it.each([
    { name: "非派生で話し中の論点", id: "q", change: {}, size: 3, topicId: "t" },
    { name: "済みの論点", id: "q", change: { talkStatus: "済み" }, size: 2, topicId: "t" },
    { name: "派生の論点", id: "q", change: { parent: "p" }, size: 2, topicId: "t" },
    { name: "子の議題", id: "q", change: { kind: "議題" }, size: 1, topicId: "t" },
    { name: "議題起点", id: "p", change: { kind: "議題" }, size: 2, topicId: "t" },
    { name: "案起点", id: "p", change: { kind: "案" }, size: 2, topicId: "t" },
    { name: "課題起点", id: "p", change: { kind: "課題" }, size: 2, topicId: "t" },
    { name: "要点起点", id: "p", change: { kind: "要点" }, size: 2, topicId: "t" },
    { name: "済みの起点", id: "p", change: { talkStatus: "済み" }, size: 0, topicId: "t" },
    { name: "祖先の議題なし", id: "t", change: { kind: "要点" }, size: 3, topicId: ROOT_ID },
  ] satisfies { name: string; id: string; change: Partial<Node>; size: number; topicId: string }[])(
    "案を挟む論点の探索: $name", ({ id, change, size, topicId }) => {
      const nodes = [root(), node("t", ROOT_ID, "議題"), node("p", "t", "論点"),
        node("a", "p", "案"), node("q", "a", "論点"), node("k", "q", "要点")]
        .map((n) => n.id === id ? { ...n, ...change } : n);

      expect(groupSize(nodes, "p")).toEqual({ size, topicId });
    },
  );

  it.each(["案", "課題", "要点"] as const)("%s は配下を数え、論点を 1 と数え、議題自身・配下を除く", (kind) => {
    const nodes = [root(), node("t", ROOT_ID, "議題"), node("g", "t", kind),
      node("k", "g", "要点"), node("kk", "k", "要点"),
      node("p", "k", "論点"), node("hidden", "p", "案"),
      node("child", "g", "議題"), node("underTopic", "child", "要点")];

    expect(groupSize(nodes, "g")).toEqual({ size: 3, topicId: "t" });
  });

  it("祖先の議題は途中の案・論点を越えて最も近いものを返す。議題自身を祖先にしない", () => {
    const nodes = [root(), node("outer", ROOT_ID, "議題"), node("a", "outer", "案"),
      node("inner", "a", "議題"), node("p", "inner", "論点"), node("g", "p", "課題")];

    expect(groupSize(nodes, "inner")).toEqual({ size: 1, topicId: "outer" });
    expect(groupSize(nodes, "g")).toEqual({ size: 0, topicId: "inner" });
  });

  it("祖先に議題が無ければ、途中の親があってもルートを返す", () => {
    const nodes = [root(), node("p", ROOT_ID, "論点"), node("a", "p", "案")];

    expect(groupSize(nodes, "a")).toEqual({ size: 0, topicId: ROOT_ID });
  });
});

describe("親ごとの子の一覧", () => {
  it("子を入力の順のまま親ごとにまとめ、親を持たないノードと子のないノードは載せない", () => {
    const nodes = [root(), node("t", ROOT_ID, "議題"), node("a", "t", "案"), node("b", ROOT_ID, "案"), node("c", "t", "要点")];

    const kids = childrenByParent(nodes);

    expect([...kids.keys()].sort()).toEqual([ROOT_ID, "t"].sort());
    expect(kids.get("t")?.map((n) => n.id)).toEqual(["a", "c"]);
    expect(kids.get(ROOT_ID)?.map((n) => n.id)).toEqual(["t", "b"]);
    expect(kids.has("a")).toBe(false);
  });
});
