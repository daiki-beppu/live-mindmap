import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import { decodeHelperEvent, LogEvent, makeSession, restoreState } from "../src/core/index.ts";
import { directFeed, makeRemarkFlow } from "../src/remarkFlow.ts";
import { collectLog, forbiddenUpdater } from "./fixtures/sessionLayers.ts";

describe("共有画面の OCR 失敗", () => {
  it.effect("helper の失敗印を decode して inlet から screen ログへ運び、画像を保存する", () => Effect.gen(function* () {
    const decoded = yield* decodeHelperEvent(JSON.stringify({ type: "screen", start: 1, image: "AQID", ocrFailed: true }));
    expect(decoded.kind).toBe("known");
    if (decoded.kind !== "known" || decoded.event.type !== "screen") throw new Error("screen が必要");
    const events: LogEvent[] = [];
    const written: { file: string; bytes: Uint8Array }[] = [];
    const session = yield* makeSession({ title: "OCR" }).pipe(Effect.provide(Layer.merge(collectLog(events, written), forbiddenUpdater)));
    const flow = yield* makeRemarkFlow({
      session, correct: (rest) => Effect.succeed({ rest, original: undefined, wordTimes: undefined, replacements: [] }), speak: () => Effect.void,
      captions: "途中結果から", feed: directFeed,
    });
    yield* flow.screen(decoded.event);
    expect(yield* flow.ocrSummary).toEqual({ failed: 1, images: 1 });
    expect(written).toHaveLength(1);
    expect(written[0]!.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(events.filter((event) => event.type === "screen")).toEqual([
      { type: "screen", start: 1, image: written[0]!.file, ocrFailed: true },
    ]);
  }));

  it.effect("失敗印付きの保存ログを decode・復元しても印を失わない", () => Effect.gen(function* () {
    const screen = { type: "screen", start: 1, image: "0001.0.jpg", ocrFailed: true };
    expect(yield* Schema.decodeUnknownEffect(LogEvent)(screen)).toEqual(screen);
    const restored = yield* restoreState([{ type: "start", title: "OCR" }, screen]);
    expect(restored.remarks).toEqual([]);
  }));

  it.effect.each([{ ocrFailed: false }, { ocrFailed: "true" }, { ocrFailed: null }])("失敗印は省略または true に限る（$ocrFailed）", ({ ocrFailed }) => Effect.gen(function* () {
    const helper = yield* Effect.result(decodeHelperEvent(JSON.stringify({ type: "screen", start: 1, image: "AQID", ocrFailed })));
    const log = yield* Effect.result(Schema.decodeUnknownEffect(LogEvent)({ type: "screen", start: 1, image: "0001.0.jpg", ocrFailed }));
    expect(Result.isFailure(helper)).toBe(true);
    expect(Result.isFailure(log)).toBe(true);
  }));
});
