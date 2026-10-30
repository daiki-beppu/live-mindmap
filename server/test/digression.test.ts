import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  applyOps, diffMaps, DiffOperations, emptyMap, exportFiles, JsonExport,
  KINDS, Op, reviewSnapshot, Snapshot, toJsonExport, type Kind, type MapNode, type MeetingMap, type Remark,
} from "../src/core/index.ts";
import { playBatches } from "./fixtures/batches.ts";

const known = new Set(["r1", "r2"]);
const apply = (map: MeetingMap, ops: Op[]) => applyOps(map, ops, known, { round: 3, at: 30 }, new Map());
const add = (ref: string, parent: string, kind: Kind, digression?: boolean) => ({
  op: "add" as const, ref, parent, kind, text: ref, evidence: ["r1"],
  ...(digression === undefined ? {} : { digression }),
});
const update = (node: string, digression: boolean) => ({ op: "update" as const, node, evidence: ["r1"], digression });
const node = (id: string, parent: string, kind: Kind, digression?: boolean): MapNode => ({
  id, parent, kind, text: id, evidence: ["r1"], touchedAt: 1, evidenceRound: 1,
  ...(digression === undefined ? {} : { digression }),
});
const tree = (nodes: MapNode[]): MeetingMap => ({
  nodes: { ...emptyMap("採用を決める").nodes, ...Object.fromEntries(nodes.map((n) => [n.id, n])) },
  order: ["root", ...nodes.map((n) => n.id)], nextId: nodes.length + 1,
});
const markedIds = (map: MeetingMap) => Object.values(map.nodes).filter((n) => "digression" in n && n.digression === true).map((n) => n.id);

describe("議題の脱線: 公開の差分操作", () => {
  it("追加の脱線指定がモデル出力の decode と applyOps を通る", () => {
    const output = Schema.decodeUnknownSync(DiffOperations)({ ops: [add("旅行", "root", "議題", true)] });
    expect(output.ops[0]).toHaveProperty("digression", true);
    const result = apply(emptyMap("採用を決める"), output.ops);
    expect(result.dropped).toEqual([]);
    expect(result.map.nodes[result.refs["旅行"]!]).toHaveProperty("digression", true);
  });

  it("同じ議題を更新で脱線にし、省略した更新では保ち、続く更新で外せる", () => {
    const before = tree([node("n1", "root", "議題")]);
    const marked = apply(before, [update("n1", true)]);
    expect(marked.dropped).toEqual([]);
    expect(marked.map.nodes.n1).toHaveProperty("digression", true);
    const kept = apply(marked.map, [{ op: "update", node: "n1", text: "旅行先", evidence: ["r1"] }]);
    expect(kept.map.nodes.n1).toHaveProperty("digression", true);
    const cleared = apply(kept.map, [update("n1", false)]);
    expect(cleared.dropped).toEqual([]);
    expect(markedIds(cleared.map)).toEqual([]);
    expect(cleared.map.nodes.n1).toMatchObject({ id: "n1", text: "旅行先", evidence: ["r1"] });
  });

  it.each(KINDS.filter((kind) => kind !== "議題"))("%s への true・false の追加と更新を拒み、一部だけ反映しない", (kind) => {
    const before = tree([node("n1", "root", "論点"), node("n2", "n1", kind)]);
    for (const value of [true, false]) {
      const added = apply(before, [add("不正", "n1", kind, value)]);
      expect(added.dropped).toHaveLength(1);
      expect(added.map).toEqual(before);
      const updated = apply(before, [{ ...update("n2", value), text: "変えてはいけない" }]);
      expect(updated.dropped).toHaveLength(1);
      expect(updated.map).toEqual(before);
    }
  });

  it("根拠が不正な指定を拒否し、同じ議題への有効な再指定は反映できる", () => {
    const before = tree([node("n1", "root", "議題")]);
    const rejected = apply(before, [{ ...update("n1", true), evidence: ["unknown"] }]);
    expect(rejected.dropped).toHaveLength(1);
    expect(rejected.map).toEqual(before);
    expect(apply(rejected.map, [update("n1", true)]).map.nodes.n1).toHaveProperty("digression", true);
  });

  it("独立した枝ではそれぞれの付け根の議題を脱線にできる", () => {
    const result = apply(tree([node("n1", "root", "議題", true), node("n2", "root", "議題")]), [update("n2", true)]);
    expect(result.dropped).toEqual([]);
    expect(markedIds(result.map)).toEqual(["n1", "n2"]);
  });

  it.each(["n1", "n2"])("脱線した祖先の下への追加は印を重ねない（親 %s）", (parent) => {
    const before = tree([node("n1", "root", "議題", true), node("n2", "n1", "要点")]);
    const result = apply(before, [add("宿泊", parent, "議題", true)]);
    expect(markedIds(result.map)).toEqual(["n1"]);
  });

  it("非議題を挟んだ孫への更新でも脱線の印は祖先だけに残る", () => {
    const before = tree([node("n1", "root", "議題", true), node("n2", "n1", "要点"), node("n3", "n2", "議題")]);
    const result = apply(before, [update("n3", true)]);
    expect(markedIds(result.map)).toEqual(["n1"]);
    expect(result.map.nodes.n3).toMatchObject({ id: "n3", parent: "n2" });
  });

  it("同じ応答で追加した仮参照の祖先にも子孫制約が働く", () => {
    const result = apply(emptyMap("採用を決める"), [add("旅行", "root", "議題", true), add("宿泊", "旅行", "議題", true)]);
    expect(result.map.nodes[result.refs["旅行"]!]).toHaveProperty("digression", true);
    expect(markedIds(result.map)).toEqual([result.refs["旅行"]]);
  });

  it("後から祖先を脱線にすると子孫の印を除き、祖先を解除しても子孫へ戻さない", () => {
    const before = tree([node("n1", "root", "議題"), node("n2", "n1", "要点"), node("n3", "n2", "議題", true)]);
    const marked = apply(before, [update("n1", true)]);
    expect(marked.dropped).toEqual([]);
    expect(markedIds(marked.map)).toEqual(["n1"]);
    expect(markedIds(apply(marked.map, [update("n1", false)]).map)).toEqual([]);
  });

  it("印を持つ部分木を脱線した議題の下へ移しても印を重ねない", () => {
    const before = tree([node("n1", "root", "議題", true), node("n2", "root", "要点"), node("n3", "n2", "議題", true)]);
    const result = apply(before, [{ op: "move", node: "n2", parent: "n1" }]);
    expect(result.dropped).toEqual([]);
    expect(result.map.nodes.n2!.parent).toBe("n1");
    expect(markedIds(result.map)).toEqual(["n1"]);
  });

  it("統合で子孫を脱線した議題へ引き取っても印を重ねない", () => {
    const before = tree([node("n1", "root", "議題", true), node("n2", "root", "議題"), node("n3", "n2", "議題", true)]);
    const result = apply(before, [{ op: "combine", from: "n2", into: "n1" }]);
    expect(result.dropped).toEqual([]);
    expect(result.map.nodes.n3!.parent).toBe("n1");
    expect(markedIds(result.map)).toEqual(["n1"]);
  });

  it.effect("同じセッションで脱線だけを付け外ししても済みと現在議題を保ち、内容の更新では開き直す", () => Effect.gen(function* () {
    const snapshots: Snapshot[] = [];
    const batches: Remark[][] = [1, 2, 3, 4, 5, 6].map((round) => [{ id: `r${round}`, track: "相手", start: round - 1, end: round, text: "発言" }]);
    const { calls } = yield* playBatches(batches, [
      [add("旅行", "root", "議題"), add("採用", "root", "議題")],
      [{ op: "noop", reason: "次の話" }],
      [{ op: "close", node: "n1" }],
      [update("n1", true)],
      [update("n1", false)],
      [{ op: "update", node: "n1", text: "研修の行き先", evidence: ["r6"] }],
    ], { onApplied: (_round, session) => Effect.gen(function* () { snapshots.push(yield* session.snapshot); }) });
    for (const index of [2, 3, 4]) {
      expect(snapshots[index]!.currentTopic).toBe("n2");
      expect(snapshots[index]!.nodes.find((n) => n.id === "n1")).toHaveProperty("talkStatus", "済み");
    }
    expect(snapshots[3]!.nodes.find((n) => n.id === "n1")).toHaveProperty("digression", true);
    expect(calls[4]!.map.nodes.n1).toHaveProperty("digression", true);
    expect(snapshots[4]!.nodes.find((n) => n.id === "n1")).not.toHaveProperty("digression", true);
    expect(snapshots[5]!.currentTopic).toBe("n1");
    expect(snapshots[5]!.nodes.find((n) => n.id === "n1")).not.toHaveProperty("talkStatus");
  }));
});

describe("議題の脱線: 変更履歴・保存形式", () => {
  it.each([true, false])("脱線だけの変化を既存の更新として記録する（%s）", (value) => {
    const before = tree([node("n1", "root", "議題", !value)]);
    expect(diffMaps(before, apply(before, [update("n1", value)]))).toEqual([{ change: "更新", node: "n1", kind: "議題", text: "n1" }]);
  });

  it("同じ印と根拠の再指定では更新履歴を増やさない", () => {
    const before = tree([node("n1", "root", "議題", true)]);
    expect(diffMaps(before, apply(before, [update("n1", true)]))).toEqual([]);
  });

  it("ログの操作と配信スナップショットの decode で脱線が失われない", () => {
    const events = [
      { type: "start", title: "採用を決める" },
      { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 1, text: "旅行の話" } },
      { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [add("旅行", "root", "議題", true)], dropped: [] },
    ];
    const restored = reviewSnapshot(events);
    expect(restored.nodes.find((n) => n.kind === "議題")).toHaveProperty("digression", true);
    const decoded = Schema.decodeUnknownSync(Snapshot)(JSON.parse(JSON.stringify(restored)));
    expect(decoded.nodes.find((n) => n.kind === "議題")).toHaveProperty("digression", true);
  });

  it("JSON 書出しと読戻しは議題の任意欄一つで脱線を保つ", () => {
    const nodes = [emptyMap("採用を決める").nodes.root!, node("n1", "root", "議題", true), node("n2", "n1", "要点")];
    const snapshot: Snapshot = { nodes, round: 1, changes: [], remarks: [] };
    const exported = toJsonExport(snapshot, []);
    const json: unknown = JSON.parse(exportFiles(exported)["map.json"]);
    const decoded = Schema.decodeUnknownSync(JsonExport)(json);
    expect(decoded.root.children[0]).toHaveProperty("digression", true);
    const plain = toJsonExport({ ...snapshot, nodes: nodes.map((n) => ({ id: n.id, parent: n.parent, kind: n.kind, text: n.text, evidence: n.evidence })) }, []);
    const marked = decoded.root.children[0]!;
    expect(Object.keys(marked).filter((key) => !(key in plain.root.children[0]!))).toEqual(["digression"]);
    expect(marked.children[0]).not.toHaveProperty("digression");
  });

  it("脱線欄がない既存 JSON を変換なしで読み込める", () => {
    const old = { root: { id: "root", kind: "会議", text: "採用", evidence: [], children: [{ id: "n1", kind: "議題", text: "採用人数", evidence: [], children: [] }] } };
    const decoded = Schema.decodeUnknownSync(JsonExport)(old);
    expect(decoded).toEqual(old);
    expect(decoded.root.children[0]).not.toHaveProperty("digression");
  });

  it.each([true, false])("更新操作の decode は付与と解除の指定を保つ（%s）", (value) => {
    expect(Schema.decodeUnknownSync(Op)(update("n1", value))).toHaveProperty("digression", value);
  });
});
