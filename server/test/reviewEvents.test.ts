import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { InvalidLogEvent } from "../src/core/session.ts";
import { embedReviewLog, mapOnlyReviewEvents, prepareReviewEvents } from "../src/core/review.ts";
import { embeddedText, TEMPLATE } from "./fixtures/review.ts";

describe("見返し用ログの準備", () => {
  it.effect("壊れた補足行は、元の位置と読めない項目を持つ型付き失敗になる", () => Effect.gen(function* () {
    const error = yield* Effect.flip(prepareReviewEvents([
      { type: "start", title: "定例" },
      { type: "supplement", op: 42 },
    ]));

    expect(error).toBeInstanceOf(InvalidLogEvent);
    expect(error.index).toBe(1);
    expect(error.reason).toContain("op");
  }));

  it.effect("本文にある出来事らしい文字列は decode せず、未知の出来事とともに保持する", () => Effect.gen(function* () {
    const events = [{ type: "intake", note: '{"type":"supplement","op":42}' }];

    const rows = yield* prepareReviewEvents(events);

    expect(JSON.parse(embeddedText(embedReviewLog(TEMPLATE, rows)))).toEqual(events);
  }));

  it.effect("補足の追加は区分を伏せて種別を付け、本文と出どころを保持する", () => Effect.gen(function* () {
    const event = {
      type: "supplement", category: "用語", term: "用語", ms: 1, reflectedAt: 1,
      op: { op: "add", parent: "root", text: "説明", evidence: ["r1"], origin: "会議の外" },
    };

    const rows = yield* prepareReviewEvents([event]);

    expect(JSON.parse(embeddedText(embedReviewLog(TEMPLATE, rows)))).toEqual([
      { ...event, category: null, op: { ...event.op, kind: "補足" } },
    ]);
  }));
});

describe("マップだけの見返し用ログの失敗", () => {
  it.effect.each([
    { event: { type: "remark" }, field: "remark" },
    { event: { type: "screen", start: "x", image: null, lines: [] }, field: "start" },
  ])("壊れた $event.type 行は、除外前の位置と読めない項目を持つ型付き失敗になる", ({ event, field }) => Effect.gen(function* () {
    const error = yield* Effect.flip(mapOnlyReviewEvents([
      { type: "start", title: "定例" },
      { type: "intake", note: "除外される行" },
      event,
    ]));

    expect(error).toBeInstanceOf(InvalidLogEvent);
    expect(error.index).toBe(2);
    expect(error.reason).toContain(field);
  }));
});
