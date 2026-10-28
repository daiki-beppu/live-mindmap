import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { applyOps, DiffUpdater, emptyMap, type MeetingMap, type Op, type Remark } from "../src/core/index.ts";
import { localUpdaterLayer } from "../src/localDiffUpdater.ts";
import type { Classification } from "../src/localPrompt.ts";

const remark: Remark = { id: "r1", track: "相手", start: 0, end: 1, text: "候補です。" };
const add = (ref: string, parent: string, kind: "議題" | "論点" | "決定"): Op => ({
  op: "add", ref, parent, kind, text: ref, evidence: ["r1"],
});
const prepared = (extra: Op[]) => applyOps(emptyMap("会議"), [
  add("topic", "root", "議題"), ...extra,
], new Set(["r1"]), { round: 1, at: 1 }, new Map([["r1", remark]])).map;
const run = (map: MeetingMap, sentences: Classification["文"]) => {
  let offset = 0;
  return Effect.gen(function* () {
    const updater = yield* DiffUpdater;
    return yield* updater.update({ map, recent: [], fresh: [{ ...remark, text: sentences.map(() => "候補。").join("") }] });
  }).pipe(Effect.provide(localUpdaterLayer({
    classify: (request) => Effect.sync(() => {
      const batch = sentences.slice(offset, offset + 3);
      offset += batch.length;
      return Schema.decodeUnknownSync(request.schema)({ 議題: { id: "n1", 題: "" }, 文: batch, 済み: "なし", 名前: [] });
    }),
    katakana: () => Effect.succeed([]),
  })));
};
const proposal = { 種類: "提案", text: "小さく始める" } satisfies Classification["文"][number];
const parentOfProposal = (ops: readonly Op[]) => ops.find((op) => op.op === "add" && op.kind === "案");

describe("ローカル分類の提案の追加先", () => {
  it.effect("選択議題の未決・話し中の論点が一つなら、他議題や決定済み・済みを除いてその子にする", () => Effect.gen(function* () {
    const map = prepared([
      add("active", "topic", "論点"), add("decided", "topic", "論点"), add("decision", "decided", "決定"),
      add("closed", "topic", "論点"), add("otherTopic", "root", "議題"), add("other", "otherTopic", "論点"),
    ]);
    map.nodes.n5!.talkStatus = "済み";
    const before = structuredClone(map);
    const result = yield* run(map, [proposal]);
    expect(parentOfProposal(result.ops)).toMatchObject({ parent: "n2" });
    expect(result.processedRemarks).toBe(1);
    expect(map).toEqual(before);
  }));

  it.effect.each([[], [add("a", "topic", "論点"), add("b", "topic", "論点")]])("対象がない・複数で曖昧なときは議題直下を保持する (%#)", (extra) => Effect.gen(function* () {
    expect(parentOfProposal((yield* run(prepared(extra), [proposal])).ops)).toMatchObject({ parent: "n1" });
  }));

  it.effect("同じ応答内で問いが生まれた後の提案は、その仮参照の子として反映できる", () => Effect.gen(function* () {
    const map = prepared([]);
    const result = yield* run(map, [{ 種類: "問い", text: "導入方法は" }, proposal]);
    const applied = applyOps(map, result.ops, new Set(["r1"]), { round: 2, at: 2 }, new Map([["r1", remark]]));
    expect(applied.dropped).toEqual([]);
    const point = Object.values(applied.map.nodes).find((node) => node.kind === "論点")!;
    expect(Object.values(applied.map.nodes).find((node) => node.kind === "案")).toMatchObject({ parent: point.id });
  }));

  it.effect("問いが増えて複数になった後の提案は、一つに決めつけない", () => Effect.gen(function* () {
    const result = yield* run(prepared([add("a", "topic", "論点")]), [{ 種類: "問い", text: "別の問い" }, proposal]);
    expect(parentOfProposal(result.ops)).toMatchObject({ parent: "n1" });
  }));

  it.effect("同じ更新の前の分類で生成した問いも、次の分類の提案の追加先になる", () => Effect.gen(function* () {
    const map = prepared([]);
    const result = yield* run(map, [
      { 種類: "問い", text: "配布方法は" }, { 種類: "なし" }, { 種類: "なし" }, proposal,
    ]);
    const applied = applyOps(map, result.ops, new Set(["r1"]), { round: 2, at: 2 }, new Map([["r1", remark]]));
    expect(applied.dropped).toEqual([]);
    expect(Object.values(applied.map.nodes).find((node) => node.kind === "案")).toMatchObject({ parent: "n2" });
  }));

  it.effect("議題配下の入れ子の論点も対象にし、済みの枝の論点は対象にしない", () => Effect.gen(function* () {
    const map = prepared([
      add("group", "topic", "議題"), add("a", "group", "論点"),
      add("closedGroup", "topic", "議題"), add("b", "closedGroup", "論点"),
    ]);
    map.nodes.n4!.talkStatus = "済み";
    expect(parentOfProposal((yield* run(map, [proposal])).ops)).toMatchObject({ parent: "n3" });
  }));

  it.effect("明示された合意先は保持し、その決定後の提案を決定済み論点へ追加しない", () => Effect.gen(function* () {
    const result = yield* run(prepared([add("a", "topic", "論点")]), [
      { 種類: "合意", 論点: "n2", 論点の文: "", text: "採用" }, proposal,
    ]);
    expect(result.ops.find((op) => op.op === "add" && op.kind === "決定")).toMatchObject({ parent: "n2" });
    expect(parentOfProposal(result.ops)).toMatchObject({ parent: "n1" });
  }));

  it.effect("同じ応答内の新しい論点への合意を保持し、その後の提案は議題直下にする", () => Effect.gen(function* () {
    const map = prepared([]);
    const result = yield* run(map, [
      { 種類: "合意", 論点: "新しい論点", 論点の文: "導入方法は", text: "採用" }, proposal,
    ]);
    const applied = applyOps(map, result.ops, new Set(["r1"]), { round: 2, at: 2 }, new Map([["r1", remark]]));
    expect(applied.dropped).toEqual([]);
    expect(Object.values(applied.map.nodes).find((node) => node.kind === "決定")).toMatchObject({ parent: "n2" });
    expect(Object.values(applied.map.nodes).find((node) => node.kind === "案")).toMatchObject({ parent: "n1" });
  }));

  it.effect("提案より後に現れる問いへ、先の提案を遡って付け替えない", () => Effect.gen(function* () {
    const result = yield* run(prepared([]), [proposal, { 種類: "問い", text: "配布方法は" }]);
    expect(parentOfProposal(result.ops)).toMatchObject({ parent: "n1" });
  }));
});
