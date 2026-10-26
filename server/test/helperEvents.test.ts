import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
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

describe("Swift が出力する helper イベントの見本", () => {
  it.effect("見本の全行を known として decode できる", () => decodedExamples);

  it.effect("server が受け付ける全 type が見本に含まれる", () =>
    Effect.gen(function* () {
      const events = yield* decodedExamples;
      const expectedTypes = new Set(HelperEvent.members.map((member) => member.fields.type.literal));
      assert.deepStrictEqual(new Set(events.map((event) => event.type)), expectedTypes);
    }));
});
