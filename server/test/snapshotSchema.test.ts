import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { reviewSnapshot, Snapshot } from "../src/core/index.ts";
import { expectDecodeSuccess } from "./fixtures/coreSchema.ts";
import logText from "./fixtures/session.log.jsonl?raw";

// 今の形式の log.jsonl（fixtures/session.log.jsonl）から作った Snapshot が、core の Snapshot Schema で decode・encode して往復する

const lines = logText
  .split("\n")
  .filter((l) => l !== "")
  .map((l): unknown => JSON.parse(l));

describe("Snapshot の Schema", () => {
  it("fixture から作った Snapshot は、往復の確認が中身のない値で通らないだけの内容を持つ（テストの前提）", () => {
    const snapshot = reviewSnapshot(lines);
    assert.isTrue(snapshot.nodes.some((n) => n.pointStatus === "決定済み"));
    assert.isAbove(snapshot.changes.length, 0);
    assert.isAbove(snapshot.remarks.length, 0);
    assert.strictEqual(snapshot.currentTopic, "n1");
    assert.strictEqual(snapshot.now, 90);
  });

  it.effect("decode した値を encode すると、元の Snapshot に戻る", () =>
    Effect.gen(function* () {
      const snapshot = reviewSnapshot(lines);
      const decoded = yield* expectDecodeSuccess(Schema.decodeUnknownEffect(Snapshot)(snapshot));
      const encoded = yield* Schema.encodeEffect(Snapshot)(decoded);
      assert.deepStrictEqual(encoded, snapshot);
    }));

  it.effect("形の違う値は decode に失敗する（pointStatus が列挙の外）", () =>
    Effect.gen(function* () {
      const snapshot = reviewSnapshot(lines);
      const broken = { ...snapshot, nodes: snapshot.nodes.map((n) => ({ ...n, pointStatus: "保留" })) };
      const result = yield* Effect.result(Schema.decodeUnknownEffect(Snapshot)(broken));
      assert.isTrue(result._tag === "Failure");
    }));

  it.effect("changes の変更種別が列挙の外なら decode に失敗する", () =>
    Effect.gen(function* () {
      const snapshot = reviewSnapshot(lines);
      const broken = { ...snapshot, changes: snapshot.changes.map((c) => ({ ...c, change: "削除" })) };
      const result = yield* Effect.result(Schema.decodeUnknownEffect(Snapshot)(broken));
      assert.isTrue(result._tag === "Failure");
    }));
});
