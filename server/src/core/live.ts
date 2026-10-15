// ヘルパーが WebSocket で流すイベント（helper/README.md「イベントの形」）を decode する。
// Node の実行環境に依存しない（ADR 0003）。
import { Effect, Schema } from "effect";
import { Track } from "./remark.ts";
import { SelfPauseReason, SelfPauseState } from "./selfPause.ts";
import { Word, WordTime } from "./words.ts";

// partial（途中結果）と remark（確定結果）が共通して持つ項目。
// duplicate の項目がないイベントは、重複ではないものとして扱う（helper/README.md「イベントの形」）
const helperRemarkFields = {
  track: Track,
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
  duplicate: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  // 本文を語に区切ったもの（Issue #639）。無い旧イベントも受け付ける
  words: Schema.optionalKey(Schema.Array(Word)),
  // STT の run ごとの区間（Issue #1019）。無い旧イベントも受け付ける
  wordTimes: Schema.optionalKey(Schema.Array(WordTime)),
};

// ヘルパーのイベントの形（helper/README.md「イベントの形」）。decodeHelperEvent が使う。
// hostTime は 64 bit の値で JSON の number では桁が落ちるため、数字だけの文字列に限る（number は受け付けない）。
export const HelperEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("remark"), ...helperRemarkFields }),
  Schema.Struct({ type: Schema.Literal("partial"), ...helperRemarkFields }),
  Schema.Struct({ type: Schema.Literal("origin"), hostTime: Schema.String.check(Schema.isPattern(/^\d+$/)) }),
  // 共有画面の変化。image は JPEG の base64（バイト列に戻す。base64 として不正なら SchemaError）で、ウィンドウが無くなったときは null
  Schema.Struct({ type: Schema.Literal("screen"), start: Schema.Finite, image: Schema.NullOr(Schema.Uint8ArrayFromBase64),
    // Vision で読んだ文字の行（Issue #643）。無い旧ヘルパーのイベントも受け付ける
    lines: Schema.optionalKey(Schema.Array(Schema.String)) }),
  // 共有画面を取り込めない（画面収録の許可が無い・断られた・途中で取れなくなった）。ヘルパーが流す reason は許可なしだけ（指定はサーバーが書く）
  Schema.Struct({ type: Schema.Literal("screen-off"), start: Schema.Finite, reason: Schema.Literal("許可なし") }),
  // 相手のタップが 10 秒、フレーム数 1 以上のバッファを受け取らなかった。start は origin と同じ原点からの秒
  Schema.Struct({ type: Schema.Literal("tap-silent"), start: Schema.Finite }),
  // 自分の休止の状態が変わった（Issue #1069・#1071）。休止中に理由だけが変わったときも届く。start は origin と同じ原点からの秒。
  // 休止（paused: true）の理由は手動か自動。判定できないのは取っている間だけ
  Schema.Struct({ type: Schema.Literal("self-pause"), paused: Schema.Literal(true), reason: Schema.Literals(["手動", "自動"]), start: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("self-pause"), paused: Schema.Literal(false), reason: SelfPauseReason, start: Schema.Finite }),
  // 自分の休止の規則の状態（Issue #1071）。server は覚えるだけで、helper を起動し直すときに引数で送り直す
  Schema.Struct({ type: Schema.Literal("self-pause-state"), ...SelfPauseState.fields }),
  // 相手のトラックの話者の区間（Issue #1020）。start / end は origin と同じ原点からの秒。slot は Sortformer の出力の番号（0 始まり）。final が false なら仮の区間
  Schema.Struct({
    type: Schema.Literal("speaker"),
    track: Track,
    start: Schema.Finite,
    end: Schema.Finite,
    slot: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    final: Schema.Boolean,
  }),
  // 話者分離を使えない（モデルが無い・読み込みに失敗・途中で停止）。認識は続く。start は origin と同じ原点からの秒
  Schema.Struct({ type: Schema.Literal("speaker-off"), start: Schema.Finite, reason: Schema.Literals(["モデルなし", "読み込みに失敗", "途中で停止"]) }),
]);
export type HelperEvent = typeof HelperEvent["Type"];
// 受け取った値のまま log.jsonl に残す話者分離のイベント（発言・字幕・差分更新には使わない）
export type SpeakerLogEvent = Extract<HelperEvent, { type: "speaker" | "speaker-off" }>;

export const HelperPartial = Schema.Struct(helperRemarkFields);
export type HelperPartial = typeof HelperPartial["Type"];

// decodeHelperEvent の結果。知らない type は失敗にせず「知らないイベント」として返し、呼び出し側が読み飛ばす
export type DecodedHelperEvent = { kind: "known"; event: HelperEvent } | { kind: "unknown" };

const KNOWN_TYPES: ReadonlySet<string> = new Set(HelperEvent.members.map((member) => member.fields.type.literal));

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
