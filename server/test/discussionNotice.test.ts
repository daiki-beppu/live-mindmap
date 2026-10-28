import { describe, expect, it } from "vitest";
import { createDiscussionNoticeState, emptyMap, nextDiscussionNotice, observeDiscussion, recordDiscussionNotice, type MeetingMap, type Remark } from "../src/core/index.ts";

const remarks: ReadonlyMap<string, Remark> = new Map([
  ["early", { id: "early", track: "相手", start: 0, end: 1, text: "合成の発言" }],
  ["later", { id: "later", track: "相手", start: 100, end: 101, text: "合成の発言" }],
]);
const meeting = (): MeetingMap => ({
  ...emptyMap("合成会議"),
  nodes: {
    root: { id: "root", parent: null, kind: "会議", text: "合成会議", evidence: [] },
    a: { id: "a", parent: "root", kind: "論点", text: "進め方", evidence: ["later", "early"] },
    one: { id: "one", parent: "a", kind: "案", text: "案", evidence: ["early"] },
    two: { id: "two", parent: "a", kind: "課題", text: "課題", evidence: ["early"] },
    three: { id: "three", parent: "a", kind: "要点", text: "要点", evidence: ["early"] },
  },
  order: ["root", "a", "one", "two", "three"], nextId: 1,
});

describe("公開の堂々巡り判定", () => {
  it("根拠の並びによらず最初の発言を使い、案以外の直下の子も数え、入力を変更しない", () => {
    const map = meeting();
    const before = structuredClone(map);
    const initial = createDiscussionNoticeState();
    const waiting = observeDiscussion(initial, map, remarks, 599);
    expect(nextDiscussionNotice(waiting, map, 599, [])).toBeUndefined();
    const ready = observeDiscussion(waiting, map, remarks, 600);
    const event = nextDiscussionNotice(ready, map, 600, []);
    expect(event).toEqual({ type: "discussion-notice", pointId: "a", at: 600, text: "「進め方」が 10 分決まっていません。何を重視して決めるかを先に確かめませんか" });
    if (event === undefined) throw new Error("通知がありません");
    const recorded = recordDiscussionNotice(ready, event);
    expect(nextDiscussionNotice(recorded, map, 1000, [])).toBeUndefined();
    expect(nextDiscussionNotice(ready, map, 600, [])).toEqual(event);
    expect(map).toEqual(before);
    expect(nextDiscussionNotice(initial, map, 600, [])).toBeUndefined();
  });

  it("マップの先頭より先に条件が成立した論点を選ぶ", () => {
    const map = meeting();
    map.nodes.a = { ...map.nodes.a!, evidence: ["later"] };
    map.nodes.b = { id: "b", parent: "root", kind: "論点", text: "導入時期", evidence: ["early"] };
    for (const id of ["one", "two", "three"]) map.nodes[`b-${id}`] = { ...map.nodes[id]!, id: `b-${id}`, parent: "b" };
    map.order.push("b", "b-one", "b-two", "b-three");
    const firstReady = observeDiscussion(createDiscussionNoticeState(), map, remarks, 600);
    const bothReady = observeDiscussion(firstReady, map, remarks, 700);
    expect(nextDiscussionNotice(bothReady, map, 700, [])).toMatchObject({ pointId: "b", at: 700 });
  });
});
