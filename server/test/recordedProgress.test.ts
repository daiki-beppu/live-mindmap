import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { formatRecordedProgress, RecordedEvent, type RecordedProgress } from "../src/core/index.ts";

// Issue #1092: 進み具合の 1 行に、一時停止の理由と次に試す時刻を出す。

const base: RecordedProgress = { type: "progress", position: 750, duration: 3484, rounds: 3 };
const RETRY_AT = Date.UTC(2026, 9, 16, 3, 47);
const localClock = (ms: number) => {
  const date = new Date(ms);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
};

describe("formatRecordedProgress（一時停止）", () => {
  it("一時停止の間は、今までの進み具合に続けて、理由と次に試す時刻を同じ 1 行に出す", () => {
    const line = formatRecordedProgress({ ...base, paused: { reason: "ChatGPT の利用上限", retryAt: RETRY_AT } });
    expect(line.startsWith("12:30 / 58:04  マップの更新 3 回")).toBe(true);
    expect(line).toContain("ChatGPT の利用上限");
    expect(line).toContain(localClock(RETRY_AT));
    expect(line).not.toContain("\n");
  });

  it("理由と時刻が変わると、行も変わる（古い時刻のままにしない）", () => {
    const first = formatRecordedProgress({ ...base, paused: { reason: "ChatGPT の利用上限", retryAt: RETRY_AT } });
    const second = formatRecordedProgress({ ...base, paused: { reason: "Claude の利用上限", retryAt: RETRY_AT + 300_000 } });
    expect(second).toContain("Claude の利用上限");
    expect(second).toContain(localClock(RETRY_AT + 300_000));
    expect(second).not.toContain("ChatGPT");
    expect(second).not.toBe(first);
  });

  it("一時停止でなければ、今までの形のまま（理由は出ない）", () => {
    expect(formatRecordedProgress(base)).toBe("12:30 / 58:04  マップの更新 3 回");
  });
});

describe("RecordedEvent の progress（一時停止）", () => {
  it.effect("paused は省略できる。あるときは理由と次に試す時刻（エポックミリ秒）を持ち、理由の無い値は受け付けない", () => Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(RecordedEvent);
    expect(yield* decode(base)).toEqual(base);
    const withPause = { ...base, paused: { reason: "Claude の利用上限", retryAt: RETRY_AT } };
    expect(yield* decode(withPause)).toEqual(withPause);
    const rejected = yield* Effect.result(decode({ ...base, paused: { reason: "知らない理由", retryAt: RETRY_AT } }));
    expect(rejected._tag).toBe("Failure");
    const missingTime = yield* Effect.result(decode({ ...base, paused: { reason: "Claude の利用上限" } }));
    expect(missingTime._tag).toBe("Failure");
  }));
});
