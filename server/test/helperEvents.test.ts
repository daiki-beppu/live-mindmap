import { assert, describe, it } from "@effect/vitest";
import { Effect, Result, Schema, SchemaAST } from "effect";
import { decodeHelperEvent, HelperEvent } from "../src/core/index.ts";
import helperEventsText from "../../helper/Tests/HelperCoreTests/Fixtures/helper-events.jsonl?raw";

const lines = helperEventsText.replace(/\n$/, "").split("\n");
const decodedExamples = Effect.forEach(lines, (line, index) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(decodeHelperEvent(line));
    if (Result.isFailure(result)) assert.fail(`見本の ${index + 1} 行目を decode できない: ${result.failure.message}`);
    const decoded = result.success;
    if (decoded.kind !== "known") assert.fail(`見本の ${index + 1} 行目が知らないイベントになった`);
    return decoded.event;
  }));

function literalValues(ast: SchemaAST.AST): readonly SchemaAST.LiteralValue[] {
  switch (ast._tag) {
    case "Literal": return [ast.literal];
    case "Union": return ast.types.flatMap(literalValues);
    default: return [];
  }
}

function missingLiteralExamples(events: readonly HelperEvent[]) {
  return HelperEvent.members.flatMap((member, branch) => {
    const examples = events.filter(Schema.is(member));
    return Object.entries(member.fields).flatMap(([field, schema]) =>
      literalValues(schema.ast)
        .filter((value) => !examples.some((event) =>
          Object.entries(event).some(([key, actual]) => key === field && actual === value)))
        .map((value) => ({ branch, type: member.fields.type.literal, field, value })));
  });
}

describe("Swift が出力する helper イベントの見本", () => {
  it.effect("見本の全行を known として decode できる", () => decodedExamples);

  it.effect("server が受け付ける全 type が見本に含まれる", () =>
    Effect.gen(function* () {
      const events = yield* decodedExamples;
      const expectedTypes = new Set(HelperEvent.members.map((member) => member.fields.type.literal));
      assert.deepStrictEqual(new Set(events.map((event) => event.type)), expectedTypes);
    }));

  it.effect("スキーマの各分岐・フィールドの全リテラルが見本に含まれる", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(missingLiteralExamples(yield* decodedExamples), []);
    }));

  it("speaker-off の全理由が対応フィールドにあれば不足しない", () => {
    const member = HelperEvent.members.find((schema) => schema.fields.type.literal === "speaker-off");
    assert.ok(member && "reason" in member.fields);
    const events = literalValues(member.fields.reason.ast).map((reason) =>
      Schema.decodeUnknownSync(HelperEvent)({ type: "speaker-off", start: 0, reason }));
    assert.deepStrictEqual(missingLiteralExamples(events).filter((missing) => missing.type === "speaker-off"), []);
  });

  it("別フィールドにある文字列では speaker-off の不足を補えない", () => {
    const events: HelperEvent[] = [
      { type: "speaker-off", start: 0, reason: "モデルなし" },
      { type: "screen", start: 0, image: null, lines: ["読み込みに失敗", "途中で停止"] },
    ];
    const missing = missingLiteralExamples(events).filter((value) => value.type === "speaker-off");
    assert.deepStrictEqual(missing.map(({ field, value }) => ({ field, value })), [
      { field: "reason", value: "読み込みに失敗" },
      { field: "reason", value: "途中で停止" },
    ]);
  });

  it("休止の理由があっても再開の理由の不足を補えない", () => {
    const events: HelperEvent[] = [
      { type: "self-pause", paused: true, reason: "手動", start: 0 },
      { type: "self-pause", paused: true, reason: "自動", start: 0 },
      { type: "self-pause", paused: false, reason: "判定できない", start: 0 },
    ];
    const missing = missingLiteralExamples(events).filter((value) => value.type === "self-pause");
    assert.deepStrictEqual(missing.map(({ field, value }) => ({ field, value })), [
      { field: "reason", value: "手動" },
      { field: "reason", value: "自動" },
    ]);
  });
});
