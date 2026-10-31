import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { applyOps, DiffUpdater, emptyMap, type MeetingMap, type Remark } from "../src/core/index.ts";
import { localUpdaterLayer } from "../src/localDiffUpdater.ts";
import { classificationRequest, probeRequest, splitSentences, SYSTEM } from "../src/localPrompt.ts";

const remark: Remark = { id: "r2", track: "相手", start: 1, end: 2, text: "SLA はその意味ではありません。" };
const prepared = (): MeetingMap => ({
  nodes: {
    ...emptyMap("運用").nodes,
    n1: { id: "n1", parent: "root", kind: "議題", text: "サービス水準", evidence: ["r1"] },
    n2: { id: "n2", parent: "n1", kind: "要点", text: "SLA", evidence: ["r1"] },
    n3: { id: "n3", parent: "n2", kind: "補足", text: "サービス水準の合意", origin: "会議の外", evidence: ["r1"] },
    n4: { id: "n4", parent: "n1", kind: "要点", text: "SLO", evidence: ["r1"] },
    n5: { id: "n5", parent: "n4", kind: "補足", text: "サービス水準の目標", origin: "会議の外", evidence: ["r1"] },
  }, order: ["root", "n1", "n2", "n3", "n4", "n5"], nextId: 6,
});
const response = () => ({ 議題: { id: "n1", 題: "" }, 済み: "なし", 名前: [], 文: [{ 種類: "なし" }] });
const requestOf = (map: MeetingMap) => classificationRequest(map, [], splitSentences(remark));

describe("文分類の補足の出力", () => {
  it("要点に添えた補足の ID・本文と親の情報を提示する", () => {
    const { prompt } = requestOf(prepared());
    for (const value of ["n3", "サービス水準の合意", "n2", "SLA"]) expect(prompt).toContain(value);
  });

  it("誤りの指摘時だけの削除と、子・根拠の追加禁止を伝える", () => {
    const rules = SYSTEM.split(/\n/).filter((line) => line.includes("補足")).join("\n");
    expect(rules).toMatch(/会議[^\n]*誤り[^\n]*ときだけ[^\n]*(消|削除)/);
    expect(rules).toMatch(/子[^\n]*(付けない|追加しない|作らない)/);
    expect(rules).toMatch(/根拠[^\n]*(足さない|追加しない|付けない)/);
  });

  it("通常の説明は受け付け、補足という文の種類は受け付けない", () => {
    const { schema } = requestOf(prepared());
    const value = { ...response(), 文: [{ 種類: "説明", text: "補足" }] };
    expect(Schema.decodeUnknownSync(schema)(value)).toEqual(value);
    expect(() => Schema.decodeUnknownSync(schema)({ ...value, 文: [{ 種類: "補足", text: "サービス水準の合意" }] })).toThrow();
  });

  it.each(["n1", "n2", "missing"])("補足以外・存在しない ID %s は削除対象にできない", (id) => {
    expect(() => Schema.decodeUnknownSync(requestOf(prepared()).schema, { onExcessProperty: "error" })({ ...response(), 補足の削除: [id] })).toThrow();
  });

  it("補足のないマップと接続確認でも有効な分類結果を受け付ける", () => {
    for (const request of [requestOf(emptyMap("運用")), probeRequest()]) {
      const value = { ...response(), 議題: { id: "新しい議題", 題: "" }, 補足の削除: [] };
      expect(Schema.decodeUnknownSync(request.schema, { onExcessProperty: "error" })(value)).toEqual(value);
      expect(() => Schema.decodeUnknownSync(request.schema, { onExcessProperty: "error" })({ ...value, 補足の削除: ["n3"] })).toThrow();
    }
  });

  it.effect("複数の分類で同じ補足の削除が返っても、一度だけ削除する", () => Effect.gen(function* () {
    let calls = 0;
    const updater = yield* DiffUpdater.pipe(Effect.provide(localUpdaterLayer({
      katakana: () => Effect.succeed([]),
      classify: (request) => Effect.sync(() => {
        calls++;
        return Schema.decodeUnknownSync(request.schema, { onExcessProperty: "error" })({
          ...response(), 補足の削除: ["n3", "n3"],
          文: Array.from({ length: calls === 1 ? 3 : 1 }, () => ({ 種類: "なし" })),
        });
      }),
    })));
    const before = prepared();
    const output = yield* updater.update({ map: before, recent: [], fresh: [{ ...remark, text: "一。二。三。四。" }] });
    expect(calls).toBe(2);
    expect(output.ops).toEqual([{ op: "delete", node: "n3" }]);
    expect(output.processedRemarks).toBe(1);
    expect(applyOps(before, output.ops, new Set(["r1", "r2"]), { round: 2, at: 2 }, new Map()).dropped).toEqual([]);
  }));

  it.effect("同じ updater で、指定した補足だけを削除し、次回は削除後のマップを提示する", () => Effect.gen(function* () {
    const requests: ReturnType<typeof classificationRequest>[] = [];
    const layer = localUpdaterLayer({
      katakana: () => Effect.succeed([]),
      classify: (request) => Effect.sync(() => {
        requests.push(request);
        return Schema.decodeUnknownSync(request.schema, { onExcessProperty: "error" })({
          ...response(), 補足の削除: requests.length === 1 ? ["n3"] : [],
        });
      }),
    });
    const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
    const before = prepared();
    const output = yield* updater.update({ map: before, recent: [], fresh: [remark] });
    expect(requests[0]!.prompt).toContain("サービス水準の合意");
    expect(output.ops).toEqual([{ op: "delete", node: "n3" }]);
    expect(output.processedRemarks).toBe(1);
    const applied = applyOps(before, output.ops, new Set(["r1", "r2"]), { round: 2, at: 2 }, new Map([["r2", remark]]));
    expect(applied.dropped).toEqual([]);
    expect(applied.map.nodes.n3).toBeUndefined();
    expect(applied.map.order).not.toContain("n3");
    for (const id of ["n1", "n2", "n4", "n5"]) expect(applied.map.nodes[id]).toMatchObject(before.nodes[id]!);
    const next = yield* updater.update({ map: applied.map, recent: [remark], fresh: [{ ...remark, id: "r3", text: "はい。" }] });
    expect(next.ops).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).not.toContain("サービス水準の合意");
    expect(requests[1]!.prompt).toContain("サービス水準の目標");
    expect(() => Schema.decodeUnknownSync(requests[1]!.schema, { onExcessProperty: "error" })({ ...response(), 補足の削除: ["n3"] })).toThrow();
  }));
});
