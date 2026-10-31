import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { DiffOperations, DiffOutput, Dropped, Op, PlainDiffOperations } from "../src/core/map.ts";
import { decodeHttpDiffOutput } from "../src/httpDiffOutput.ts";

const add = (kind: string, text: string) => ({ op: "add", ref: "a", parent: "n1", kind, text, evidence: ["r1"] });
const bodies = ["補足", "「補足」", "```\n補足\n```", "~~~\n補足\n~~~", "```\n補足", "~~~\n補足"];

describe.each([
  ["通常の差分", DiffOperations],
  ["判断軸なしの差分", PlainDiffOperations],
  ["updater の出力", DiffOutput],
] as const)("%s の生成種別", (_name, schema) => {
  it.each(bodies)("通常ノードの本文 %j は受け付ける", (text) => {
    const value = { ops: [add("要点", text)] };
    expect(Schema.decodeUnknownSync(schema)(value)).toEqual(value);
  });

  it("本文が通常の説明でも補足の追加を受け付けない", () => {
    expect(() => Schema.decodeUnknownSync(schema)({ ops: [add("補足", "サービス水準の合意")] })).toThrow();
  });

  it("既存の補足を消す操作は受け付ける", () => {
    const value = { ops: [{ op: "delete", node: "n2" }] };
    expect(Schema.decodeUnknownSync(schema)(value)).toEqual(value);
  });
});

describe("HTTP の生成種別", () => {
  const wireAdd = (kind: string, text: string) => ({
    ...add(kind, text), assignee: null, assigneeSpeaker: null, criteria: null, due: null, digression: null,
  });

  it.effect.each(bodies)("通常ノードの本文 %j は null の正規化後も保持する", (text) => Effect.gen(function* () {
    const decoded = yield* decodeHttpDiffOutput(JSON.stringify({ ops: [wireAdd("要点", text)], names: null }));
    expect(decoded).toEqual({ ops: [add("要点", text)] });
  }));

  it.effect("本文が通常の説明でも補足の追加を受け付けない", () => Effect.gen(function* () {
    const result = yield* Effect.result(decodeHttpDiffOutput(JSON.stringify({ ops: [wireAdd("補足", "サービス水準の合意")], names: null })));
    expect(result._tag).toBe("Failure");
  }));
});

it("反映で拒否した補足の操作は、操作ログと dropped に理由つきで残せる", () => {
  const op = add("補足", "サービス水準の合意");
  expect(Schema.decodeUnknownSync(Op)(op)).toEqual(op);
  const dropped = { op, reason: "補足は差分更新では作らない" };
  expect(Schema.decodeUnknownSync(Dropped)(dropped)).toEqual(dropped);
});
