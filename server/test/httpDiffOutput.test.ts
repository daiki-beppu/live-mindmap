import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { decodeHttpDiffOutput, HTTP_DIFF_OUTPUT_SCHEMA } from "../src/httpDiffOutput.ts";
import { assertStrictJsonSchema } from "./fixtures/strictJsonSchema.ts";

const update = { op: "update", node: "n1", evidence: ["r1"], text: null, planStatus: null, assignee: null, assigneeSpeaker: null, criteria: null };

describe("HTTP の差分操作の厳密な構造化出力", () => {
  it("すべてのオブジェクトで全属性を必須にし、追加属性を拒否するスキーマを送る", () => {
    assertStrictJsonSchema(HTTP_DIFF_OUTPUT_SCHEMA);
  });

  it.effect.each([null, [], ["採用のしやすさ"]])("更新の null・解除・関係づけを区別して内部操作に戻す（%s）", (criteria) => Effect.gen(function* () {
    const result = yield* decodeHttpDiffOutput(JSON.stringify({ ops: [{ ...update, criteria }], names: null }));
    expect(result).toEqual({ ops: [{ op: "update", node: "n1", evidence: ["r1"], ...(criteria === null ? {} : { criteria }) }] });
  }));

  it.effect("追加の任意属性を省略へ戻し、推定した話者名を保持する", () => Effect.gen(function* () {
    const names = [{ label: "相手 A", name: "田中", evidence: "r1", basis: "名乗り" }];
    const result = yield* decodeHttpDiffOutput(JSON.stringify({ ops: [{ op: "add", ref: "a", parent: "n1", kind: "案", text: "試験導入", evidence: ["r1"], criteria: ["採用のしやすさ"], assignee: null, assigneeSpeaker: null, due: null }], names }));
    expect(result).toEqual({ ops: [{ op: "add", ref: "a", parent: "n1", kind: "案", text: "試験導入", evidence: ["r1"], criteria: ["採用のしやすさ"] }], names });
  }));

  it.effect("null の未知属性と、必須属性の欠落を受け付けない", () => Effect.gen(function* () {
    for (const value of [{ ops: [{ ...update, unknown: null }], names: null }, { ops: [update] }, { ops: [{ op: "update", node: "n1", evidence: ["r1"] }], names: null }]) {
      expect((yield* Effect.result(decodeHttpDiffOutput(JSON.stringify(value))))._tag).toBe("Failure");
    }
  }));
});
