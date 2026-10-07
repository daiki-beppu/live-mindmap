// Issue #238 段 1: core の型を Schema を正本にして導く。
//
// ここでは、外から来る 4 つのデータ（ヘルパーのイベント・正解ファイル・ログの行・Claude の
// structured_output）それぞれに core の Schema があり（CT-4DATA）、ヘルパーのイベントの Schema が
// 今の規則（hostTime は数字の文字列だけ・duplicate がなければ false）を表す（CT-RULES）ことを、
// 実在するデータの実例・既存フィクスチャで decode して確かめる。
//
// 段 3（Issue #240）で、ヘルパーのイベントの Schema は decodeHelperEvent から production 経路
// （Sessions の読み取りループ）へつながった（order.md:34, 47、CT-DECODE-WIRED）。このテストは
// Schema を直接 decode するだけで、decodeHelperEvent・evaluate.ts の parseTruth・session.ts の
// restoreSession は呼ばない。decodeHelperEvent の型の見分け・タグ付きの失敗の振る舞いは
// server/test/live.test.ts が固定し、parseTruth・restoreSession は eval.test.ts・restore.test.ts
// が引き続き固定する（このファイルでは変更しない）。
//
// 例外は「空の根拠を持つ操作のログ行」の確認（下の describe）だけで、session.ts の makeSession を
// 使って実際に push → flush させ、そこで生成される diff イベントを decode する。根拠の要素数制約を
// Evidence（Claude への出力契約）から外し、ログの保存形式（Op・Dropped・LogEvent）には要求しないという
// FIX-1 の変更を、その生成経路ごと確認するため（restoreSession・live.ts・evaluate.ts は対象外のまま）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import { DiffOutput, HelperEvent, LogEvent, makeSession, Truth } from "../src/core/index.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

// decode の成功を主張し、decode した値を返す。失敗していれば SchemaError の message を示して落ちる
function expectDecodeSuccess<A, R>(effect: Effect.Effect<A, Schema.SchemaError, R>) {
  return Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    if (Result.isFailure(result)) assert.fail(`decode に失敗した: ${result.failure.message}`);
    return result.success;
  });
}

// decode の失敗を主張する。CODING_STANDARDS.md の Negative tests のとおり、使用箇所ごとに
// 壊れた項目だけを直した入力が decode を通ることも併記し、「何もしていないから通る」状態を避ける
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
          if (decoded.type === "origin") {
            assert.fail("origin ではないはず");
            return;
          }
          assert.strictEqual(decoded.duplicate, false);
        }));

      it.effect(`${type}: duplicate: true はそのまま true になる`, () =>
        Effect.gen(function* () {
          const decoded = yield* expectDecodeSuccess(
            Schema.decodeUnknownEffect(HelperEvent)({ type, track: "相手", start: 0, end: 1, text: "あ", duplicate: true }),
          );
          if (decoded.type === "origin") {
            assert.fail("origin ではないはず");
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

    // 上の正例（"9007199254740993"）と対になる負例。壊れているのは hostTime の 1 項目だけ
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

describe("正解ファイル（Truth）（CT-4DATA）", () => {
  const fixture = join(import.meta.dirname, "../bench/meetings/deciding.truth.json");

  it.effect("bench の正解ファイル（deciding.truth.json）を decode できる。keywords の文字列と配列の両方の形を含む", () =>
    Effect.gen(function* () {
      const raw = JSON.parse(readFileSync(fixture, "utf8"));
      const decoded = yield* expectDecodeSuccess(Schema.decodeUnknownEffect(Truth)(raw));
      assert.strictEqual(decoded.決定.length, 2);
      assert.strictEqual(decoded.TODO.length, 3);
      assert.deepStrictEqual(decoded.決定[0]!.keywords, ["A社"]);
      assert.deepStrictEqual(decoded.決定[1]!.keywords[1], ["二月末", "2月末", "二月の末", "2月の末"]);
    }));
});

describe("ログの行（LogEvent）（CT-4DATA）", () => {
  // claude.ts が DiffOutput から作る JSON Schema と同じ 6 操作の構成（add → update → combine → move → delete → noop）
  const diffOps = [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "update", node: "n1", text: "採用を進める", evidence: ["r1"], planStatus: "検討中" },
    { op: "combine", from: "n2", into: "n3" },
    { op: "move", node: "n4", parent: "n5" },
    { op: "delete", node: "n6" },
    { op: "noop", reason: "変化なし" },
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
      title: "diff（失敗）",
      event: { type: "diff", input: { recent: [], fresh: [], nodeCount: 0 }, ops: [], dropped: [], error: "timeout" },
    },
  ];

  for (const { title, event } of examples) {
    it.effect(`${title}は decode できる`, () => expectDecodeSuccess(Schema.decodeUnknownEffect(LogEvent)(event)));

    // cli.ts:102-103 が log.jsonl に書き出す実際の形（{ at, ...event }）。LogEvent にない at キーが
    // 付いても decode できる（K7。余分プロパティの厳格化を足すと、保存済みのログが読めなくなる）
    it.effect(`${title}に at を足した行（cli.ts が書く実際の形）も decode できる`, () =>
      expectDecodeSuccess(
        Schema.decodeUnknownEffect(LogEvent)({ at: "2026-10-06T00:00:00.000Z", ...(event as Record<string, unknown>) }),
      ));
  }
});

describe("Claude の structured_output（DiffOutput）（CT-4DATA）", () => {
  it.effect("claude.test.ts の実例（{ ops: [{ op: noop, reason }] }）を decode できる", () =>
    expectDecodeSuccess(Schema.decodeUnknownEffect(DiffOutput)({ ops: [{ op: "noop", reason: "r" }] })));

  it.effect("JSON Schema（claude.ts が DiffOutput から作る）と同じ 6 操作それぞれ 1 件を decode できる", () =>
    expectDecodeSuccess(
      Schema.decodeUnknownEffect(DiffOutput)({
        ops: [
          { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
          { op: "update", node: "n1", text: "採用を進める", evidence: ["r1"], planStatus: "検討中" },
          { op: "combine", from: "n2", into: "n3" },
          { op: "move", node: "n4", parent: "n5" },
          { op: "delete", node: "n6" },
          { op: "noop", reason: "変化なし" },
        ],
      }),
    ));

  // T2（FIX-1 / AC4）: 既存の正例（evidence: ["r1"]、上の add・update）と対になる負例。
  // evidence だけを [] に変える。Claude への出力契約は その JSON Schema の minItems: 1 と同じ拒否を保つ
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

// FIX-1（architect-review.md ISSUE-LOG-OP-EVIDENCE）: 根拠（evidence）の要素数制約は、所有者の異なる
// 2 つの契約（Claude への出力契約「根拠は 1 件以上」と、ログの保存形式「捨てた操作を元の形のまま残す」）
// に同居していた。制約は DiffOutput（Claude 側）だけに残し、Op・Dropped・LogEvent（ログ側）からは外した。
describe("空の根拠を持つ操作のログ行（FIX-1 / AC1-AC3）", () => {
  // T1（成立例）: makeSession を実際に push → flush させ、生成された diff イベントの
  // ops（R1 の add・R2 の update）と dropped[].op（R3 の add・update）をそれぞれ観測したうえで、
  // イベント全体を LogEvent で decode して成功することを確認する
  it.effect("ops に含まれる空の根拠の add / update と、dropped[].op に含まれる空の根拠の add / update を、それぞれ観測したうえでイベント全体を LogEvent で decode できる", () =>
    Effect.gen(function* () {
      const events: LogEvent[] = [];
      const update = () =>
        Effect.succeed({
          ops: [
            { op: "add" as const, ref: "t1", parent: "root", kind: "議題" as const, text: "採用", evidence: ["r1"] },
            // R1: ops に残る空の根拠の add（「根拠が無い」で却下される）
            { op: "add" as const, ref: "t2", parent: "root", kind: "議題" as const, text: "採用", evidence: [] },
            // R2: ops に残る空の根拠の update（先行の add が登録した仮 ID t1 を対象にする）
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
      // R3: dropped[].op の add（[0]）と update（[1]）を別々に観測する
      assert.strictEqual(diffEvent.dropped.length, 2);
      assert.strictEqual(diffEvent.dropped[0]!.op.op, "add");
      assert.strictEqual(diffEvent.dropped[0]!.reason, "根拠が無い");
      assert.strictEqual(diffEvent.dropped[1]!.op.op, "update");
      assert.strictEqual(diffEvent.dropped[1]!.reason, "根拠が無い");

      yield* expectDecodeSuccess(Schema.decodeUnknownEffect(LogEvent)(diffEvent));
    }));

  // T3（失敗例・反例）: dropped[0].op から構造上必須のフィールド（add の parent）を落とすと、
  // evidence が空でも decode は失敗する。ログ側の op の構造検証（Op の union）を緩めていないことの確認
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
