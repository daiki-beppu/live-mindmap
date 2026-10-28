import { describe, expect, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import type { Effect } from "effect";
import { audioFileNames, type LiveSink, type RecordedSink, type SessionSinks } from "../src/sessionSinks.ts";

it("ライブと録画の入口はそれぞれに必要な操作だけを公開する", () => {
  type Sinks = SessionSinks["Service"];
  expectTypeOf<Effect.Success<ReturnType<Sinks["open"]>>>().toEqualTypeOf<LiveSink>();
  expectTypeOf<Effect.Success<ReturnType<Sinks["openRecorded"]>>>().toEqualTypeOf<RecordedSink>();
  expectTypeOf<Extract<keyof LiveSink, "drainForRestart" | "lastRemarkEnds" | "discardBacklog" | "finishBacklog">>().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof RecordedSink, "interrupted" | "lastRemarkEnds">>().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof LiveSink | keyof RecordedSink, "addUserVocabulary" | "audioFileNames">>().toEqualTypeOf<never>();
  expectTypeOf<Extract<keyof Parameters<Sinks["open"]>[0], "recorded">>().toEqualTypeOf<never>();
  expectTypeOf<Effect.Success<RecordedSink["drainForRestart"]>>().toEqualTypeOf<Partial<Readonly<Record<"相手" | "自分", number>>>>();
  expectTypeOf<RecordedSink["speakersRenumbered"]>().toEqualTypeOf<LiveSink["speakersRenumbered"]>();
  expectTypeOf<RecordedSink["nameSpeaker"]>().toEqualTypeOf<LiveSink["nameSpeaker"]>();
});

describe("audioFileNames", () => {
  it("1 回目の名前（相手.m4a・自分.m4a）は変えず、2 回目以降は -2・-3 の番号が付く", () => {
    expect(audioFileNames(1)).toEqual(["相手.m4a", "自分.m4a"]);
    expect(audioFileNames(2)).toEqual(["相手-2.m4a", "自分-2.m4a"]);
    expect(audioFileNames(3)).toEqual(["相手-3.m4a", "自分-3.m4a"]);
  });
});
