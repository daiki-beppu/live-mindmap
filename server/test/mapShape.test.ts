import { describe, expect, it } from "vitest";
import { reviewSnapshot, type Kind, type LogEvent, type Op } from "../src/core/index.ts";

const add = (ref: string, parent: string, kind: Kind): Extract<Op, { op: "add" }> => ({ op: "add", ref, parent, kind, text: "合成ノード", evidence: ["r1"] });
const diff = (ops: Op[], fresh: string[]): LogEvent => ({ type: "diff", input: { recent: [], fresh, nodeCount: 0 }, ops, dropped: [] });
const eventsOf = (ops: Op[]): LogEvent[] => [
  { type: "start", title: "合成会議" },
  { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 60, text: "合成発言" } },
  diff(ops, ["r1"]),
  { type: "remark", remark: { id: "uncited", track: "自分", start: 1700, end: 1800, text: "未引用の合成発言" } },
  { type: "remark", remark: { id: "last", track: "相手", start: 100, end: 120, text: "後から届いた合成発言" } },
];
const shapeEvents = (): LogEvent[] => eventsOf([
  add("t1", "root", "議題"), add("t2", "t1", "議題"),
  add("p1", "t2", "論点"), add("p2", "p1", "論点"),
  add("a", "p2", "案"), add("k1", "a", "要点"), add("k2", "k1", "要点"),
  add("k3", "t2", "要点"),
  add("a2", "root", "案"), add("k4", "a2", "要点"), add("k5", "k4", "要点"), add("k6", "k5", "要点"),
]);

describe("イベント列からマップの形を数える", () => {
  it.each([4, 5])("通常の子%s件に補足を足しても形の全指標は変わらず、本文に補足とある通常ノードは数える", async (count) => {
    const { mapShape } = await import("../bench/mapShape.ts");
    const events = eventsOf([
      add("t", "root", "議題"),
      ...Array.from({ length: count }, (_, i): Op => ({ ...add(`a${i}`, "t", "案"), text: "補足の方法" })),
    ]);
    const mixed: LogEvent[] = [...events, {
      type: "supplement", category: "背景", ms: 1, reflectedAt: 120,
      op: { op: "add", parent: count === 4 ? "n1" : "n6", text: "説明", evidence: ["r1"], origin: "会議の外" },
    }];
    expect(mapShape(mixed)).toEqual(mapShape(events));
    expect(mapShape(mixed)).toMatchObject({ nodes: count + 2, maxTopic: count, maxGroup: count, maxDepth: 2 });
  });

  it("fixture は既存復元で 13 ノードとなり、最大時刻の未引用発言は snapshot に含まれない", () => {
    const snapshot = reviewSnapshot(shapeEvents());
    expect(snapshot.nodes).toHaveLength(13);
    expect(snapshot.remarks.map((r) => r.id)).toEqual(["r1"]);
    expect(snapshot.now).toBe(120);
  });

  it("全列を数える。時間は全発言の最大 end、鎖は辺、深さはルートを 0 とする", async () => {
    const { mapShape } = await import("../bench/mapShape.ts");
    const events = shapeEvents();
    const before = JSON.stringify(events);

    expect(mapShape(events)).toEqual({
      minutes: 30, nodes: 13, topics: 2, nested: 1, topicsPerHour: 4,
      maxTopic: 2, maxGroup: 3, derived: 1,
      oneChild: 8, oneChildRatio: 8 / 13,
      longestChain: 4, longestSameKindChain: 2, maxDepth: 7,
      childDistribution: [3, 8, 2, 0, 0, 0, 0],
    });
    expect(JSON.stringify(events)).toBe(before);
  });

  it.each(["案", "課題", "要点"] as const)("議題・論点が無くても %s のまとまりを最大に含める", async (kind) => {
    const { mapShape } = await import("../bench/mapShape.ts");
    const events = eventsOf([add("g", "root", kind), add("k", "g", "要点"), add("kk", "k", "要点")]);

    expect(mapShape(events)).toMatchObject({ topics: 0, maxTopic: 0, maxGroup: 2 });
  });

  it("途中の木ではなく、移動・削除を反映した最終マップを数える", async () => {
    const events = eventsOf([add("t", "root", "議題"), add("k", "t", "要点"), add("kk", "k", "要点")]);
    events.push(diff([{ op: "move", node: "n2", parent: "root" }, { op: "delete", node: "n3" }], []));
    expect(reviewSnapshot(events).nodes.map((n) => [n.id, n.parent])).toEqual([["root", null], ["n1", "root"], ["n2", "root"]]);
    const { mapShape } = await import("../bench/mapShape.ts");

    expect(mapShape(events)).toMatchObject({ nodes: 3, maxTopic: 0, maxGroup: 0, maxDepth: 1, childDistribution: [2, 0, 1, 0, 0, 0, 0] });
  });

  it("済みの論点の配下を最大のまとまりに含めない", async () => {
    const events = eventsOf([add("t", "root", "議題"), add("p", "t", "論点"), add("a", "p", "案"), add("b", "p", "案")]);
    events.push(diff([], []), diff([{ op: "close", node: "n2" }], []));

    expect(reviewSnapshot(events).nodes.find((n) => n.id === "n2")?.talkStatus).toBe("済み");
    const { mapShape } = await import("../bench/mapShape.ts");
    expect(mapShape(events)).toMatchObject({ maxTopic: 1, maxGroup: 1 });
  });

  it("子の数が 6 以上のノードを分布の最後の列にまとめる", async () => {
    const { mapShape } = await import("../bench/mapShape.ts");
    const events = eventsOf(Array.from({ length: 7 }, (_, i) => add(`k${i}`, "root", "要点")));

    expect(mapShape(events)).toMatchObject({ nodes: 8, oneChild: 0, oneChildRatio: 0, childDistribution: [7, 0, 0, 0, 0, 0, 1] });
  });

  it("発言と子が無い会議も、ルート 1 ノードの形として数える", async () => {
    const { mapShape } = await import("../bench/mapShape.ts");

    expect(mapShape([{ type: "start", title: "空の合成会議" }])).toMatchObject({
      minutes: 0, nodes: 1, topics: 0, nested: 0, maxTopic: 0, maxGroup: 0, derived: 0,
      oneChild: 0, oneChildRatio: 0, longestChain: 0, longestSameKindChain: 0, maxDepth: 0,
      childDistribution: [1, 0, 0, 0, 0, 0, 0],
    });
  });
});
