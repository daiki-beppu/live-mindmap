import { Effect, Schema } from "effect";
import { Track } from "./remark.ts";
import { SelfPauseReason, SelfPauseState } from "./selfPause.ts";
import { Word, WordTime } from "./words.ts";

const helperRemarkFields = {
  track: Track,
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
  duplicate: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  words: Schema.optionalKey(Schema.Array(Word)),
  wordTimes: Schema.optionalKey(Schema.Array(WordTime)),
};

// hostTime は 64 bit の値で JSON の number では桁が落ちるため、数字だけの文字列に限る（number は受け付けない）。
export const HelperEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("remark"), ...helperRemarkFields }),
  Schema.Struct({ type: Schema.Literal("partial"), ...helperRemarkFields }),
  Schema.Struct({ type: Schema.Literal("origin"), hostTime: Schema.String.check(Schema.isPattern(/^\d+$/)) }),
  Schema.Struct({ type: Schema.Literal("screen"), start: Schema.Finite, image: Schema.NullOr(Schema.Uint8ArrayFromBase64),
    lines: Schema.optionalKey(Schema.Array(Schema.String)),
    meetingTabTitle: Schema.optionalKey(Schema.String),
    ocrFailed: Schema.optionalKey(Schema.Literal(true)) }),
  Schema.Struct({ type: Schema.Literal("screen-off"), start: Schema.Finite, reason: Schema.Literal("許可なし") }),
  Schema.Struct({ type: Schema.Literal("tap-silent"), start: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("self-pause"), paused: Schema.Literal(true), reason: Schema.Literals(["手動", "自動"]), start: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("self-pause"), paused: Schema.Literal(false), reason: SelfPauseReason, start: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("self-pause-state"), ...SelfPauseState.fields }),
  Schema.Struct({
    type: Schema.Literal("speaker"),
    track: Track,
    start: Schema.Finite,
    end: Schema.Finite,
    slot: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    final: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("file-duration"), duration: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("file-audio-tracks"), count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
  Schema.Struct({ type: Schema.Literal("speaker-off"), start: Schema.Finite, reason: Schema.Literals(["モデルなし", "読み込みに失敗", "途中で停止"]) }),
  Schema.Struct({ type: Schema.Literal("speaker-settled"), track: Track, to: Schema.Finite }),
  // 相手の話者の枠 slot に、別の声が混ざっている（Issue #1024。Sortformer の枠は 4 つまでで、5 人目以降が声の近い人の枠に混ざる）。
  Schema.Struct({ type: Schema.Literal("speaker-mixed"), track: Track, slot: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), start: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("speaker-centroid"), track: Track, slot: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), centroid: Schema.Array(Schema.Finite) }),
]);
export type HelperEvent = typeof HelperEvent["Type"];
export type SpeakerLogEvent = Extract<HelperEvent, { type: "speaker" | "speaker-off" | "speaker-settled" | "speaker-mixed" | "speaker-centroid" }>;

export const HelperPartial = Schema.Struct(helperRemarkFields);
export type HelperPartial = typeof HelperPartial["Type"];

export type DecodedHelperEvent = { kind: "known"; event: HelperEvent } | { kind: "unknown"; type: string };

const KNOWN_TYPES: ReadonlySet<string> = new Set(HelperEvent.members.map((member) => member.fields.type.literal));

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeType = Schema.decodeUnknownEffect(Schema.Struct({ type: Schema.String }));
const decodeEvent = Schema.decodeUnknownEffect(HelperEvent);

export const decodeHelperEvent = Effect.fnUntraced(function* (input: string): Effect.fn.Return<DecodedHelperEvent, Schema.SchemaError> {
  const json = yield* decodeJson(input);
  const { type } = yield* decodeType(json);
  if (!KNOWN_TYPES.has(type)) return { kind: "unknown", type };
  return { kind: "known", event: yield* decodeEvent(json) };
});
