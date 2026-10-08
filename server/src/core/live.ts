// ヘルパーが WebSocket で流すイベント（helper/README.md「イベントの形」）を decode する。
// Node の実行環境に依存しない（ADR 0003）。
import { Effect, Schema } from "effect";
import { Track } from "./session.ts";

// partial（途中結果）と remark（確定結果）が共通して持つ項目。
// duplicate の項目がないイベントは、重複ではないものとして扱う（helper/README.md「イベントの形」）
const helperRemarkFields = {
  track: Track,
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
  duplicate: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
};

// ヘルパーのイベントの形（helper/README.md「イベントの形」）。decodeHelperEvent が使う。
// hostTime は 64 bit の値で JSON の number では桁が落ちるため、数字だけの文字列に限る（number は受け付けない）。
export const HelperEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("remark"), ...helperRemarkFields }),
  Schema.Struct({ type: Schema.Literal("partial"), ...helperRemarkFields }),
  Schema.Struct({ type: Schema.Literal("origin"), hostTime: Schema.String.check(Schema.isPattern(/^\d+$/)) }),
  // 共有画面の変化。image は JPEG の base64（バイト列に戻す。base64 として不正なら SchemaError）で、ウィンドウが無くなったときは null
  Schema.Struct({ type: Schema.Literal("screen"), start: Schema.Finite, image: Schema.NullOr(Schema.Uint8ArrayFromBase64) }),
  // 共有画面を取り込めない（画面収録の許可が無い・断られた・途中で取れなくなった）。ヘルパーが流す reason は許可なしだけ（指定はサーバーが書く）
  Schema.Struct({ type: Schema.Literal("screen-off"), start: Schema.Finite, reason: Schema.Literal("許可なし") }),
]);
export type HelperEvent = typeof HelperEvent["Type"];

export const HelperPartial = Schema.Struct(helperRemarkFields);
export type HelperPartial = typeof HelperPartial["Type"];

// decodeHelperEvent の結果。知らない type は失敗にせず「知らないイベント」として返し、呼び出し側が読み飛ばす
export type DecodedHelperEvent = { kind: "known"; event: HelperEvent } | { kind: "unknown" };

const KNOWN_TYPES: ReadonlySet<string> = new Set(["remark", "partial", "origin", "screen", "screen-off"]);

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeType = Schema.decodeUnknownEffect(Schema.Struct({ type: Schema.String }));
const decodeEvent = Schema.decodeUnknownEffect(HelperEvent);

// ヘルパーの 1 メッセージ（JSON 文字列）を decode する。
// 不正な JSON・オブジェクトでない入力・type の欄がない入力・知っている type で項目が壊れた入力はタグ付きの失敗（SchemaError）。
// HelperEvent の decode の前に type を見分け、知らない type は失敗にせず読み飛ばせるようにする
export const decodeHelperEvent = Effect.fnUntraced(function* (input: string): Effect.fn.Return<DecodedHelperEvent, Schema.SchemaError> {
  const json = yield* decodeJson(input);
  const { type } = yield* decodeType(json);
  if (!KNOWN_TYPES.has(type)) return { kind: "unknown" };
  return { kind: "known", event: yield* decodeEvent(json) };
});
