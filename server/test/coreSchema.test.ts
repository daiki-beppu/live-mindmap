import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import { DiffOutput, HelperEvent, LogEvent, makeSession } from "../src/core/index.ts";
import { expectDecodeSuccess } from "./fixtures/coreSchema.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

function expectDecodeFailure<A, R>(effect: Effect.Effect<A, Schema.SchemaError, R>) {
  return Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    assert.isTrue(Result.isFailure(result), "decode が成功してしまった（壊れた入力のはずが通った）");
  });
}

describe("ヘルパーのイベント（CT-4DATA）: helper/README.md「イベントの形」の実例を decode できる", () => {
  const examples: ReadonlyArray<{ title: string; data: unknown }> = [
    { title: "partial（相手）", data: { type: "partial", track: "相手", start: 1.5, end: 2, text: "こんに", duplicate: false } },
    { title: "remark（相手）", data: { type: "remark", track: "相手", start: 1.5, end: 3.25, text: "こんにちは", duplicate: false } },
    { title: "partial（自分）", data: { type: "partial", track: "自分", start: 4, end: 4.5, text: "はい", duplicate: false } },
    { title: "origin", data: { type: "origin", hostTime: "123456789" } },
  ];
  for (const { title, data } of examples) {
    it.effect(title, () => expectDecodeSuccess(Schema.decodeUnknownEffect(HelperEvent)(data)));
  }
});

describe("ヘルパーのイベントの規則（CT-RULES）", () => {
  describe("duplicate が無ければ decode 後は false（live.ts:16,31 / live.test.ts:48-50 の規則）", () => {
    for (const type of ["remark", "partial"] as const) {
      it.effect(`${type}: duplicate を省くと decode 後に false になる`, () =>
        Effect.gen(function* () {
          const decoded = yield* expectDecodeSuccess(
            Schema.decodeUnknownEffect(HelperEvent)({ type, track: "相手", start: 0, end: 1, text: "あ" }),
          );
          if (decoded.type !== "remark" && decoded.type !== "partial") {
            assert.fail("remark か partial のはず");
            return;
          }
          assert.strictEqual(decoded.duplicate, false);
        }));

      it.effect(`${type}: duplicate: true はそのまま true になる`, () =>
        Effect.gen(function* () {
          const decoded = yield* expectDecodeSuccess(
            Schema.decodeUnknownEffect(HelperEvent)({ type, track: "相手", start: 0, end: 1, text: "あ", duplicate: true }),
          );
          if (decoded.type !== "remark" && decoded.type !== "partial") {
            assert.fail("remark か partial のはず");
            return;
          }
          assert.strictEqual(decoded.duplicate, true);
        }));
    }
  });

  describe("hostTime は数字だけの文字列に限る（live.ts:41 / live.test.ts:85-89 の規則）", () => {
    it.effect("数字の文字列はそのまま文字列として通る（2^53 を超える値でも桁が落ちない）", () =>
      Effect.gen(function* () {
        const decoded = yield* expectDecodeSuccess(
          Schema.decodeUnknownEffect(HelperEvent)({ type: "origin", hostTime: "9007199254740993" }),
        );
        if (decoded.type !== "origin") {
          assert.fail("origin のはず");
          return;
        }
        assert.strictEqual(decoded.hostTime, "9007199254740993");
      }));

    const failures: ReadonlyArray<{ title: string; data: unknown }> = [
      { title: "hostTime が number（JSON の number は桁が落ちるので受け付けない）", data: { type: "origin", hostTime: 9007199254740993 } },
      { title: "hostTime が数字でない文字列", data: { type: "origin", hostTime: "12a" } },
      { title: "hostTime の欠落", data: { type: "origin" } },
    ];
    for (const { title, data } of failures) {
      it.effect(`${title}は decode に失敗する`, () => expectDecodeFailure(Schema.decodeUnknownEffect(HelperEvent)(data)));
    }
  });
});

describe("ログの行（LogEvent）（CT-4DATA）", () => {
  const diffOps = [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "update", node: "n1", text: "採用を進める", evidence: ["r1"], planStatus: "検討中" },
    { op: "combine", from: "n2", into: "n3" },
    { op: "move", node: "n4", parent: "n5" },
    { op: "delete", node: "n6" },
    { op: "noop", reason: "変化なし" },
    { op: "close", node: "n7" },
  ];
  const examples: ReadonlyArray<{ title: string; event: unknown }> = [
    { title: "start", event: { type: "start", title: "定例" } },
    { title: "remark（noContent なし）", event: { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 1, text: "こんにちは" } } },
    {
      title: "remark（noContent つき）",
      event: { type: "remark", remark: { id: "r2", track: "自分", start: 1, end: 2, text: "あ" }, noContent: true },
    },
    {
      title: "diff（成功）",
      event: {
        type: "diff",
        input: { recent: [], fresh: ["r1"], nodeCount: 0 },
        ops: diffOps,
        dropped: [{ op: { op: "noop", reason: "捨てる" }, reason: "テスト" }],
      },
    },
    {
      title: "diff（usage つき）",
      event: {
        type: "diff",
        input: { recent: [], fresh: ["r1"], nodeCount: 0 },
        ops: [{ op: "noop", reason: "変化なし" }],
        dropped: [],
        usage: { input: 10, cacheWrite: 20, cacheRead: 30, output: 40, model: "claude-sonnet-5-5" },
      },
    },
    {
      title: "diff（失敗）",
      event: { type: "diff", input: { recent: [], fresh: [], nodeCount: 0 }, ops: [], dropped: [], error: "timeout" },
    },
  ];

  for (const { title, event } of examples) {
    it.effect(`${title}は decode できる`, () => expectDecodeSuccess(Schema.decodeUnknownEffect(LogEvent)(event)));

    it.effect(`${title}に at を足した行（cli.ts が書く実際の形）も decode できる`, () =>
      expectDecodeSuccess(
        Schema.decodeUnknownEffect(LogEvent)({ at: "2026-10-06T00:00:00.000Z", ...(event as Record<string, unknown>) }),
      ));
  }
});

describe("diff の行の judge（判定の記録）", () => {
  const diff = (judge: unknown) => ({ type: "diff", input: { recent: [], fresh: [], nodeCount: 0 }, ops: [], dropped: [], judge });
  const decoded = (judge: unknown) => Schema.decodeUnknownEffect(LogEvent)(diff(judge));

  it.effect("確からしさつきの記録は decode でき、値はそのまま残る", () =>
    Effect.gen(function* () {
      const judge = { model: "claude-haiku-5-5", ms: 42, confidence: 0.12 };
      const row = yield* decoded(judge);
      assert.deepStrictEqual(row.type === "diff" ? row.judge : undefined, judge);
    }));

  it.effect("判定できなかった理由つき（確からしさなし）の記録も decode でき、値はそのまま残る", () =>
    Effect.gen(function* () {
      const judge = { model: "claude-sonnet-5-5", ms: 1000, failure: "時間切れ" };
      const row = yield* decoded(judge);
      assert.deepStrictEqual(row.type === "diff" ? row.judge : undefined, judge);
    }));

  it.effect("judge の無い古い行は今までどおり decode できる", () =>
    expectDecodeSuccess(Schema.decodeUnknownEffect(LogEvent)({ type: "diff", input: { recent: [], fresh: [], nodeCount: 0 }, ops: [], dropped: [] })));

  for (const [title, judge] of [
    ["ms が文字列", { model: "m", ms: "42" }],
    ["model が無い", { ms: 42 }],
    ["ms が無い", { model: "m" }],
    ["confidence が文字列", { model: "m", ms: 1, confidence: "0.1" }],
    ["failure が数値", { model: "m", ms: 1, failure: 1 }],
  ] as const) {
    it.effect(`${title}の judge は decode に失敗する`, () => expectDecodeFailure(decoded(judge)));
  }
});

describe("diff の行の usage", () => {
  const diff = (usage: unknown) => ({ type: "diff", input: { recent: [], fresh: [], nodeCount: 0 }, ops: [], dropped: [], usage });
  const valid = { input: 10, cacheWrite: 0, cacheRead: 30, output: 40, model: "claude-sonnet-5-5" };

  it.effect("正しい usage の行は decode でき、usage の値はそのまま残る", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(LogEvent)(diff(valid));
      assert.deepStrictEqual(decoded.type === "diff" ? decoded.usage : undefined, valid);
    }));

  for (const [title, usage] of [
    ["小数のトークン数", { ...valid, output: 1.5 }],
    ["文字列のトークン数", { ...valid, input: "10" }],
    ["model が無い", { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }],
    ["cacheRead が無い", { input: 1, cacheWrite: 1, output: 1, model: "m" }],
  ] as const) {
    it.effect(`${title}の usage は decode に失敗する`, () => expectDecodeFailure(Schema.decodeUnknownEffect(LogEvent)(diff(usage))));
  }
});

describe("Claude の structured_output（DiffOutput）（CT-4DATA）", () => {
  it.effect("claude.test.ts の実例（{ ops: [{ op: noop, reason }] }）を decode できる", () =>
    expectDecodeSuccess(Schema.decodeUnknownEffect(DiffOutput)({ ops: [{ op: "noop", reason: "r" }] })));

  it.effect("JSON Schema（claude.ts が DiffOutput から作る）と同じ 7 操作それぞれ 1 件を decode できる", () =>
    expectDecodeSuccess(
      Schema.decodeUnknownEffect(DiffOutput)({
        ops: [
          { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
          { op: "update", node: "n1", text: "採用を進める", evidence: ["r1"], planStatus: "検討中" },
          { op: "combine", from: "n2", into: "n3" },
          { op: "move", node: "n4", parent: "n5" },
          { op: "delete", node: "n6" },
          { op: "noop", reason: "変化なし" },
          { op: "close", node: "n7" },
        ],
      }),
    ));

  it.effect("evidence を [] に変えた add は decode に失敗する", () =>
    expectDecodeFailure(
      Schema.decodeUnknownEffect(DiffOutput)({
        ops: [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: [] }],
      }),
    ));

  it.effect("evidence を [] に変えた update は decode に失敗する", () =>
    expectDecodeFailure(
      Schema.decodeUnknownEffect(DiffOutput)({
        ops: [{ op: "update", node: "n1", text: "採用を進める", evidence: [] }],
      }),
    ));
});

describe("空の根拠を持つ操作のログ行（FIX-1 / AC1-AC3）", () => {
  it.effect("ops に含まれる空の根拠の add / update と、dropped[].op に含まれる空の根拠の add / update を、それぞれ観測したうえでイベント全体を LogEvent で decode できる", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const update = () =>
        Effect.succeed({
          ops: [
            { op: "add" as const, ref: "t1", parent: "root", kind: "議題" as const, text: "採用", evidence: ["r1"] },
            { op: "add" as const, ref: "t2", parent: "root", kind: "議題" as const, text: "採用", evidence: [] },
            { op: "update" as const, node: "t1", text: "採用を進める", evidence: [] },
          ],
        });
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events))));
      yield* session.push({ id: "r1", track: "相手", start: 0, end: 1, text: "こんにちは" });
      yield* session.flush;

      const diffEvent = events.find((e) => e.type === "diff");
      if (!diffEvent || diffEvent.type !== "diff") {
        assert.fail("diff イベントが記録されていない");
        return;
      }
      assert.isTrue(diffEvent.ops.some((op) => op.op === "add" && op.ref === "t2" && op.evidence.length === 0));
      assert.isTrue(diffEvent.ops.some((op) => op.op === "update" && op.node === "t1" && op.evidence.length === 0));
      assert.strictEqual(diffEvent.dropped.length, 2);
      assert.strictEqual(diffEvent.dropped[0]!.op.op, "add");
      assert.strictEqual(diffEvent.dropped[0]!.reason, "根拠が無い");
      assert.strictEqual(diffEvent.dropped[1]!.op.op, "update");
      assert.strictEqual(diffEvent.dropped[1]!.reason, "根拠が無い");

      yield* expectDecodeSuccess(Schema.decodeUnknownEffect(LogEvent)(diffEvent));
    }));

  it.effect("dropped[0].op から add の必須フィールド（parent）を落とすと decode に失敗する", () =>
    expectDecodeFailure(
      Schema.decodeUnknownEffect(LogEvent)({
        type: "diff",
        input: { recent: [], fresh: ["r1"], nodeCount: 0 },
        ops: [],
        dropped: [{ op: { op: "add", ref: "t2", kind: "議題", text: "採用", evidence: [] }, reason: "根拠が無い" }],
      }),
    ));
});
