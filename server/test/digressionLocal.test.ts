import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { applyOps, DiffUpdater, emptyMap, type MeetingMap, type Remark } from "../src/core/index.ts";
import { localUpdaterLayer } from "../src/localDiffUpdater.ts";
import { classificationRequest } from "../src/localPrompt.ts";

const fresh: Remark = { id: "r2", track: "相手", start: 2, end: 3, text: "面接の待合場所に使います。" };
const existing = (): MeetingMap => applyOps(emptyMap("採用を決める"), [
  { op: "add", ref: "a", parent: "root", kind: "議題", text: "喫茶店", evidence: ["r1"], digression: true },
  { op: "add", ref: "b", parent: "root", kind: "議題", text: "面接", evidence: ["r1"] },
  { op: "add", ref: "c", parent: "n1", kind: "要点", text: "店主", evidence: ["r1"] },
], new Set(["r1"]), { round: 1, at: 1 }, new Map()).map;
const requestOf = (map: MeetingMap) => classificationRequest(map, [], [{ remark: fresh, text: fresh.text }]);
const response = (id: string, digression: boolean) => ({
  議題: { id: "新しい議題", 題: "釣り" }, 済み: "なし", 名前: [],
  脱線: [{ id, digression, evidence: "r2" }], 文: [{ 種類: "なし" }],
});

describe("ローカルの脱線操作", () => {
  it.effect("新しい議題の脱線指定を共通のaddへ変換する", () => Effect.gen(function* () {
    const layer = localUpdaterLayer({
      katakana: () => Effect.succeed([]),
      classify: (request) => Effect.sync(() => Schema.decodeUnknownSync(request.schema)({ ...response("新しい議題", true), 文: [{ 種類: "説明", text: "魚が釣れた" }] })),
    });
    const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
    const output = yield* updater.update({ map: emptyMap("採用を決める"), recent: [], fresh: [fresh] });
    expect(output.ops.find((op) => op.op === "add" && op.kind === "議題")).toMatchObject({ digression: true, evidence: ["r2"] });
  }));

  it.effect("選択中とは別の済みの議題でも、文がなしの回に印を外せる", () => Effect.gen(function* () {
    const map = existing();
    map.nodes.n1!.talkStatus = "済み";
    const layer = localUpdaterLayer({
      katakana: () => Effect.succeed([]),
      classify: (request) => Effect.sync(() => Schema.decodeUnknownSync(request.schema)({ ...response("n1", false), 議題: { id: "n2", 題: "" } })),
    });
    const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
    const output = yield* updater.update({ map, recent: [], fresh: [fresh] });
    expect(output.ops).toEqual([{ op: "update", node: "n1", digression: false, evidence: ["r2"] }]);
    const applied = applyOps(map, output.ops, new Set(["r1", "r2"]), { round: 2, at: 3 }, new Map());
    expect(applied.dropped).toEqual([]);
    expect(applied.map.nodes.n1).not.toHaveProperty("digression");
    expect(applied.map.nodes.n1).toHaveProperty("talkStatus", "済み");
  }));

  it.effect("既存の議題への付与も選択先や新規作成に依存しない", () => Effect.gen(function* () {
    const map = existing();
    delete map.nodes.n1!.digression;
    const layer = localUpdaterLayer({
      katakana: () => Effect.succeed([]),
      classify: (request) => Effect.sync(() => Schema.decodeUnknownSync(request.schema)({ ...response("n1", true), 議題: { id: "n2", 題: "" } })),
    });
    const updater = yield* DiffUpdater.pipe(Effect.provide(layer));
    const output = yield* updater.update({ map, recent: [], fresh: [fresh] });
    expect(output.ops).toEqual([{ op: "update", node: "n1", digression: true, evidence: ["r2"] }]);
    const applied = applyOps(map, output.ops, new Set(["r1", "r2"]), { round: 2, at: 3 }, new Map());
    expect(applied.dropped).toEqual([]);
    expect(applied.map.nodes.n1).toHaveProperty("digression", true);
  }));

  it.each(["n3", "missing"])("分類の出力では非議題・存在しない対象を受理しない（%s）", (id) => {
    expect(() => Schema.decodeUnknownSync(requestOf(existing()).schema)(response(id, true))).toThrow();
  });

  it("分類の根拠は新しい発言に限り、未知の根拠は受理しない", () => {
    expect(() => Schema.decodeUnknownSync(requestOf(existing()).schema)({ ...response("n1", false), 脱線: [{ id: "n1", digression: false, evidence: "unknown" }] })).toThrow();
  });
});
